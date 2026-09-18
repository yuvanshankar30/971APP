import { describe, expect, it, vi } from 'vitest';
import {
  authorizeFusionRunnerSetup,
  pollFusionRunnerSetup,
  startFusionRunnerSetup,
  FusionRunnerSetupError
} from './fusion_runner_setup.js';

function chain(result) {
  const query = {};
  for (const method of ['select', 'insert', 'update', 'eq', 'ilike', 'is', 'gt']) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn(async () => result);
  query.maybeSingle = vi.fn(async () => result);
  query.then = (resolve) => resolve(result);
  return query;
}

const activeSession = {
  id: '11111111-1111-4111-8111-111111111111',
  runner_name: 'router-host',
  poll_secret: 'poll-secret',
  expires_at: '2999-01-01T00:00:00.000Z',
  completed_at: null,
  consumed_at: null,
  machine_id: null
};

describe('Fusion Runner browser setup', () => {
  it('creates a short-lived session with a high-entropy poll secret', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const supabase = { from: vi.fn(() => ({ insert })) };
    const result = await startFusionRunnerSetup(supabase, 'router-host');
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pollSecret.length).toBeGreaterThan(40);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ runner_name: 'router-host' }));
  });

  it('rejects a bad team token before touching the database', async () => {
    const supabase = { from: vi.fn() };
    await expect(authorizeFusionRunnerSetup(
      supabase, { FUSION_RUNNER_TOKEN: 'team-secret' }, activeSession.id, 'wrong'
    )).rejects.toMatchObject({ status: 401 });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('authorizes machine registration and token minting in one transaction', async () => {
    const supabase = {
      from: vi.fn(() => chain({ data: activeSession, error: null })),
      rpc: vi.fn(async () => ({ data: [{ machine_id: 'machine-id' }], error: null }))
    };
    const result = await authorizeFusionRunnerSetup(
      supabase, { FUSION_RUNNER_TOKEN: 'team-secret' }, activeSession.id, 'team-secret'
    );
    expect(result).toEqual({ machineId: 'machine-id', alreadyCompleted: false });
    expect(supabase.rpc).toHaveBeenCalledWith('authorize_fusion_runner_setup_session', {
      requested_session_id: activeSession.id,
      issued_token: expect.stringMatching(/^frt_/)
    });
  });

  it('returns pending without consuming and atomically consumes completion', async () => {
    const pendingSupabase = { from: vi.fn(() => chain({ data: activeSession, error: null })), rpc: vi.fn() };
    await expect(pollFusionRunnerSetup(pendingSupabase, activeSession.id, 'poll-secret'))
      .resolves.toEqual({ status: 'pending' });
    expect(pendingSupabase.rpc).not.toHaveBeenCalled();

    const complete = { ...activeSession, completed_at: '2026-09-10T12:00:00.000Z', machine_id: 'machine-id' };
    const completeSupabase = {
      // A completed poll also looks up every already-enabled real machine
      // (see pollFusionRunnerSetup's own comment) so a fresh install can
      // claim real CAM work immediately - table-routed since this query
      // and the session lookup above it both go through the same
      // supabase.from() mock.
      from: vi.fn((table) => table === 'cam_machines'
        ? { select: () => ({ eq: async () => ({ data: [{ id: 'machine-id' }, { id: 'other-machine-id' }], error: null }) }) }
        : chain({ data: complete, error: null })),
      rpc: vi.fn(async () => ({ data: [{ runner_name: 'router-host', machine_id: 'machine-id', token: 'frt_machine' }], error: null }))
    };
    await expect(pollFusionRunnerSetup(completeSupabase, activeSession.id, 'poll-secret')).resolves.toEqual({
      status: 'complete', runnerName: 'router-host', machineId: 'machine-id',
      machineIds: ['machine-id', 'other-machine-id'], token: 'frt_machine'
    });
  });

  it('never lets a caller poll with only the browser session id', async () => {
    const supabase = { from: vi.fn(() => chain({ data: activeSession, error: null })), rpc: vi.fn() };
    await expect(pollFusionRunnerSetup(supabase, activeSession.id, 'wrong'))
      .rejects.toBeInstanceOf(FusionRunnerSetupError);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
