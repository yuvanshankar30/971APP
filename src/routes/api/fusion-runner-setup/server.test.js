import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key'
} }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ database: true }) }));
vi.mock('$lib/server/fusion_runner_setup.js', () => ({
  startFusionRunnerSetup: mocks.start,
  pollFusionRunnerSetup: mocks.poll,
  FusionRunnerSetupError: class FusionRunnerSetupError extends Error { constructor(message, status) { super(message); this.status = status; } }
}));

import { POST } from './+server.js';

function call(action, body = {}) {
  return POST({
    url: new URL(`https://hub.example/api/fusion-runner-setup?action=${action}`),
    request: new Request('https://hub.example/api/fusion-runner-setup', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }
    })
  });
}

beforeEach(() => {
  mocks.start.mockReset();
  mocks.poll.mockReset();
});

describe('Fusion Runner setup API', () => {
  it('starts a session with a browser URL that omits the poll secret', async () => {
    mocks.start.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', pollSecret: 'private-poll-secret', expiresAt: 'later'
    });
    const response = await call('start', { runnerName: 'router-host' });
    const body = await response.json();
    expect(body.configureUrl).toBe('https://hub.example/install/fusion-runner/setup?session=11111111-1111-4111-8111-111111111111');
    expect(body.configureUrl).not.toContain('private-poll-secret');
    expect(body.pollSecret).toBe('private-poll-secret');
  });

  it('uses 202 while the installer is waiting', async () => {
    mocks.poll.mockResolvedValue({ status: 'pending' });
    const response = await call('poll', { sessionId: 'id', pollSecret: 'secret' });
    expect(response.status).toBe(202);
  });
});
