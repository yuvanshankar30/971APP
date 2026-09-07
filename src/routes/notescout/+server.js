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
  return url.searchParams.has('list_teams') || Boolean(teamKey);
}

async function getActor(authSupa) {
  const { data } = await authSupa.auth.getUser();
  return data?.user || null;
}

function sanitizeRankingImpact(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= -2 && parsed <= 2 ? parsed : 0;
}

async function insertScoutNote(db, payload) {
  let result = await db.from('scout_notes').insert([payload]).select('*').single();
  if (!result.error) return { ...result, rankingImpactSaved: true };

  const message = String(result.error.message || '').toLowerCase();
  if (!message.includes('ranking_impact') || (!message.includes('column') && !message.includes('schema cache'))) {
    return { ...result, rankingImpactSaved: false };
  }

  const { ranking_impact: _rankingImpact, ...legacyPayload } = payload;
  result = await db.from('scout_notes').insert([legacyPayload]).select('*').single();
  return { ...result, rankingImpactSaved: false };
}

// POST to save notes: expects { action: 'save-note', match_key, match_number,
// team_key, notes, ranking_impact }
export async function POST({ request }) {
  try {
    const body = await request.json();
    const action = body?.action;
    if (action !== 'save-note') return json({ error: 'Invalid action' }, { status: 400 });

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const actor = await getActor(authSupa);
    if (!actor?.id) return json({ error: 'Unauthorized' }, { status: 401 });

    const match_key = body.match_key || null;
    const match_number = body.match_number || null;
    const team_key = body.team_key || null;
    const notes = body.notes || '';

    if (!match_key || !team_key) return json({ error: 'match_key and team_key required' }, { status: 400 });

    const payload = {
      match_key,
      match_number: Number(match_number) || null,
      team_key,
      notes: String(notes),
      ranking_impact: sanitizeRankingImpact(body.ranking_impact),
      created_by: actor.id,
      created_at: new Date().toISOString()
    };

    const { data, error, rankingImpactSaved } = await insertScoutNote(db, payload);
    if (error) return json({ error: error.message }, { status: 500 });
    return json({
      success: true,
      data,
      warning: rankingImpactSaved ? null : 'Note saved, but ranking impact requires the latest database migration.'
    });
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
    const event_key = String(url.searchParams.get('event_key') || '').trim();
    const applyEventFilter = (query) => (event_key ? query.ilike('match_key', `${event_key}_%`) : query);
    if (team_key) {
      let query = db
        .from('scout_notes')
        .select('*')
        .eq('team_key', team_key);
      query = applyEventFilter(query);
      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data });
    }

    if (url.searchParams.get('list_teams')) {
      const requestedRecent = Number(url.searchParams.get('recent') || '1000');
      const recent = Number.isFinite(requestedRecent)
        ? Math.min(Math.max(Math.trunc(requestedRecent), 1), 5000)
        : 1000;
      let query = db
        .from('scout_notes')
        .select('team_key');
      query = applyEventFilter(query);
      const { data, error } = await query
        .order('team_key', { ascending: true })
        .limit(recent);

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

    const recent = Math.min(Math.max(Number(url.searchParams.get('recent') || '50') || 50, 1), 50000);
    let query = db
      .from('scout_notes')
      .select('*');
    query = applyEventFilter(query);
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(recent);

    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
