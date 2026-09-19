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

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});

describe('fetchWithCache', () => {
  it('calls onUpdate with the fresh payload and nothing cached on a first, successful fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: [1, 2, 3] }) }));
    const updates = [];
    const result = await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: (payload, meta) => updates.push({ payload, meta }) });

    expect(result).toEqual({ success: true, data: [1, 2, 3] });
    expect(updates).toHaveLength(1);
    expect(updates[0].meta.stale).toBe(false);
  });

  it('serves the cached value immediately (stale: true), then the fresh value (stale: false)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: ['first'] }) }));
    await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: () => {} });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: ['second'] }) }));
    const updates = [];
    await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: (payload, meta) => updates.push({ payload, meta }) });

    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ payload: { success: true, data: ['first'] }, meta: { stale: true } });
    expect(updates[1]).toEqual({ payload: { success: true, data: ['second'] }, meta: { stale: false } });
  });

  it('falls back to the cached value and does not call onUpdate a second time when the network fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: ['cached'] }) }));
    await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: () => {} });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const updates = [];
    const result = await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: (payload, meta) => updates.push({ payload, meta }) });

    expect(result).toEqual({ success: true, data: ['cached'] });
    expect(updates).toHaveLength(1);
    expect(updates[0].meta.stale).toBe(true);
  });

  it('propagates the failure when there is nothing cached to fall back on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(fetchWithCache('/api/y', { cacheKey: 'y', onUpdate: () => {} })).rejects.toThrow('network down');
  });

  it('treats a non-ok response as a failure and falls back to cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: ['cached'] }) }));
    await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: () => {} });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'bad gateway' }) }));
    const result = await fetchWithCache('/api/x', { cacheKey: 'x', onUpdate: () => {} });
    expect(result).toEqual({ success: true, data: ['cached'] });
  });

  it('keys distinct URLs (or explicit cacheKeys) independently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: ['a'] }) }));
    await fetchWithCache('/api/a', { cacheKey: 'a', onUpdate: () => {} });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(fetchWithCache('/api/b', { cacheKey: 'b', onUpdate: () => {} })).rejects.toThrow('down');
  });
});
