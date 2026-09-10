import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  FUSION_RUNNER_TOKEN: 'team-secret'
} }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('$lib/server/fusion_runner_setup.js', () => ({
  authorizeFusionRunnerSetup: mocks.authorize,
  FusionRunnerSetupError: class FusionRunnerSetupError extends Error { constructor(message, status) { super(message); this.status = status; } }
}));

import { GET, POST } from './+server.js';

beforeEach(() => mocks.authorize.mockReset().mockResolvedValue({}));

describe('Fusion Runner pairing page', () => {
  it('is a standalone one-field page', async () => {
    const response = GET({ url: new URL('https://hub.example/install/fusion-runner/setup?session=session-id') });
    const html = await response.text();
    expect(html).toContain('Enter the Fusion Runner token.');
    expect(html.match(/<input/g)).toHaveLength(2);
    expect(html.match(/<input name="token" type="password"/g)).toHaveLength(1);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('navigation');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('submits the token without putting it in the URL', async () => {
    const form = new FormData();
    form.set('session', '11111111-1111-4111-8111-111111111111');
    form.set('token', 'team-secret');
    const response = await POST({ request: new Request('https://hub.example/install/fusion-runner/setup', { method: 'POST', body: form }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Runner configured. You can close this page.');
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), expect.anything(), form.get('session'), 'team-secret');
  });
});
