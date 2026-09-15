import { describe, it, expect, vi, beforeEach } from 'vitest';

// The two paths that write real scouting data: release-run (into
// scout_data_events) and update-track's cascade (which decides what
// release-run will later see as attributed). Both need to assert on the rows
// actually written, which the shared mock in server.test.js doesn't capture.
const written = { scout_data_events: [], vision_observations: [], vision_release_log: [] };
let updates = [];
let rpcCalls = [];
let releasedRuns = new Set();

function makeMockClient({ tracks = [], observations = [], run = null, user = { id: 'user-1' } } = {}) {
  function makeChain(table) {
    let filters = {};
    const chain = {
      select: () => chain,
      eq: (column, value) => { filters[column] = value; return chain; },
      neq: () => chain,
      order: () => chain,
      limit: () => chain,
      in: () => chain,
      update: (payload) => { updates.push({ table, payload, filters }); return chain; },
      insert: (rows) => {
        if (written[table]) written[table].push(...(Array.isArray(rows) ? rows : [rows]));
        return chain;
      },
      upsert: () => chain,
      delete: () => chain,
      single: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (onFulfilled, onRejected) => Promise.resolve(resolve()).then(onFulfilled, onRejected)
    };
    function resolve() {
      if (table === 'vision_runs') return { data: run, error: null };
      if (table === 'vision_tracks') return { data: tracks, error: null };
      if (table === 'vision_observations') return { data: observations, error: null };
      if (table === 'user_profiles') return { data: { id: 'user-1', permissions: ['VISION_RELEASE'], role: 'admin' }, error: null };
      if (table === 'scout_data_events') return { data: written.scout_data_events.map((_, i) => ({ id: `evt-${i}` })), error: null };
      return { data: [], error: null };
    }
    return chain;
  }
  return {
    from: (table) => makeChain(table),
    // release_vision_run does the claim, the scout_data_events insert and the
    // audit entry in one transaction (see 20260829_vision_release_atomic.sql).
    // Stand in for it by recording the rows and honouring the same
    // already-released compare-and-swap the real function performs.
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name !== 'release_vision_run') return { data: null, error: null };
      if (releasedRuns.has(args.p_run_id)) return { data: { ok: false, reason: 'already_released' }, error: null };
      releasedRuns.add(args.p_run_id);
      written.scout_data_events.push(...args.p_rows);
      return { data: { ok: true, released_count: args.p_rows.length }, error: null };
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
    auth: { getUser: async () => ({ data: { user } }) }
  };
}

let mockClient;
let mockDb;
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => mockClient) }));
vi.mock('$lib/server/971bot.js', () => ({ getSupabase: vi.fn(() => mockDb) }));

function request(body) {
  return {
    headers: { get: (name) => (name.toLowerCase() === 'authorization' ? 'Bearer token' : null) },
    json: async () => body
  };
}

const RUN = { id: 'run-1', status: 'complete', vision_match_id: 'match-1', released_at: null, vision_matches: { match_key: '2026casj_qm1' } };

const observation = (overrides = {}) => ({
  id: 'obs-1', team_key: 'frc971', alliance: 'red', observation_type: 'fuel_scored',
  value: { count: 1 }, started_ms: 1000, ended_ms: 1000, confidence: 0.9,
  review_status: 'accepted', view_id: 'view-1', ...overrides
});

