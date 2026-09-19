import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchWithCache } from './offlineCache.js';

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key)
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});

describe('fetchWithCache - cache miss (first load)', () => {
  it('waits on the network and returns the fresh payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [1, 2, 3] })));
    const updates = [];
    const result = await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: (payload, meta) => updates.push({ payload, meta }) });

    expect(result).toEqual({ success: true, data: [1, 2, 3] });
    expect(updates).toEqual([{ payload: { success: true, data: [1, 2, 3] }, meta: { stale: false } }]);
  });

  it('propagates the failure when there is nothing cached to fall back on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(fetchWithCache('/api/y', { cacheKey: 'y' })).rejects.toThrow('network down');
  });

  it('treats a non-ok response as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'bad gateway' }, false, 502)));
    await expect(fetchWithCache('/api/y', { cacheKey: 'y' })).rejects.toThrow('bad gateway');
  });

  it('aborts and rejects if the network never responds within timeoutMs', async () => {
    vi.useFakeTimers();
    const never = deferred();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, { signal } = {}) => {
      // Mirror real fetch: reject if/when the AbortController fires.
      signal?.addEventListener('abort', () => never.reject(new DOMException('aborted', 'AbortError')));
      return never.promise;
    }));

    const pending = fetchWithCache('/api/slow', { cacheKey: 'slow', timeoutMs: 5000 });
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    vi.useRealTimers();
  });
});

describe('fetchWithCache - cache hit', () => {
  it('returns the cached value immediately, without waiting on the network at all', async () => {
    // Seed the cache with a first successful call.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['first'] })));
    await fetchWithCache('/api/x', { cacheKey: 'x' });

    // Second call: network never resolves during this test, proving the
    // returned promise did not wait on it.
    const stuck = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(stuck.promise));

    const updates = [];
    const result = await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: (payload, meta) => updates.push({ payload, meta }) });

    expect(result).toEqual({ success: true, data: ['first'] });
    expect(updates).toEqual([{ payload: { success: true, data: ['first'] }, meta: { stale: true } }]);
  });

  it('still refreshes in the background and reports the fresh value through onUpdate once it lands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['first'] })));
    await fetchWithCache('/api/x', { cacheKey: 'x' });

    const fresh = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(fresh.promise));
    const updates = [];
    const result = await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: (payload, meta) => updates.push({ payload, meta }) });
    expect(result).toEqual({ success: true, data: ['first'] });
    expect(updates).toHaveLength(1); // only the stale one so far - network hasn't resolved yet

    fresh.resolve(jsonResponse({ success: true, data: ['second'] }));
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toEqual({ payload: { success: true, data: ['second'] }, meta: { stale: false } });
  });

  it('a failed background refresh never throws and leaves the stale value as the last word', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['cached'] })));
    await fetchWithCache('/api/x', { cacheKey: 'x' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const updates = [];
    const result = await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: (payload, meta) => updates.push({ payload, meta }) });

    expect(result).toEqual({ success: true, data: ['cached'] });
    // Give the swallowed background rejection a turn to (not) throw.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual([{ payload: { success: true, data: ['cached'] }, meta: { stale: true } }]);
  });

  it('a successful background refresh updates what is cached for the next call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['v1'] })));
    await fetchWithCache('/api/x', { cacheKey: 'x' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['v2'] })));
    await fetchWithCache('/api/x', { cacheKey: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the background refresh's writeCache land

    vi.stubGlobal('fetch', vi.fn().mockReturnValue(deferred().promise));
    const result = await fetchWithCache('/api/x', { cacheKey: 'x' });
    expect(result).toEqual({ success: true, data: ['v2'] });
  });
});

describe('fetchWithCache - cache keying', () => {
  it('keys distinct URLs (or explicit cacheKeys) independently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['a'] })));
    await fetchWithCache('/api/a', { cacheKey: 'a' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(fetchWithCache('/api/b', { cacheKey: 'b' })).rejects.toThrow('down');
  });

  it('defaults the cache key to the url itself when cacheKey is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['by-url'] })));
    await fetchWithCache('/api/by-url');

    const result = await fetchWithCache('/api/by-url', { onUpdate: () => {} });
    expect(result).toEqual({ success: true, data: ['by-url'] });
  });
});
