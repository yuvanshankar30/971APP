import { beforeEach, describe, expect, it, vi } from 'vitest';
let actor, rows, filters, errors;
const chain = table => {
  let selected = rows[table] || [];
  const query = {
    select: () => query,
    eq: (field, value) => { filters.push({ table, field, value }); selected = selected.filter(row => row[field] === value); return query; },
    in: (field, values) => { selected = selected.filter(row => values.includes(row[field])); return query; },
    order: () => query,
    maybeSingle: async () => ({ data: selected[0] || null, error: errors[table] || null }),
    then: resolve => Promise.resolve({ data: selected, error: errors[table] || null }).then(resolve)
  };
  return query;
};
const client = { auth: { getUser: async () => ({ data: { user: actor } }) }, from: chain };
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
vi.mock('$lib/server/971bot.js', () => ({ getSupabase: () => client }));
const { GET } = await import('./+server.js');
const get = params => GET({ request: { headers: { get: () => 'Bearer test' } }, url: new URL(`https://test/api/matchscout/comparison?${params}`) });

beforeEach(() => {
  actor = { id: 'scout' }; filters = []; errors = {};
  rows = {
    match_scout_entries: [{ id: 'own', created_by: 'scout', team_key: 'frc971', match_key: '14', event_key: '2026test' }, { id: 'other', created_by: 'other-scout' }],
    vision_matches: [{ id: 'match', event_key: '2026test', match_key: '2026test_qm14' }, { id: 'unrelated', event_key: '2026other', match_key: '2026other_qm14' }],
    vision_runs: [{ id: 'pending', vision_match_id: 'match', status: 'processing' }, { id: 'complete', vision_match_id: 'match', status: 'complete' }, { id: 'other-run', vision_match_id: 'unrelated', status: 'complete' }],
    vision_observations: [{ id: 'own-observation', vision_run_id: 'complete', team_key: 'frc971' }, { id: 'another-team', vision_run_id: 'complete', team_key: 'frc254' }],
    vision_tracks: []
  };
});
describe('scouting comparison endpoint', () => {
  it('requires authentication and a report ID', async () => {
    actor = null; expect((await get('report_id=own')).status).toBe(401);
    actor = { id: 'scout' }; expect((await get('')).status).toBe(400);
  });
  it('does not reveal another scout’s report', async () => {
    expect((await get('report_id=other&created_by=other-scout')).status).toBe(404);
    expect(filters).toContainEqual({ table: 'match_scout_entries', field: 'created_by', value: 'scout' });
  });
  it('selects a completed run and restricts results to the same event, match and team', async () => {
    const result = await (await get('report_id=own')).json();
    expect(result.data.run.id).toBe('complete');
    expect(result.data.matches.map(row => row.id)).toEqual(['match']);
    expect(result.data.observations.map(row => row.id)).toEqual(['own-observation']);
  });
  it('allows run selection within this match and rejects an unrelated run', async () => {
    expect((await (await get('report_id=own&run_id=pending')).json()).data.run.id).toBe('pending');
    expect((await get('report_id=own&run_id=other-run')).status).toBe(400);
  });
  it('returns an empty comparison when vision is not registered', async () => {
    rows.vision_matches = [];
    expect((await (await get('report_id=own')).json()).data).toMatchObject({ manual: { id: 'own' }, matches: [], runs: [], run: null, observations: [], tracks: [] });
  });
  it('reports database errors instead of silently displaying missing data', async () => {
    errors.vision_observations = { message: 'Vision unavailable' };
    const response = await get('report_id=own');
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Vision unavailable');
  });
});
