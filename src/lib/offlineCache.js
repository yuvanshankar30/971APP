// Stale-while-revalidate for GET endpoints whose response only changes
// occasionally at a live event - an event roster, a match schedule. Built
// for competition wifi: present but slow, not fully offline. Every extra
// round trip on a bad link is expensive, and the data underneath these two
// calls in particular barely moves between one scout's page loads and the
// next, so re-fetching it from scratch on every navigation is mostly waste.
//
// Companion to offlineQueue.js, which does the same thing for writes
// (queue-and-retry instead of losing a submission) - this is the read-side
// equivalent (show-and-refresh instead of a blank page or a spinner that
// never resolves).

const STORAGE_PREFIX = 'scouting_cache_v1:';

// No $app/environment browser guard needed here (unlike offlineQueue.js) -
// referencing the bare `localStorage` global during SSR throws a
// ReferenceError, and that's already inside the try/catch below, so it
// degrades the same way a real Storage failure (private browsing, quota)
// already has to. Keeping access this plain, rather than gated on browser,
// is also what makes this testable under vitest's default (non-jsdom) node
// environment via vi.stubGlobal('localStorage', ...).
function readCache(key) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({ value, cachedAt: Date.now() }));
  } catch {
    // localStorage can throw (private browsing, quota, or SSR where the
    // global doesn't exist at all) - caching is a nice-to-have, never
    // worth losing the page over.
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches `url` as JSON with a cache-then-network strategy.
 *
 * The whole point is that a cache hit must never make the caller wait on
 * the network - a "slow but alive" competition connection (the common
 * case; see the module docstring) is exactly the scenario a naive
 * await-fetch-then-fall-back-to-cache design fails to help with, because
 * the caller still blocks on that slow request every time before ever
 * seeing the cached value. So:
 *
 *   - Cache hit: `onUpdate(cached, { stale: true })` fires synchronously
 *     and the cached value is returned immediately, before the network is
 *     even touched. A background refresh is then kicked off separately -
 *     if it succeeds, `onUpdate(fresh, { stale: false })` fires whenever it
 *     lands (which the caller must be able to act on later, since the
 *     function has already returned by then); if it fails, it's swallowed
 *     entirely and the stale value simply stays showing. Either way the
 *     returned promise resolves immediately - it does not wait on this
 *     background refresh.
 *   - Cache miss: there's nothing to show yet, so this does wait on the
 *     network (bounded by `timeoutMs`, default 15s - generous for a
 *     slow-but-working link, but bounded so a truly dead connection still
 *     fails instead of hanging forever). `onUpdate(fresh, { stale: false })`
 *     fires once, and the fresh payload is returned. A failure here
 *     propagates normally, since there is no cache to fall back to.
 */
export function fetchWithCache(url, { cacheKey, onUpdate, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = cacheKey || url;
  const cached = readCache(key);

  if (cached) {
    if (onUpdate) onUpdate(cached.value, { stale: true });
    fetchJsonWithTimeout(url, timeoutMs)
      .then((payload) => {
        writeCache(key, payload);
        if (onUpdate) onUpdate(payload, { stale: false });
      })
      .catch(() => {
        // Background refresh failed - the stale value already shown (and
        // already returned to the caller below) stays as-is.
      });
    return Promise.resolve(cached.value);
  }

  return fetchJsonWithTimeout(url, timeoutMs).then((payload) => {
    writeCache(key, payload);
    if (onUpdate) onUpdate(payload, { stale: false });
    return payload;
  });
}
