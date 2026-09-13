import { beforeEach, describe, expect, it, vi } from 'vitest';

let actor, role, writes, files;
const chain = table => {
  let data = table === 'user_profiles' ? { id: 'admin', role }
    : table === 'roster_entries' ? [] : { start_position_photos: { 'blue:center': 'match-starts/old.jpg' } };
  const query = {
    select: () => query, eq: () => query,
    update: value => { writes.push(value); data = value; return query; },
    upsert: value => { writes.push(value); data = value; return query; },
    single: async () => ({ data, error: null }), maybeSingle: async () => ({ data, error: null }),
    then: resolve => Promise.resolve({ data, error: null }).then(resolve)
  };
  return query;
};
const client = {
  auth: { getUser: async () => ({ data: { user: actor } }) }, from: chain,
  storage: { from: () => ({
    list: async () => ({ data: files, error: null }),
    createSignedUploadUrl: async path => ({ data: { path, token: 'test' }, error: null })
  }) }
};
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
vi.mock('$lib/server/971bot.js', () => ({ getSupabase: () => client }));
vi.mock('$lib/server/google_sheets_sync.js', () => ({ syncScoutingDataToSheet: vi.fn() }));
const { POST } = await import('./+server.js');
const post = body => POST({ request: { headers: { get: () => 'Bearer test' }, json: async () => body } });

describe('scouting admin names and starting photos', () => {
  beforeEach(() => { actor = { id: 'admin' }; role = 'admin'; writes = []; files = []; });
  it('rejects unauthenticated and non-admin mutations', async () => {
    actor = null;
    expect((await post({ action: 'update-scout-name' })).status).toBe(401);
    actor = { id: 'member' }; role = 'member';
    expect((await post({ action: 'create-start-photo-upload' })).status).toBe(403);
    expect(writes).toEqual([]);
  });
  it('updates only the name and refuses email placeholders', async () => {
    expect((await post({ action: 'update-scout-name', target_user_id: 'scout', full_name: 'test@example.com' })).status).toBe(400);
    expect((await post({ action: 'update-scout-name', target_user_id: 'scout', full_name: ' Actual Scout ' })).status).toBe(200);
    expect(writes).toEqual([{ full_name: 'Actual Scout' }]);
  });
  it('limits signed uploads to supported images and 5 MiB', async () => {
    for (const extra of [{ content_type: 'text/html', size: 100 }, { content_type: 'image/png', size: 5242881 }]) {
      expect((await post({ action: 'create-start-photo-upload', ...extra })).status).toBe(400);
    }
    const response = await post({ action: 'create-start-photo-upload', content_type: 'image/png', size: 100 });
    expect(response.status).toBe(200);
    expect((await response.json()).data.path).toMatch(/^match-starts\/[a-f0-9-]+\.png$/);
  });
  it('requires an uploaded file and preserves other starting positions', async () => {
    const body = { action: 'save-start-photo', alliance: 'red', position: 'center', path: 'match-starts/abc.jpg' };
    expect((await post(body)).status).toBe(400);
    files = [{ name: 'abc.jpg', metadata: { size: 100 } }];
    expect((await post(body)).status).toBe(200);
    expect(writes[0].start_position_photos).toEqual({ 'blue:center': 'match-starts/old.jpg', 'red:center': body.path });
  });
});
