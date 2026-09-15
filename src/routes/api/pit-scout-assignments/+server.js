import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { notifyPitAssignment, notifyScoutUnassignment } from '$lib/server/slack_notifications.js';

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

function normalizePerms(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value) return [String(value)];
  return [];
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function keySet(keys) {
  return new Set((keys || []).map(normalizeKey).filter(Boolean));
}

// Pit scouting has no dedicated roster role today - same situation Quick
// Scout was in (see /api/scout-assignments' own computeScoutingAccess
// comment) - reuse Data Scout's admin/lead/member recognition rather than
// inventing a new roster key nobody can grant yet.
function computePitAccess(profile, rosterKeys) {
  const perms = new Set(normalizePerms(profile?.permissions));
  const keys = keySet(rosterKeys);
  const isAdmin = profile?.role === 'admin';
  const isCompetitionLead = String(profile?.team_role || '').trim().toLowerCase() === 'competition lead';

  const hasLeadKey = keys.has('scouting admin') || keys.has('data scout lead') || keys.has('scouting lead');
  const hasMemberKey = keys.has('data scout member') || hasLeadKey;

  const canEdit = isAdmin || isCompetitionLead || perms.has('DATA_SCOUT_ADMIN') || hasLeadKey;
  const canAssign = canEdit || perms.has('DATA_SCOUT_MEMBER') || hasMemberKey;

  return { canEdit, canAssign, rosterKeys: [...keys] };
}

function isEligibleKey(keyName) {
  const key = normalizeKey(keyName);
  return key === 'data scout member' || key === 'data scout lead' || key === 'scouting lead' || key === 'scouting admin';
}

