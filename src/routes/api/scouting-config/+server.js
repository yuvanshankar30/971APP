import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';
import notescoutConfig from '$lib/notescout.json';
import { getSupabase } from '$lib/server/971bot.js';

const getClientFromRequest = (request) => {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
};

function fallbackEventKey() {
  return String(notescoutConfig?.event_key || '').trim() || null;
}

function canManageScouting(profile, rosterKeys) {
  return profile?.role === 'admin'
    || (rosterKeys || []).some((key) => String(key).trim().toLowerCase() === 'scouting admin');
}

async function fetchActorProfile(authSupa) {
  const { data } = await authSupa.auth.getUser();
  const actorId = data?.user?.id || null;
  if (!actorId) return { actorId: null, profile: null };

  const [profileResult, rosterResult] = await Promise.all([
    authSupa.from('user_profiles').select('id, role').eq('id', actorId).single(),
    authSupa.from('roster_entries').select('key:key_id(key_name)').eq('user_id', actorId)
  ]);

  return {
    actorId,
    profile: profileResult.data || null,
    rosterKeys: (rosterResult.data || []).map((entry) => entry?.key?.key_name).filter(Boolean)
  };
}

async function getActiveEventKey(db) {
  const { data, error } = await db
    .from('scouting_settings')
    .select('event_key')
    .eq('id', 1)
    .maybeSingle();

  if (error) return fallbackEventKey();
  return String(data?.event_key || '').trim() || fallbackEventKey();
}

// TBA event keys never contain underscores, so the text before the first
// underscore in a match_key (format `{event_key}_{comp_level}{match_number}`,
// e.g. "2026arc_qm1") is always the exact event_key.
function eventKeyFromMatchKey(matchKey) {
  const raw = String(matchKey || '').trim();
  if (!raw) return '';
  return raw.split('_')[0] || '';
}

// Old events' scouting rows aren't deleted when a new active event is set -
// they're just hidden by the current event-key-only query scoping. This
// finds every distinct event_key with real historical data across all three
// scouting tables so the UI can offer them for browsing.
async function fetchDistinctEventKeys(db) {
  const [pitRes, dataRes, noteRes] = await Promise.all([
    db.from('pit_scout_entries').select('event_key'),
    db.from('scout_data_events').select('match_key'),
    db.from('scout_notes').select('match_key')
  ]);

  const keys = new Set();
  for (const row of pitRes.data || []) {
    const key = String(row?.event_key || '').trim();
    if (key) keys.add(key);
  }
  for (const row of dataRes.data || []) {
    const key = eventKeyFromMatchKey(row?.match_key);
    if (key) keys.add(key);
  }
  for (const row of noteRes.data || []) {
    const key = eventKeyFromMatchKey(row?.match_key);
    if (key) keys.add(key);
  }

  return [...keys];
}

async function fetchEventLabel(eventKey) {
  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return eventKey;

  try {
    const resp = await fetch(`https://www.thebluealliance.com/api/v3/event/${encodeURIComponent(eventKey)}/simple`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (!resp.ok) return eventKey;

    const data = await resp.json();
    if (data?.year && data?.name) return `${data.year} ${data.name}`;
    return eventKey;
  } catch {
    return eventKey;
  }
}

async function fetchAvailableEvents(db) {
  const eventKeys = await fetchDistinctEventKeys(db);
  if (!eventKeys.length) return [];

  // Promise.allSettled so one failed TBA lookup can't break the whole list -
  // any event whose fetch fails or resolves without a usable name/year just
  // falls back to displaying its raw event_key string.
  const labelResults = await Promise.allSettled(eventKeys.map((key) => fetchEventLabel(key)));
  const options = eventKeys.map((key, idx) => {
    const result = labelResults[idx];
    const label = result.status === 'fulfilled' && result.value ? result.value : key;
    return { value: key, label };
  });

  options.sort((a, b) => b.value.localeCompare(a.value));
  return options;
}

export async function GET() {
  try {
    const db = getSupabase();
    const eventKey = await getActiveEventKey(db);

    let availableEvents = [];
    try {
      availableEvents = await fetchAvailableEvents(db);
    } catch {
      availableEvents = [];
    }

    return json({ success: true, data: { event_key: eventKey, available_events: availableEvents } });
  } catch {
    return json({ success: true, data: { event_key: fallbackEventKey(), available_events: [] } });
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const nextEventKey = String(body?.event_key || '').trim();
    if (!nextEventKey) return json({ error: 'event_key is required' }, { status: 400 });

    const authSupa = getClientFromRequest(request);
    const { actorId, profile, rosterKeys } = await fetchActorProfile(authSupa);
    if (!actorId) return json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageScouting(profile, rosterKeys)) return json({ error: 'Forbidden' }, { status: 403 });

    const db = getSupabase();
    const { data, error } = await db
      .from('scouting_settings')
      .upsert({ id: 1, event_key: nextEventKey, updated_by: actorId, updated_at: new Date().toISOString() }, { onConflict: 'id' })
      .select('event_key')
      .single();

    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data: { event_key: data?.event_key || nextEventKey } });
  } catch (e) {
    return json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
