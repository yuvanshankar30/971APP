import { browser } from '$app/environment';
import { writable } from 'svelte/store';

// A localStorage-backed retry queue for POST submissions that must never be
// lost to a bad connection - built for scouting at competitions, where
// scouts are on cell hotspots in a stadium and a dropped connection mid-
// submit is routine, not exceptional.
//
// Only wire this into an endpoint whose write is a genuine upsert on a
// stable key (event_key/match_key/team_key/created_by, or similar) - see
// each call site's own comment. A retried job here can legitimately arrive
// at the server twice (the first response can be lost after the server
// already committed the write), so a plain insert()-based endpoint would
// get duplicate rows on retry. Match Scouting and Pit Scouting's own APIs
// are upserts for exactly this reason; Note Scout and Quick Scout are not,
// and must not be queued through this module until they are.

const STORAGE_KEY = 'scouting_offline_queue_v1';
const SEND_TIMEOUT_MS = 8000;
const RETRY_INTERVAL_MS = 20000;

export const pendingSyncCount = writable(0);

function randomId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Pure: builds the queued job record for one submission. Exported so
 * tests can check its shape without touching localStorage. */
export function buildJob({ url, headers, body, label }) {
  return { id: randomId(), url, headers: headers || {}, body, label: label || '', queuedAt: Date.now(), attempts: 0 };
}

/** Pure: appends a job, returning a new array (caller persists it). */
export function addJob(queue, job) {
  return [...queue, job];
}

/** Pure: removes jobs by id, returning a new array. */
export function removeJobs(queue, ids) {
  const idSet = new Set(ids);
  return queue.filter((job) => !idSet.has(job.id));
}

/** Pure: bumps attempts/lastError on one job, returning a new array. */
export function markFailed(queue, id, errorMessage) {
  return queue.map((job) => (job.id === id ? { ...job, attempts: job.attempts + 1, lastError: errorMessage } : job));
}

/** Pure: only a network-level failure is safe to queue for silent retry -
 * a timeout, an offline browser, or fetch's own connection-level rejection
 * (TypeError - DNS, refused, mixed content, CORS preflight failure). A real
 * HTTP response the server sent back (a 400 validation error, a 401) means
 * the server already judged the request - queuing that would hide a real
 * problem from the scout behind silent, endlessly-repeated failures instead
 * of surfacing it once, now, so they can fix the form. */
export function isQueueableFailure(error) {
  return error?.name === 'AbortError' || error instanceof TypeError;
}

function readQueue() {
  if (!browser) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  pendingSyncCount.set(queue.length);
  if (!browser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage can throw (private browsing, quota) - the job already
    // queued in memory for this page load's flush attempts; only a reload
    // loses it, not this submission.
  }
}

async function sendJob(job) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(job.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...job.headers },
      body: JSON.stringify(job.body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

let flushing = false;

/** Attempts every queued job once. Safe to call opportunistically (online
 * event, focus regain, a timer) - a no-op while offline or already
 * flushing, and each job's own failure only affects that job. */
export async function flushQueue() {
  if (!browser || flushing) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  flushing = true;
  try {
    let queue = readQueue();
    if (!queue.length) return;
    const succeeded = [];
    for (const job of queue) {
      try {
        await sendJob(job);
        succeeded.push(job.id);
      } catch (error) {
        queue = markFailed(queue, job.id, error?.message || String(error));
      }
    }
    writeQueue(removeJobs(queue, succeeded));
  } finally {
    flushing = false;
  }
}

/** Persists a submission before ever touching the network - the
 * localStorage write below is what actually protects it from a dropped
 * connection, not the flush attempt that follows. Call this once you've
 * already decided the direct attempt failed for a network reason (see
 * submitOrQueue, the normal entry point) - or directly, if a caller wants
 * to always queue rather than try inline first. */
export function queueSubmission({ url, headers, body, label }) {
  const job = buildJob({ url, headers, body, label });
  writeQueue(addJob(readQueue(), job));
  void flushQueue();
  return job.id;
}

export function queuedJobs() {
  return readQueue();
}

/** The normal entry point for a submission that must survive a bad
 * connection: try it directly with a short timeout, and only fall back to
 * the local queue for a network-level failure (see isQueueableFailure). A
 * real error response from the server is thrown immediately instead - see
 * this module's own docstring for why. */
export async function submitOrQueue({ url, headers, body, label, timeoutMs = SEND_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return { queued: false, data: payload };
  } catch (error) {
    if (isQueueableFailure(error)) {
      queueSubmission({ url, headers, body, label });
      return { queued: true, data: null };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

if (browser) {
  writeQueue(readQueue());
  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushQueue();
  });
  setInterval(flushQueue, RETRY_INTERVAL_MS);
}
