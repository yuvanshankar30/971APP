import { beforeEach, describe, expect, it, vi } from 'vitest';

let actorId;
let assignmentOwner;
let updates;

function queryFor(table) {
  let mode = 'select';
  const query = {
    select: () => query,
    eq: () => query,
    update: (value) => { mode = 'update'; updates.push(value); return query; },
    single: async () => {
      if (table === 'user_profiles') return { data: { id: actorId, role: 'member', permissions: [] }, error: null };
      if (table === 'scout_match_assignments') return { data: { assigned_user: assignmentOwner }, error: null };
      return { data: null, error: null };
    },
    then: (resolve) => Promise.resolve(
      table === 'roster_entries' ? { data: [], error: null }
        : mode === 'update' ? { data: null, error: null }
          : { data: [], error: null }
    ).then(resolve)
  };
  return query;
}

const db = {
  auth: { getUser: async () => ({ data: { user: actorId ? { id: actorId } : null } }) },
  from: (table) => queryFor(table)
};

vi.mock('@supabase/supabase-js', () => ({ createClient: () => db }));
vi.mock('$lib/server/971bot.js', () => ({ getSupabase: () => db }));
vi.mock('$lib/server/slack_notifications.js', () => ({ notifyScoutAssignment: vi.fn() }));

const { POST } = await import('./+server.js');

function request(body) {
  return new Request('https://test/api/scout-assignments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

describe('scout assignment completion', () => {
  beforeEach(() => {
    actorId = 'scout-1';
    assignmentOwner = actorId;
    updates = [];
  });

  it('uses the authenticated scout and does not require a caller-supplied user id', async () => {
    const response = await POST({ request: request({
      action: 'complete', scouting_type: 'data', match_key: '2026cc_qm4', team_key: 'frc3847'
    }) });
    expect(response.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].completed_at).toBeTruthy();
  });

  it('cannot complete another scout\'s assignment', async () => {
    assignmentOwner = 'scout-2';
    const response = await POST({ request: request({
      action: 'complete', scouting_type: 'data', match_key: '2026cc_qm4', team_key: 'frc3847', user_id: 'scout-2'
    }) });
    expect(response.status).toBe(403);
    expect(updates).toHaveLength(0);
  });
});
