import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';

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

function isPublicReadRequest(url) {
  const teamKey = String(url.searchParams.get('team_key') || '').trim();
  return url.searchParams.has('list_teams') || url.searchParams.has('all_teams') || Boolean(teamKey);
}

async function getActor(authSupa) {
  const { data } = await authSupa.auth.getUser();
  return data?.user || null;
}

/*
  Data Scout API
  POST actions:
    - record-event: { action, match_key, match_number, team_key, phase, event_type, event_value, role, on_shift }
    - update-event-timestamp: { action, id, created_at } => used by Quick Scout's editable
      timeline to correct a mistimed toggle tap; same ownership rule as DELETE below.
  DELETE actions:
    - { id } => deletes specific event
  GET query params:
    - ?team_key=... => all events for team
    - ?team_key=...&match_key=... => events for that match/team
    - ?list_teams=1 => list of distinct team keys
*/

export async function POST({ request }) {
  try {
    const body = await request.json();

    if (body?.action === 'update-event-timestamp') {
      const { id, created_at } = body;
      if (!id || !created_at) return json({ error: 'Missing required fields' }, { status: 400 });

      const authSupa = getClientFromRequest(request);
      const db = getDbClient(authSupa);
      const actor = await getActor(authSupa);
      if (!actor?.id) return json({ error: 'Unauthorized' }, { status: 401 });

      const { data: profile } = await authSupa
        .from('user_profiles')
        .select('role')
        .eq('id', actor.id)
        .single();

      const { data: row, error: rowErr } = await db
        .from('scout_data_events')
        .select('created_by')
        .eq('id', id)
        .single();

      if (rowErr) return json({ error: rowErr.message }, { status: 500 });

      const canEdit = profile?.role === 'admin' || row?.created_by === actor.id;
      if (!canEdit) return json({ error: 'Forbidden' }, { status: 403 });

      const { data, error } = await db
        .from('scout_data_events')
        .update({ created_at })
        .eq('id', id)
        .select('*')
        .single();

      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data });
    }

    if (body?.action !== 'record-event') return json({ error: 'Invalid action' }, { status: 400 });

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const actor = await getActor(authSupa);
    if (!actor?.id) return json({ error: 'Unauthorized' }, { status: 401 });

    const { match_key, match_number, team_key, phase, event_type, event_value, role, on_shift } = body;
    if (!match_key || !team_key || !event_type) return json({ error: 'Missing required fields' }, { status: 400 });

    const payload = {
      match_key,
      match_number: Number(match_number) || null,
      team_key,
      phase: phase || null,
      event_type,
      event_value: event_value ?? null,
      role: role ?? null,
      on_shift: typeof on_shift === 'boolean' ? on_shift : null,
      // Authenticated identity is authoritative; never accept attribution
      // supplied by a caller in the JSON body.
      created_by: actor.id,
      created_at: new Date().toISOString()
    };

    const { data, error } = await db.from('scout_data_events').insert([payload]).select('*').single();
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function DELETE({ request }) {
  try {
    const { id } = await request.json();
    if (!id) return json({ error: 'Missing ID' }, { status: 400 });

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const actor = await getActor(authSupa);
    if (!actor?.id) return json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await authSupa
      .from('user_profiles')
      .select('role')
      .eq('id', actor.id)
      .single();

    const { data: row, error: rowErr } = await db
      .from('scout_data_events')
      .select('created_by')
      .eq('id', id)
      .single();

    if (rowErr) return json({ error: rowErr.message }, { status: 500 });

    const canDelete = profile?.role === 'admin' || row?.created_by === actor.id;
    if (!canDelete) return json({ error: 'Forbidden' }, { status: 403 });

    const { error } = await db.from('scout_data_events').delete().eq('id', id);
    if (error) return json({ error: error.message }, { status: 500 });

    return json({ success: true });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET({ url, request }) {
  try {
    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const actor = await getActor(authSupa);
    const canReadPublic = isPublicReadRequest(url);

    if (!actor?.id && !canReadPublic) return json({ error: 'Unauthorized' }, { status: 401 });

    const team_key = url.searchParams.get('team_key');
    const match_key = url.searchParams.get('match_key');
    const event_key = String(url.searchParams.get('event_key') || '').trim();
    const applyEventFilter = (query) => (event_key ? query.ilike('match_key', `${event_key}_%`) : query);

    if (team_key && match_key) {
      let query = db
        .from('scout_data_events')
        .select('*')
        .eq('team_key', team_key)
        .eq('match_key', match_key);
      query = applyEventFilter(query);
      const { data, error } = await query.order('created_at', { ascending: true });

      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data });
    }

    if (team_key) {
      let query = db
        .from('scout_data_events')
        .select('*')
        .eq('team_key', team_key);
      query = applyEventFilter(query);
      const { data, error } = await query.order('created_at', { ascending: true });

      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data });
    }

    if (url.searchParams.get('list_teams')) {
      let query = db
        .from('scout_data_events')
        .select('team_key');
      query = applyEventFilter(query);
      const { data, error } = await query
        .order('team_key', { ascending: true })
        .limit(2000);

      if (error) return json({ error: error.message }, { status: 500 });

      const seen = new Set();
      const teams = [];
      for (const row of data || []) {
        const t = row?.team_key;
        if (t && !seen.has(t)) {
          seen.add(t);
          teams.push(t);
        }
      }
      return json({ success: true, data: teams });
    }

    if (url.searchParams.get('all_teams')) {
      const pageSize = 1000;
      const maxRows = 50000;
      const rows = [];
      for (let from = 0; from < maxRows; from += pageSize) {
        // Rankings need match outcomes, not scout identity or assignment
        // metadata. Keep the public event-wide response deliberately narrow.
        let query = db
          .from('scout_data_events')
          .select('id,match_key,team_key,event_type,event_value,created_at');
        query = applyEventFilter(query);
        const { data, error } = await query
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) return json({ error: error.message }, { status: 500 });
        rows.push(...(data || []));
        if ((data || []).length < pageSize) break;
      }
      return json({ success: true, data: rows, truncated: rows.length >= maxRows });
    }

    const requestedRecent = Number(url.searchParams.get('recent') || '100');
    const recent = Number.isFinite(requestedRecent)
      ? Math.min(Math.max(Math.trunc(requestedRecent), 1), 1000)
      : 100;
    const { data, error } = await db
      .from('scout_data_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(recent);

    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
