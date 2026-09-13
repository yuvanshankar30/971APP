import { beforeEach, describe, expect, it, vi } from 'vitest';

let actor;
let writes;
let entries;
let filters;
const chain = (table) => {
  let data = table === 'scouting_settings' ? { start_position_photos: { 'red:center': 'match-starts/photo.jpg' } }
    : table === 'user_profiles' ? [{ id: 'scout', full_name: 'Account Name' }]
    : table === 'match_scout_entries' ? entries : null;
  const query = {
    select: () => query, eq: (field, value) => { filters.push({ table, field, value }); if (Array.isArray(data)) data = data.filter(row => row[field] === undefined || row[field] === value); return query; }, in: () => query, order: () => query,
    upsert: value => { writes.push(value); data = value; return query; },
    single: async () => ({ data, error: null }), maybeSingle: async () => ({ data, error: null }),
    then: resolve => Promise.resolve({ data, error: null }).then(resolve)
  };
  return query;
};
const client = {
  auth: { getUser: async () => ({ data: { user: actor } }) }, from: chain,
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/photo' }, error: null }) }) }
};
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
vi.mock('$lib/server/971bot.js', () => ({ getSupabase: () => client }));
vi.mock('$lib/server/auto_path_drive_export.js', () => ({ exportAutoPathImageToDrive: vi.fn() }));
const { GET, POST } = await import('./+server.js');
const request = body => ({ headers: { get: () => 'Bearer test' }, json: async () => body });
const valid = {
  action: 'save-entry', event_key: '2026test', match_key: 'qm1', team_key: '971',
  starting_position: 'center', scout_name: 'Actual Scout', preload: true,
  teleop_roles: ['Scorer'], balls_scored_band: '123', ratings: { BPS: 3 },
  ratings_unknown: ['Shot accuracy'], significant_crash: false,
  teleop_robot_status: 'active', mechanical_break: false
};

describe('match scouting route v2', () => {
  beforeEach(() => { actor = { id: 'scout' }; writes = []; entries = []; filters = []; });
  it('requires authentication for photos and reports', async () => {
    actor = null;
    expect((await GET({ request: request(), url: new URL('https://test/api/matchscout?resource=start-photos') })).status).toBe(401);
    expect((await POST({ request: request(valid) })).status).toBe(401);
    expect(writes).toEqual([]);
  });
  it('does not allow omitting form_version to bypass required answers', async () => {
    expect((await POST({ request: request({ action: 'save-entry', event_key: '2026test', match_key: 'qm1', team_key: '971' }) })).status).toBe(400);
    expect(writes).toEqual([]);
  });
  it('saves typed counts and explicit unknowns without sending email or notifications', async () => {
    expect((await POST({ request: request(valid) })).status).toBe(200);
    expect(writes[0]).toMatchObject({ form_version: 2, balls_scored_average: 123, ratings_unknown: ['Shot accuracy'] });
  });
  it('blocks mechanical breaks and dead robots before saving without an ACE summary', async () => {
    for (const extra of [{ mechanical_break: true }, { teleop_robot_status: 'dead' }]) {
      expect((await POST({ request: request({ ...valid, ...extra }) })).status).toBe(400);
    }
    expect(writes).toEqual([]);
  });
  it('limits My reports to the verified scout, ignoring caller-supplied ownership', async () => {
    entries = [{ id: 'own', created_by: 'scout' }, { id: 'other', created_by: 'another-scout' }];
    const response = await GET({ request: request(), url: new URL('https://test/api/matchscout?event_key=2026test&mine=1&created_by=another-scout') });
    expect((await response.json()).data.map(row => row.id)).toEqual(['own']);
    expect(filters).toContainEqual({ table: 'match_scout_entries', field: 'created_by', value: 'scout' });
  });
  it('attributes corrections to the verified scout and uses the existing report key', async () => {
    await POST({ request: request({ ...valid, created_by: 'another-scout', teleop_notes: 'Corrected observation' }) });
    expect(writes[0]).toMatchObject({ created_by: 'scout', event_key: '2026test', match_key: 'qm1', team_key: 'frc971', teleop_notes: 'Corrected observation' });
  });
  it('returns signed photo URLs and keeps the original report scout name', async () => {
    const photoResponse = await GET({ request: request(), url: new URL('https://test/api/matchscout?resource=start-photos') });
    expect((await photoResponse.json()).data['red:center']).toBe('https://example.test/photo');
    entries = [{ created_by: 'scout', scout_name: 'Original Scout' }];
    const reportResponse = await GET({ request: request(), url: new URL('https://test/api/matchscout?event_key=2026test') });
    expect((await reportResponse.json()).data[0].scout_name).toBe('Original Scout');
  });
});