async function fetchActorProfile(supa) {
  const { data: authRes } = await supa.auth.getUser();
  const actorId = authRes?.user?.id || null;
  if (!actorId) return { actorId: null, profile: null };

  const { data: profileRow } = await supa
    .from('user_profiles')
    .select('id, role, permissions, team_role')
    .eq('id', actorId)
    .single();

  return {
    actorId,
    profile: {
      id: actorId,
      role: profileRow?.role || 'member',
      permissions: normalizePerms(profileRow?.permissions),
      team_role: profileRow?.team_role || null
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
  return (data || [])
    .map((row) => row?.key?.key_name)
    .filter(Boolean)
    .map(String);
}

async function listEligibleUsers(db) {
  const { data, error } = await db
    .from('roster_entries')
    .select('user_id, key:key_id(key_name), user:user_id(id, full_name, email, banned)');

  if (error) throw error;

  const map = new Map();
  for (const row of data || []) {
    if (!isEligibleKey(row?.key?.key_name)) continue;
    const user = row?.user;
    if (!user?.id || user?.banned) continue;
    if (!map.has(user.id)) {
      map.set(user.id, {
        id: user.id,
        full_name: user.full_name || null,
        email: user.email || null
      });
    }
  }

  return [...map.values()].sort((a, b) => {
    const aName = (a.full_name || a.email || '').toLowerCase();
    const bName = (b.full_name || b.email || '').toLowerCase();
    return aName.localeCompare(bName);
  });
}

/*
  Pit scouting assignments API - which scout is responsible for pit
  scouting which competition team, scoped per event (see
  scout_pit_assignments' own migration comment for why it's a dedicated
  table rather than reusing scout_match_assignments' match_key column).

  GET /api/pit-scout-assignments?event_key=..
  GET /api/pit-scout-assignments?capabilities=1
  GET /api/pit-scout-assignments?eligible=1

  POST actions:
    assign:      { event_key, team_key, user_id }
    bulk-assign: { event_key, items:[{team_key, user_id}...] }
    unassign:    { event_key, team_key }
*/

export async function GET({ url, request }) {
  try {
    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const { actorId, profile } = await fetchActorProfile(authSupa);
    if (!actorId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rosterKeys = actorId ? await fetchRosterKeysForUser(db, actorId) : [];
    const access = computePitAccess(profile, rosterKeys);

    if (url.searchParams.get('capabilities')) {
      return json({
        success: true,
        data: {
          can_view: true,
          can_edit: access.canEdit,
          can_be_assigned: access.canAssign,
          roster_keys: access.rosterKeys
        }
      });
    }

    if (url.searchParams.get('eligible')) {
      if (!access.canEdit) return json({ error: 'Forbidden' }, { status: 403 });
      const users = await listEligibleUsers(db);
      return json({ success: true, data: users });
    }

    const eventKey = url.searchParams.get('event_key');
    if (!eventKey) return json({ error: 'event_key required' }, { status: 400 });

    const { data, error } = await db
      .from('scout_pit_assignments')
      .select('id, event_key, team_key, assigned_user, completed_at')
      .eq('event_key', eventKey)
      .order('team_key', { ascending: true });

    if (error) return json({ error: error.message }, { status: 500 });

    const ids = Array.from(new Set((data || []).map((r) => r.assigned_user).filter(Boolean)));
    const nameMap = {};

    if (ids.length > 0) {
      const { data: users, error: uErr } = await db
        .from('user_profiles')
        .select('id, full_name, email')
        .in('id', ids);

      if (!uErr) {
        for (const u of users || []) {
          nameMap[u.id] = u.full_name || u.email || null;
        }
      }
    }

    const rows = (data || []).map((r) => ({
      id: r.id,
      event_key: r.event_key,
      team_key: r.team_key,
      assigned_user: r.assigned_user,
      completed_at: r.completed_at,
      user_name: r.assigned_user ? nameMap[r.assigned_user] ?? null : null
    }));

    return json({ success: true, data: rows });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const action = body?.action;
    const eventKey = body?.event_key;
    if (!eventKey) return json({ error: 'event_key required' }, { status: 400 });

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const { actorId, profile } = await fetchActorProfile(authSupa);
    if (!actorId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rosterKeys = actorId ? await fetchRosterKeysForUser(db, actorId) : [];
    const access = computePitAccess(profile, rosterKeys);

    if (!access.canEdit) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action === 'assign') {
      const { team_key, user_id } = body;
      if (!team_key || !user_id) {
        return json({ error: 'team_key, user_id required' }, { status: 400 });
      }

      const { data: existing } = await db
        .from('scout_pit_assignments')
        .select('id, assigned_user')
        .eq('event_key', eventKey)
        .eq('team_key', team_key)
        .maybeSingle();

      const { data: upserted, error } = await db
        .from('scout_pit_assignments')
        .upsert({ event_key: eventKey, team_key, assigned_user: user_id }, { onConflict: 'event_key,team_key' })
        .select('id, assigned_user')
        .single();

      if (error) return json({ error: error.message }, { status: 500 });

      if (upserted?.assigned_user && upserted.assigned_user !== existing?.assigned_user) {
        await notifyPitAssignment({ assignmentId: upserted.id, userId: upserted.assigned_user, teamKey: team_key });
      }
      return json({ success: true });
    }

    if (action === 'bulk-assign') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return json({ error: 'items required' }, { status: 400 });

      const rows = items.map((i) => ({
        event_key: eventKey,
        team_key: i.team_key,
        assigned_user: i.user_id
      }));

      const teamKeys = [...new Set(items.map((i) => i.team_key))];

      let prevMap = new Map();
      if (teamKeys.length) {
        const { data: existingRows } = await db
          .from('scout_pit_assignments')
          .select('id, team_key, assigned_user')
          .eq('event_key', eventKey)
          .in('team_key', teamKeys);

        prevMap = new Map((existingRows || []).map((row) => [row.team_key, row]));
      }

      const { data: updatedRows, error } = await db
        .from('scout_pit_assignments')
        .upsert(rows, { onConflict: 'event_key,team_key' })
        .select('id, team_key, assigned_user');

      if (error) return json({ error: error.message }, { status: 500 });

      for (const row of updatedRows || []) {
        const prev = prevMap.get(row.team_key)?.assigned_user;
        if (row.assigned_user && row.assigned_user !== prev) {
          await notifyPitAssignment({ assignmentId: row.id, userId: row.assigned_user, teamKey: row.team_key });
        }
      }
      return json({ success: true });
    }

    if (action === 'unassign') {
      const { team_key } = body;
      if (!team_key) return json({ error: 'team_key required' }, { status: 400 });

      const { data: existing } = await db
        .from('scout_pit_assignments')
        .select('assigned_user')
        .eq('event_key', eventKey)
        .eq('team_key', team_key)
        .maybeSingle();

      const { error } = await db
        .from('scout_pit_assignments')
        .delete()
        .eq('event_key', eventKey)
        .eq('team_key', team_key);

      if (error) return json({ error: error.message }, { status: 500 });

      if (existing?.assigned_user) {
        await notifyScoutUnassignment({ userId: existing.assigned_user, teamKey: team_key, kind: 'pit' });
      }
      return json({ success: true });
    }

    return json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
