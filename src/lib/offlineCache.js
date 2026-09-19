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

/**
 * Fetches `url` as JSON with a cache-then-network strategy.
 *
 * `onUpdate(payload, { stale })` is called once immediately with the last
 * cached payload if one exists (stale: true), then again with the fresh
 * payload once the network request lands (stale: false). If the network
 * request fails and a cached value was already shown, the stale value is
 * left on screen (onUpdate is not called again with an error) and the
 * cached value is returned - a dropped connection degrades to "showing
 * what we had a minute ago", not a blank section or a stuck spinner. If
 * there was no cached value to fall back on, the fetch failure propagates
 * normally so the caller's existing error handling still runs.
 *
 * Returns the fresh payload on success, or the stale cached payload on a
 * failure that had one to fall back to.
 */
export async function fetchWithCache(url, { cacheKey, onUpdate } = {}) {
  const key = cacheKey || url;
  const cached = readCache(key);
  if (cached && onUpdate) onUpdate(cached.value, { stale: true });

  try {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    writeCache(key, payload);
    if (onUpdate) onUpdate(payload, { stale: false });
    return payload;
  } catch (error) {
    if (cached) return cached.value;
    throw error;
  }
}
