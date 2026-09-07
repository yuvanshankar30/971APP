import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';

// Same request-handling shape as src/routes/datascout|notescout/+server.js -
// authenticated writes, service-role fallback when configured, and GET reads
// treated as public whenever an event_key
// is present (the picklist is meant to be glanceable without friction, same
// spirit as team_key-scoped reads elsewhere in scouting).
const getClientFromRequest = (request) => {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
};

function getDbClient(fallbackClient) {
  try {
    return getSupabase();
  } catch {
    return fallbackClient;
  }
}

async function getActor(authSupa) {
  const { data } = await authSupa.auth.getUser();
  return data?.user || null;
}

/*
  Scouting Pick List API
  GET  ?event_key=... => ordered list of picked teams for that event (public read)
  POST actions:
    - add:    { event_key, team_key, team_number, nickname }
    - remove: { id }
    - reorder: { event_key, ordered_ids: [id, id, ...] } - full position renumber
    - note:   { id, note }
*/
export async function GET({ url, request }) {
  const event_key = String(url.searchParams.get('event_key') || '').trim();
  if (!event_key) return json({ success: false, error: 'event_key required' }, { status: 400 });

  try {
    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const { data, error } = await db
      .from('scouting_picklist')
      .select('*')
      .eq('event_key', event_key)
      .order('position', { ascending: true });

    if (error) return json({ success: false, error: error.message }, { status: 500 });
    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const action = body?.action;

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const actor = await getActor(authSupa);
    if (!actor?.id) return json({ success: false, error: 'Unauthorized' }, { status: 401 });

    if (action === 'add') {
      const { event_key, team_key, team_number, nickname } = body;
      if (!event_key || !team_key) return json({ success: false, error: 'event_key and team_key required' }, { status: 400 });

      const { data: existing } = await db
        .from('scouting_picklist')
        .select('position')
        .eq('event_key', event_key)
        .order('position', { ascending: false })
        .limit(1);
      const nextPosition = (existing?.[0]?.position ?? -1) + 1;

      const { data, error } = await db
        .from('scouting_picklist')
        .insert([{
          event_key,
          team_key,
          team_number: Number(team_number) || null,
          nickname: nickname || null,
          position: nextPosition,
          created_by: actor?.id || null
        }])
        .select('*')
        .single();
      // A team can only appear once per event (UNIQUE(event_key, team_key)) -
      // treat that as a normal, expected outcome (already picked), not an error.
      if (error) {
        if (error.code === '23505') return json({ success: false, error: 'Already on the pick list' }, { status: 409 });
        return json({ success: false, error: error.message }, { status: 500 });
      }
      return json({ success: true, data });
    }

    if (action === 'remove') {
      const { id } = body;
      if (!id) return json({ success: false, error: 'id required' }, { status: 400 });
      const { error } = await db.from('scouting_picklist').delete().eq('id', id);
      if (error) return json({ success: false, error: error.message }, { status: 500 });
      return json({ success: true });
    }

    if (action === 'reorder') {
      const { event_key, ordered_ids } = body;
      if (!event_key || !Array.isArray(ordered_ids)) {
        return json({ success: false, error: 'event_key and ordered_ids required' }, { status: 400 });
      }
      // Small lists (a real pick list is dozens of teams at most, never
      // thousands) - a full renumber per reorder is simple and correct,
      // not worth fractional-indexing complexity for this data volume.
      for (let i = 0; i < ordered_ids.length; i += 1) {
        const { error } = await db
          .from('scouting_picklist')
          .update({ position: i, updated_at: new Date().toISOString() })
          .eq('id', ordered_ids[i])
          .eq('event_key', event_key);
        if (error) return json({ success: false, error: error.message }, { status: 500 });
      }
      return json({ success: true });
    }

    if (action === 'note') {
      const { id, note } = body;
      if (!id) return json({ success: false, error: 'id required' }, { status: 400 });
      const { data, error } = await db
        .from('scouting_picklist')
        .update({ note: note || null, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
      if (error) return json({ success: false, error: error.message }, { status: 500 });
      return json({ success: true, data });
    }

    return json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    return json({ success: false, error: e.message || 'Internal error' }, { status: 500 });
  }
}
