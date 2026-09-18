import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { normalizeMatchRanking } from '$lib/server/matchRankingSchema.js';

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

function isMissingTable(error) {
  return error?.code === '42P01' || error?.code === 'PGRST205'
    || /scouting_match_rankings.*(does not exist|schema cache)/i.test(error?.message || '');
}

async function actorFor(client) {
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

export async function GET({ request, url }) {
  const db = clientFor(request);
  if (!await actorFor(db)) return json({ error: 'Unauthorized' }, { status: 401 });
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });
  const { data, error } = await db
    .from('scouting_match_rankings')
    .select('id,event_key,match_key,ranked_team_keys,created_by,updated_by,created_at,updated_at')
    .eq('event_key', eventKey)
    .order('updated_at', { ascending: false });
  if (error && isMissingTable(error)) return json({ success: true, data: [], unavailable: true });
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data: data || [] });
}

export async function POST({ request }) {
  const db = clientFor(request);
  const actor = await actorFor(db);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (body?.action !== 'save') return json({ error: 'Invalid action' }, { status: 400 });
  const { value, error: invalid } = normalizeMatchRanking(body, actor.id);
  if (invalid) return json({ error: invalid }, { status: 400 });
  const { data, error } = await db
    .from('scouting_match_rankings')
    .upsert(value, { onConflict: 'event_key,match_key' })
    .select('id,event_key,match_key,ranked_team_keys,created_by,updated_by,created_at,updated_at')
    .single();
  if (error && isMissingTable(error)) return json({ error: 'Match rankings are unavailable until the migration is applied.', code: 'SCOUTING_MATCH_RANKINGS_UNAVAILABLE' }, { status: 503 });
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data });
}
