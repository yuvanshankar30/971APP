import { beforeEach, describe, expect, it, vi } from 'vitest';

const processNotifications = vi.fn(async () => ({ checked: 1, completed: 1 }));
vi.mock('$lib/server/edit_preview.js', () => ({ processEditPreviewNotifications: (...args) => processNotifications(...args) }));
vi.mock('$lib/server/971bot.js', () => ({ getSlackClient: () => ({}), getSupabase: () => ({}) }));

let mockEnv = {};
vi.mock('$env/dynamic/private', () => ({ get env() { return mockEnv; } }));

const request = (token) => ({ headers: { get: (name) => (name === 'authorization' && token ? `Bearer ${token}` : null) } });
const url = (query = '') => new URL(`http://localhost/api/notifications/edit-preview${query}`);

describe('api/notifications/edit-preview', () => {
  beforeEach(() => { mockEnv = {}; processNotifications.mockClear(); });

  it('fails closed until a cron token is configured', async () => {
    const { POST } = await import('./+server.js');
    expect((await POST({ url: url(), request: request() })).status).toBe(503);
  });

  it('requires the configured cron token', async () => {
    mockEnv = { CRON_NOTIFICATION_TOKEN: 'right' };
    const { POST } = await import('./+server.js');
    expect((await POST({ url: url(), request: request('wrong') })).status).toBe(401);
    expect((await POST({ url: url(), request: request('right') })).status).toBe(200);
    expect(processNotifications).toHaveBeenCalledOnce();
  });
});
