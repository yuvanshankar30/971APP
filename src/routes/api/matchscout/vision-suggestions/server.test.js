import { beforeEach, describe, expect, it, vi } from 'vitest';
let actor, rows, errors;
const query = table => {
  let selected = rows[table] || [];
  const result = {
    select: () => result,
    eq: (field, value) => { selected = selected.filter(row => row[field] === value); return result; },
    in: (field, values) => { selected = selected.filter(row => values.includes(row[field])); return result; },
    order: () => result,
    then: resolve => Promise.resolve({ data: selected, error: errors[table] || null }).then(resolve)
  };
  return result;
};
const client = { auth: { getUser: async () => ({ data: { user: actor } }) }, from: query };
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
const { GET } = await import('./+server.js');
const get = value => GET({ request: { headers: { get: () => 'Bearer test' } }, url: new URL(`https://test/api/matchscout/vision-suggestions?${value}`) });

beforeEach(() => {
  actor = { id: 'scout' }; errors = {};
  rows = {
    vision_matches: [{ id: 'match', event_key: '2026test', match_key: '2026test_qm14' }],
    vision_runs: [{ id: 'run', vision_match_id: 'match', status: 'complete', model_name: 'robot', config: {} }],
    vision_tracks: [],
    vision_observations: [
      { id: 'reviewed', vision_run_id: 'run', team_key: 'frc971', review_status: 'accepted', observation_type: 'fuel_scored', phase: 'teleop', started_ms: 20000, value: { count: 3 } },
      { id: 'unreviewed', vision_run_id: 'run', team_key: 'frc971', review_status: 'unreviewed', observation_type: 'fuel_scored', phase: 'teleop', started_ms: 20000, value: { count: 99 } }
    ]
  };
});

describe('match scout vision suggestions endpoint', () => {
  it('requires a signed-in user and assignment identifiers', async () => {
    actor = null; expect((await get('event_key=2026test&match_key=14&team_key=971')).status).toBe(401);
    actor = { id: 'scout' }; expect((await get('event_key=2026test')).status).toBe(400);
  });
  it('uses the matching completed run and only reviewed team evidence', async () => {
    const response = await get('event_key=2026test&match_key=14&team_key=971');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.run.id).toBe('run');
    expect(body.data.fields.ballsScored).toBe('3');
  });
  it('falls back to an earlier reviewed run when the latest rerun has no usable evidence', async () => {
    rows.vision_runs = [
      { id: 'new', vision_match_id: 'match', status: 'complete', model_name: 'new-model', config: {} },
      { id: 'old', vision_match_id: 'match', status: 'complete', model_name: 'old-model', config: {} }
    ];
    rows.vision_observations = [
      { id: 'old-review', vision_run_id: 'old', team_key: 'frc971', review_status: 'accepted', observation_type: 'fuel_scored', phase: 'teleop', started_ms: 20000, value: { count: 5 } }
    ];
    const body = await (await get('event_key=2026test&match_key=14&team_key=971')).json();
    expect(body.data.run).toMatchObject({ id: 'old', model_name: 'old-model' });
    expect(body.data.fields.ballsScored).toBe('5');
  });
  it('returns no suggestion when vision has no registered match', async () => {
    rows.vision_matches = [];
    expect((await (await get('event_key=2026test&match_key=14&team_key=971')).json()).data).toMatchObject({ run: null, fields: {} });
  });
});
