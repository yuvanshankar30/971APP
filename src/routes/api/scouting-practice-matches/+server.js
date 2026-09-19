import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { buildPracticeMatch } from '$lib/server/practiceMatches.js';

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

function isMissingTable(error) {
  return error?.code === '42P01' || error?.code === 'PGRST205'
    || /scouting_practice_matches.*(does not exist|schema cache)/i.test(error?.message || '');
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
    .from('scouting_practice_matches')
    .select('id,event_key,match_key,label,created_by,created_at')
    .eq('event_key', eventKey)
    .order('created_at', { ascending: true });
  if (error && isMissingTable(error)) return json({ success: true, data: [], unavailable: true });
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data: data || [] });
}

// Every practice match is just the next number for the event - "Add
// practice match" needs no form, so there's nothing else for the caller to
// supply beyond which event it belongs to.
export async function POST({ request }) {
  const db = clientFor(request);
  const actor = await actorFor(db);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (body?.action !== 'add') return json({ error: 'Invalid action' }, { status: 400 });
  const eventKey = String(body?.event_key || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });

  const { count, error: countError } = await db
    .from('scouting_practice_matches')
    .select('id', { count: 'exact', head: true })
    .eq('event_key', eventKey);
  if (countError && isMissingTable(countError)) {
    return json({ error: 'Practice matches are unavailable until the migration is applied.', code: 'SCOUTING_PRACTICE_MATCHES_UNAVAILABLE' }, { status: 503 });
  }
  if (countError) return json({ error: countError.message }, { status: 500 });

  const { match_key, label } = buildPracticeMatch(eventKey, count);
  const { data, error } = await db
    .from('scouting_practice_matches')
    .insert({ event_key: eventKey, match_key, label, created_by: actor.id })
    .select('id,event_key,match_key,label,created_by,created_at')
    .single();
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data });
}
