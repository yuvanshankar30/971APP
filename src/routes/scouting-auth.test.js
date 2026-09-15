import { beforeEach, describe, expect, it, vi } from 'vitest';

let authUser = null;
let insertedRows = [];

function makeChain() {
  const result = Promise.resolve({ data: { id: 'saved-row' }, error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    in: () => chain,
    range: () => chain,
    insert: (rows) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return chain;
    },
    upsert: () => chain,
    update: () => chain,
    delete: () => chain,
    single: () => result,
    maybeSingle: () => result,
    then: (resolve, reject) => result.then(resolve, reject)
  };
  return chain;
}

const authClient = {
  auth: {
    getUser: async () => ({ data: { user: authUser } })
  },
  from: () => makeChain()
};

const serviceClient = { from: () => makeChain() };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => authClient)
}));

vi.mock('$lib/server/971bot.js', () => ({
  getSupabase: vi.fn(() => serviceClient)
}));

vi.mock('$lib/server/slack_notifications.js', () => ({
  notifyScoutAssignment: vi.fn(),
  notifyPitAssignment: vi.fn(),
  notifyPrescoutAssignment: vi.fn()
}));

function request(body = {}) {
  return {
    headers: { get: () => null },
    json: async () => body
  };
}

const localUrl = (path) => new URL(`http://localhost${path}`);

describe('scouting route authentication', () => {
  beforeEach(() => {
    authUser = null;
    insertedRows = [];
  });

  it.each([
    ['data events', () => import('./datascout/+server.js'), { action: 'record-event' }],
    ['notes', () => import('./notescout/+server.js'), { action: 'save-note' }],
    ['pit entries', () => import('./pitscout/+server.js'), { action: 'save-entry' }],
    ['pick-list changes', () => import('./api/scouting-picklist/+server.js'), { action: 'add' }],
    ['match assignments', () => import('./api/scout-assignments/+server.js'), { action: 'bulk-assign', scouting_type: 'data' }],
    ['pit assignments', () => import('./api/pit-scout-assignments/+server.js'), { action: 'bulk-assign', event_key: '2026test' }],
    ['pre-scout assignments', () => import('./api/prescout-assignments/+server.js'), { action: 'bulk-assign', event_key: '2026test' }]
  ])('rejects unauthenticated localhost writes for %s', async (_name, loadRoute, body) => {
    const { POST } = await loadRoute();
    const response = await POST({ request: request(body), url: localUrl('/') });
    expect(response.status).toBe(401);
    expect(insertedRows).toEqual([]);
  });

  it('rejects unauthenticated localhost data-event deletion', async () => {
    const { DELETE } = await import('./datascout/+server.js');
    const response = await DELETE({ request: request({ id: 'event-1' }), url: localUrl('/datascout') });
    expect(response.status).toBe(401);
  });

  it.each([
    ['match assignments', () => import('./api/scout-assignments/+server.js'), '/api/scout-assignments?scouting_type=data'],
    ['pit assignments', () => import('./api/pit-scout-assignments/+server.js'), '/api/pit-scout-assignments?event_key=2026test'],
    ['pre-scout assignments', () => import('./api/prescout-assignments/+server.js'), '/api/prescout-assignments?event_key=2026test']
  ])('rejects unauthenticated localhost assignment reads for %s', async (_name, loadRoute, path) => {
    const { GET } = await loadRoute();
    const response = await GET({ request: request(), url: localUrl(path) });
    expect(response.status).toBe(401);
  });

  it('attributes data events to the authenticated user, not a spoofed body user', async () => {
    authUser = { id: 'verified-user' };
    const { POST } = await import('./datascout/+server.js');
    const response = await POST({
      request: request({
        action: 'record-event',
        match_key: '2026test_qm1',
        team_key: 'frc971',
        event_type: 'quick_score',
        user_id: 'spoofed-user'
      }),
      url: localUrl('/datascout')
    });

    expect(response.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].created_by).toBe('verified-user');
  });
});
