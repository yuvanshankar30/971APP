import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { notifyPrescoutAssignment, notifyScoutUnassignment } from '$lib/server/slack_notifications.js';

const TABLE = 'scout_prescout_assignments';

function getClientFromRequest(request) {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
}

function getDbClient(fallbackClient) {
  try {
    return getSupabase();
  } catch {
    return fallbackClient;
  }
}

function normalizePerms(value) {
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTeamKey(value) {
  const team = String(value || '').trim().toLowerCase().replace(/^frc/, '');
  return /^\d+$/.test(team) ? `frc${team}` : null;
}

function computeAccess(profile, rosterKeys) {
  const perms = new Set(normalizePerms(profile?.permissions));
  const keys = new Set((rosterKeys || []).map(normalizeKey).filter(Boolean));
  const isAdmin = profile?.role === 'admin';
  const isCompetitionLead = String(profile?.team_role || '').trim().toLowerCase() === 'competition lead';
  const hasLeadKey = keys.has('scouting admin') || keys.has('data scout lead') || keys.has('scouting lead');
  const hasMemberKey = keys.has('data scout member') || hasLeadKey;
  // VIEW_ADMIN_PANEL (any team lead, general_role 'lead') already gets into
  // the Scouting Admin page itself - direct instruction: everyone who can
  // see this panel should be able to publish from it, not land in a
  // confusing view-only state just because they hold no scouting-specific
  // roster key of their own.
  const canEdit = isAdmin || isCompetitionLead || perms.has('DATA_SCOUT_ADMIN') || perms.has('VIEW_ADMIN_PANEL') || hasLeadKey;
  return {
    canEdit,
    canAssign: canEdit || perms.has('DATA_SCOUT_MEMBER') || hasMemberKey,
    rosterKeys: [...keys]
  };
}

function isEligibleKey(keyName) {
  const key = normalizeKey(keyName);
  return key === 'data scout member' || key === 'data scout lead' || key === 'scouting lead' || key === 'scouting admin';
}

async function fetchActorProfile(supa) {
  const { data: authRes } = await supa.auth.getUser();
  const actorId = authRes?.user?.id || null;
  if (!actorId) return { actorId: null, profile: null };
  const { data: row } = await supa
    .from('user_profiles')
    .select('id, role, permissions, team_role')
    .eq('id', actorId)
    .single();
  return {
    actorId,
    profile: {
      id: actorId,
      role: row?.role || 'member',
      permissions: normalizePerms(row?.permissions),
      team_role: row?.team_role || null
    }
  };
}

async function fetchRosterKeysForUser(supa, userId) {
  if (!userId) return [];
  const { data, error } = await supa
    .from('roster_entries')
    .select('key:key_id(key_name)')
    .eq('user_id', userId);
  if (error) return [];
  return (data || []).map((row) => row?.key?.key_name).filter(Boolean).map(String);
}

async function listEligibleUsers(db) {
  const { data, error } = await db
    .from('roster_entries')
    .select('user_id, key:key_id(key_name), user:user_id(id, full_name, email, banned)');
  if (error) throw error;
  const users = new Map();
  for (const row of data || []) {
    if (!isEligibleKey(row?.key?.key_name) || !row?.user?.id || row.user.banned) continue;
    users.set(row.user.id, {
      id: row.user.id,
      full_name: row.user.full_name || null,
      email: row.user.email || null
    });
  }
  return [...users.values()].sort((a, b) =>
    (a.full_name || a.email || '').localeCompare(b.full_name || b.email || '')
  );
}

async function getSettings(db) {
  const { data, error } = await db
    .from('scouting_settings')
    .select('event_key, manual_teams')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return {
    eventKey: String(data?.event_key || '').trim(),
    teams: [...new Set((data?.manual_teams || []).map(normalizeTeamKey).filter(Boolean))]
      .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
  };
}

async function requestAccess(request) {
  const authSupa = getClientFromRequest(request);
  const db = getDbClient(authSupa);
  const { actorId, profile } = await fetchActorProfile(authSupa);
  if (!actorId) return { error: json({ error: 'Unauthorized' }, { status: 401 }) };
  const rosterKeys = await fetchRosterKeysForUser(db, actorId);
  return { db, access: computeAccess(profile, rosterKeys) };
}

export async function GET({ url, request }) {
  try {
    const context = await requestAccess(request);
    if (context.error) return context.error;
    const { db, access } = context;
    if (url.searchParams.get('capabilities')) {
      return json({ success: true, data: { can_view: true, can_edit: access.canEdit, can_be_assigned: access.canAssign, roster_keys: access.rosterKeys } });
    }
    if (url.searchParams.get('eligible')) {
      if (!access.canEdit) return json({ error: 'Forbidden' }, { status: 403 });
      return json({ success: true, data: await listEligibleUsers(db) });
    }
    if (url.searchParams.get('teams')) {
      const settings = await getSettings(db);
      if (!settings.eventKey) return json({ error: 'No event configured' }, { status: 400 });
      return json({ success: true, event_key: settings.eventKey, data: settings.teams });
    }
    const eventKey = String(url.searchParams.get('event_key') || '').trim();
    if (!eventKey) return json({ error: 'event_key required' }, { status: 400 });
    const { data, error } = await db
      .from(TABLE)
      .select('id, event_key, team_key, assigned_user, completed_at')
      .eq('event_key', eventKey)
      .order('team_key');
    if (error) return json({ error: error.message }, { status: 500 });
    const ids = [...new Set((data || []).map((row) => row.assigned_user).filter(Boolean))];
    const names = {};
    if (ids.length) {
      const { data: profiles } = await db.from('user_profiles').select('id, full_name, email').in('id', ids);
      for (const profile of profiles || []) names[profile.id] = profile.full_name || profile.email || null;
    }
    return json({ success: true, data: (data || []).map((row) => ({ ...row, user_name: names[row.assigned_user] || null })) });
  } catch (error) {
    return json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const eventKey = String(body?.event_key || '').trim();
    if (!eventKey) return json({ error: 'event_key required' }, { status: 400 });
    const context = await requestAccess(request);
    if (context.error) return context.error;
    const { db, access } = context;
    if (!access.canEdit) return json({ error: 'Forbidden' }, { status: 403 });

    const action = body?.action;
    if (action === 'bulk-assign') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ error: 'items required' }, { status: 400 });
      const settings = await getSettings(db);
      if (settings.eventKey !== eventKey) return json({ error: 'Active event changed. Refresh and try again.' }, { status: 409 });
      const allowedTeams = new Set(settings.teams);
      const rows = items.map((item) => ({
        event_key: eventKey,
        team_key: normalizeTeamKey(item?.team_key),
        assigned_user: String(item?.user_id || '').trim()
      }));
      if (rows.some((row) => !row.team_key || !row.assigned_user || !allowedTeams.has(row.team_key))) {
        return json({ error: 'Assignments must use teams in the pre-scout list.' }, { status: 400 });
      }
      const teamKeys = [...new Set(rows.map((row) => row.team_key))];
      const { data: existing } = await db.from(TABLE).select('team_key, assigned_user').eq('event_key', eventKey).in('team_key', teamKeys);
      const previous = new Map((existing || []).map((row) => [row.team_key, row.assigned_user]));
      const { data: updated, error } = await db
        .from(TABLE)
        .upsert(rows, { onConflict: 'event_key,team_key' })
        .select('id, team_key, assigned_user');
      if (error) return json({ error: error.message }, { status: 500 });
      for (const row of updated || []) {
        if (row.assigned_user && row.assigned_user !== previous.get(row.team_key)) {
          await notifyPrescoutAssignment({ assignmentId: row.id, userId: row.assigned_user, teamKey: row.team_key });
        }
      }
      return json({ success: true });
    }
    if (action === 'unassign') {
      const teamKey = normalizeTeamKey(body?.team_key);
      if (!teamKey) return json({ error: 'team_key required' }, { status: 400 });
      const { data: existing } = await db.from(TABLE).select('assigned_user').eq('event_key', eventKey).eq('team_key', teamKey).maybeSingle();
      const { error } = await db.from(TABLE).delete().eq('event_key', eventKey).eq('team_key', teamKey);
      if (error) return json({ error: error.message }, { status: 500 });
      if (existing?.assigned_user) {
        await notifyScoutUnassignment({ userId: existing.assigned_user, teamKey, kind: 'prescout' });
      }
      return json({ success: true });
    }
    return json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    return json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