describe('release-run', () => {
  beforeEach(() => {
    written.scout_data_events = [];
    written.vision_observations = [];
    written.vision_release_log = [];
    updates = [];
    rpcCalls = [];
    releasedRuns = new Set();
  });

  it('releases an accepted, attributed fuel observation as a hub_fuel_override', async () => {
    const client = makeMockClient({ run: RUN, observations: [observation(), observation({ id: 'obs-2', started_ms: 9000, ended_ms: 9000 })] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'release-run', run_id: 'run-1' }) });
    expect(res.status).toBe(200);
    // role/created_by/created_at are stamped inside release_vision_run(), by
    // the same transaction that claims the release, so they are deliberately
    // not part of what the route passes down.
    const fuel = written.scout_data_events.find((row) => row.event_type === 'hub_fuel_override');
    expect(fuel).toEqual({
      match_key: '2026casj_qm1', team_key: 'frc971',
      event_type: 'hub_fuel_override', event_value: '2'
    });
  });

  it('previews exact rows without calling the release transaction', async () => {
    const client = makeMockClient({ run: RUN, observations: [observation()] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'preview-release', run_id: 'run-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.rows).toEqual([{
      match_key: '2026casj_qm1', team_key: 'frc971', event_type: 'hub_fuel_override', event_value: '1'
    }]);
    expect(rpcCalls).toHaveLength(0);
    expect(written.scout_data_events).toHaveLength(0);
  });

  it('refuses a stale client preview when reviewed rows changed', async () => {
    const client = makeMockClient({ run: RUN, observations: [observation()] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({
      action: 'release-run', run_id: 'run-1',
      preview_rows: [{ match_key: '2026casj_qm1', team_key: 'frc971', event_type: 'hub_fuel_override', event_value: '99' }]
    }) });
    expect(res.status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('counts one scored piece once when two cameras both saw it', async () => {
    // fuseObservations collapses same type/team/alliance within 350ms, so two
    // views of a single shot must not release as two scored pieces.
    const client = makeMockClient({
      run: RUN,
      observations: [
        observation({ id: 'left', view_id: 'view-1', started_ms: 1000 }),
        observation({ id: 'right', view_id: 'view-2', started_ms: 1120 })
      ]
    });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    await POST({ request: request({ action: 'release-run', run_id: 'run-1' }) });
    expect(written.scout_data_events.find((row) => row.event_type === 'hub_fuel_override'))
      .toMatchObject({ event_value: '1' });
  });

  it('ignores unreviewed and rejected observations', async () => {
    const client = makeMockClient({
      run: RUN,
      observations: [
        observation({ id: 'a', review_status: 'unreviewed' }),
        observation({ id: 'b', review_status: 'rejected' }),
        observation({ id: 'c', review_status: 'unobservable' })
      ]
    });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'release-run', run_id: 'run-1' }) });
    expect(res.status).toBe(400);
    expect(written.scout_data_events).toHaveLength(0);
  });

  it('never releases an alliance-only observation as a specific team', async () => {
    const client = makeMockClient({ run: RUN, observations: [observation({ team_key: null })] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'release-run', run_id: 'run-1' }) });
    expect(res.status).toBe(400);
    expect(written.scout_data_events).toHaveLength(0);
  });

  it('releases a climb whose level is a real climb_pos value', async () => {
    const client = makeMockClient({
      run: RUN,
      observations: [observation({ observation_type: 'climb_success', started_ms: 120000, ended_ms: 120000, value: { level: 'L2' } })]
    });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    await POST({ request: request({ action: 'release-run', run_id: 'run-1' }) });
    expect(written.scout_data_events).toContainEqual(
      expect.objectContaining({ event_type: 'climb_pos', event_value: 'L2', team_key: 'frc971' })
    );
  });

  it('refuses an unrecognized climb level and names it rather than dropping it silently', async () => {
    const client = makeMockClient({
      run: RUN,
      // 'success' is what summarizeVision falls back to when no level was set,
      // and is exactly the value that used to vanish without a word.
      observations: [observation({ observation_type: 'climb_success', started_ms: 120000, ended_ms: 120000, value: {} })]
    });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'release-run', run_id: 'run-1' }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.skipped_climbs).toEqual([{ team_key: 'frc971', value: 'success' }]);
    expect(body.error).toContain('L1');
  });

  it('refuses to release the same run twice', async () => {
    const client = makeMockClient({ run: { ...RUN, released_at: '2026-08-29T00:00:00Z' }, observations: [observation()] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'release-run', run_id: 'run-1' }) });
    expect(res.status).toBe(409);
    expect(written.scout_data_events).toHaveLength(0);
  });
});

describe('update-track cascade', () => {
  beforeEach(() => { updates = []; });

  it('pushes a newly assigned team down to that track\'s unreviewed observations', async () => {
    const client = makeMockClient({ tracks: [{ id: 'track-1' }] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    await POST({ request: request({ action: 'update-track', id: 'track-1', team_key: 'frc971' }) });
    const cascade = updates.find((entry) => entry.table === 'vision_observations');
    expect(cascade.payload).toEqual({ team_key: 'frc971' });
    expect(cascade.filters).toMatchObject({ track_id: 'track-1', review_status: 'unreviewed' });
  });

  it('clears the team on the track and its observations when identity is removed', async () => {
    const client = makeMockClient({ tracks: [{ id: 'track-1' }] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    await POST({ request: request({ action: 'update-track', id: 'track-1', team_key: '' }) });
    expect(updates.find((entry) => entry.table === 'vision_tracks').payload)
      .toMatchObject({ team_key: null, needs_review: true });
    expect(updates.find((entry) => entry.table === 'vision_observations').payload)
      .toEqual({ team_key: null });
  });
});

describe('run cancel and retry', () => {
  beforeEach(() => { updates = []; });

  it('cancels a run that is still queued, claimed or processing', async () => {
    const client = makeMockClient({ run: [{ id: 'run-1', status: 'cancelled' }] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'cancel-run', id: 'run-1' }) });
    expect(res.status).toBe(200);
    const update = updates.find((entry) => entry.table === 'vision_runs');
    expect(update.payload).toMatchObject({ status: 'cancelled' });
  });

  it('refuses to cancel a run that already finished', async () => {
    // The compare-and-swap matches no row, which is how a just-completed run
    // avoids being stomped back to cancelled.
    const client = makeMockClient({ run: [] });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'cancel-run', id: 'run-1' }) });
    expect(res.status).toBe(409);
  });

  it('requires a run id to cancel', async () => {
    const client = makeMockClient({});
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    expect((await POST({ request: request({ action: 'cancel-run' }) })).status).toBe(400);
  });

  it('only retries a failed or cancelled run', async () => {
    const client = makeMockClient({ run: { ...RUN, status: 'complete' } });
    mockClient = client;
    mockDb = client;
    const { POST } = await import('./+server.js');
    const res = await POST({ request: request({ action: 'retry-run', id: 'run-1' }) });
    expect(res.status).toBe(400);
  });
});
