import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { notifyScoutAssignment } from '$lib/server/slack_notifications.js';

const SCOUTING_TYPES = new Set(['data', 'note', 'quick']);

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

function computeScoutingAccess(profile, rosterKeys) {
  const perms = new Set(normalizePerms(profile?.permissions));
  const keys = keySet(rosterKeys);
  const isAdmin = profile?.role === 'admin';
  const isCompetitionLead = String(profile?.team_role || '').trim().toLowerCase() === 'competition lead';

  const hasDataLeadKey = keys.has('scouting admin') || keys.has('data scout lead') || keys.has('scouting lead');
  const hasNoteLeadKey = keys.has('note scout lead') || hasDataLeadKey;
  const hasDataMemberKey = keys.has('data scout member') || hasDataLeadKey;
  const hasNoteMemberKey = keys.has('note scout member') || hasDataMemberKey || hasNoteLeadKey;

  const canEditData = isAdmin || isCompetitionLead || perms.has('DATA_SCOUT_ADMIN') || hasDataLeadKey;
  const canEditNote = isAdmin || isCompetitionLead || perms.has('NOTE_SCOUT_ADMIN') || hasNoteLeadKey;
  // Quick Scout is a lighter-weight mode of the same data-scouting role, not a
  // separate team function - reuse Data Scout's eligibility/roster keys
  // rather than inventing a new roster key. Easy to split out later if that
  // turns out wrong.
  const canEditQuick = canEditData;

  return {
    canEditData,
    canEditNote,
    canEditQuick,
    canAssignData: canEditData || perms.has('DATA_SCOUT_MEMBER') || hasDataMemberKey,
    canAssignNote: canEditNote || perms.has('DATA_SCOUT_MEMBER') || hasNoteMemberKey,
    canAssignQuick: canEditQuick || perms.has('DATA_SCOUT_MEMBER') || hasDataMemberKey,
    rosterKeys: [...keys]
  };
}

function canEditForType(access, scoutingType) {
  if (scoutingType === 'note') return access.canEditNote;
  if (scoutingType === 'quick') return access.canEditQuick;
  return access.canEditData;
}

function canAssignForType(access, scoutingType) {
  if (scoutingType === 'note') return access.canAssignNote;
  if (scoutingType === 'quick') return access.canAssignQuick;
  return access.canAssignData;
}

function isEligibleKeyForType(scoutingType, keyName) {
  const key = normalizeKey(keyName);
  if (!key) return false;
  if (scoutingType === 'data' || scoutingType === 'quick') {
    return key === 'data scout member' || key === 'data scout lead' || key === 'scouting lead' || key === 'scouting admin';
  }
  return (
    key === 'note scout member' ||
    key === 'note scout lead' ||
    key === 'data scout member' ||
    key === 'data scout lead' ||
    key === 'scouting lead' ||
    key === 'scouting admin'
  );
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

async function listEligibleUsersForType(db, scoutingType) {
  const { data, error } = await db
    .from('roster_entries')
    .select('user_id, key:key_id(key_name), user:user_id(id, full_name, email, banned)');

  if (error) throw error;

  const map = new Map();
  for (const row of data || []) {
    if (!isEligibleKeyForType(scoutingType, row?.key?.key_name)) continue;
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
  Scouting assignments API
  GET /api/scout-assignments?scouting_type=data|note|quick
  GET /api/scout-assignments?scouting_type=..&user_id=..&mine=1
  GET /api/scout-assignments?scouting_type=..&capabilities=1
  GET /api/scout-assignments?scouting_type=..&eligible=1

  POST actions:
    assign-single: { scouting_type, match_key, team_key, user_id }
    assign-robot:  { scouting_type, team_key, user_id }
    bulk-assign:   { scouting_type, items:[{match_key, team_key, user_id}...] }
    complete:      { scouting_type, match_key, team_key, user_id }
*/

export async function GET({ url, request }) {
  try {
    const scouting_type = String(url.searchParams.get('scouting_type') || '').toLowerCase();
    if (!SCOUTING_TYPES.has(scouting_type)) {
      return json({ error: 'scouting_type required (data|note|quick)' }, { status: 400 });
    }

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const { actorId, profile } = await fetchActorProfile(authSupa);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    if (!isLocal && !actorId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rosterKeys = actorId ? await fetchRosterKeysForUser(db, actorId) : [];
    const access = computeScoutingAccess(profile, rosterKeys);

    if (url.searchParams.get('capabilities')) {
      return json({
        success: true,
        data: {
          can_view: true,
          can_edit: canEditForType(access, scouting_type),
          can_be_assigned: canAssignForType(access, scouting_type),
          roster_keys: access.rosterKeys
        }
      });
    }

    if (url.searchParams.get('eligible')) {
      if (!canEditForType(access, scouting_type)) {
        return json({ error: 'Forbidden' }, { status: 403 });
      }
      const users = await listEligibleUsersForType(db, scouting_type);
      return json({ success: true, data: users });
    }

    const mine = !!url.searchParams.get('mine');
    const reqUserId = url.searchParams.get('user_id') || null;
    const base = db
      .from('scout_match_assignments')
      .select('id, scouting_type, match_key, team_key, assigned_user, completed_at')
      .eq('scouting_type', scouting_type);

    if (mine) {
      if (!reqUserId) return json({ error: 'user_id required' }, { status: 400 });
      if (!isLocal && reqUserId !== actorId) return json({ error: 'Forbidden' }, { status: 403 });
      base
        .eq('assigned_user', reqUserId)
        .order('completed_at', { ascending: true })
        .order('match_key', { ascending: true });
    } else {
      base.order('match_key', { ascending: true }).limit(5000);
    }

    const { data, error } = await base;
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
      scouting_type: r.scouting_type,
      match_key: r.match_key,
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

export async function POST({ request, url }) {
  try {
    const body = await request.json();
    const action = body?.action;
    const scouting_type = String(body?.scouting_type || '').toLowerCase();
    if (!SCOUTING_TYPES.has(scouting_type)) {
      return json({ error: 'scouting_type required (data|note|quick)' }, { status: 400 });
    }

    const authSupa = getClientFromRequest(request);
    const db = getDbClient(authSupa);
    const { actorId, profile } = await fetchActorProfile(authSupa);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    if (!isLocal && !actorId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rosterKeys = actorId ? await fetchRosterKeysForUser(db, actorId) : [];
    const access = computeScoutingAccess(profile, rosterKeys);

    if (action !== 'complete' && !isLocal && !canEditForType(access, scouting_type)) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action === 'assign-single') {
      const { match_key, team_key, user_id } = body;
      if (!match_key || !team_key || !user_id) {
        return json({ error: 'match_key, team_key, user_id required' }, { status: 400 });
      }

      const { data: existing } = await db
        .from('scout_match_assignments')
        .select('id, assigned_user')
        .eq('scouting_type', scouting_type)
        .eq('match_key', match_key)
        .eq('team_key', team_key)
        .maybeSingle();

      const { data: upserted, error } = await db
        .from('scout_match_assignments')
        .upsert({ scouting_type, match_key, team_key, assigned_user: user_id }, { onConflict: 'scouting_type,match_key,team_key' })
        .select('id, assigned_user')
        .single();

      if (error) return json({ error: error.message }, { status: 500 });

      if (upserted?.assigned_user && upserted.assigned_user !== existing?.assigned_user) {
        await notifyScoutAssignment({
          assignmentId: upserted.id,
          userId: upserted.assigned_user,
          matchKey: match_key,
          teamKey: team_key,
          scoutingType: scouting_type
        });
      }
      return json({ success: true });
    }

    if (action === 'assign-robot') {
      const { team_key, user_id } = body;
      if (!team_key || !user_id) return json({ error: 'team_key, user_id required' }, { status: 400 });

      const { data: existingRows } = await db
        .from('scout_match_assignments')
        .select('id, match_key, team_key, assigned_user')
        .eq('scouting_type', scouting_type)
        .eq('team_key', team_key);

      const prevMap = new Map((existingRows || []).map((row) => [`${row.match_key}:${row.team_key}`, row]));

      const { data: existing, error: selErr } = await db
        .from('scout_match_assignments')
        .select('match_key')
        .eq('scouting_type', scouting_type)
        .eq('team_key', team_key);

      if (selErr) return json({ error: selErr.message }, { status: 500 });

      for (const row of existing || []) {
        const { data: upserted, error } = await db
          .from('scout_match_assignments')
          .upsert({ scouting_type, match_key: row.match_key, team_key, assigned_user: user_id }, { onConflict: 'scouting_type,match_key,team_key' })
          .select('id, assigned_user')
          .single();

        if (error) return json({ error: error.message }, { status: 500 });

        const prev = prevMap.get(`${row.match_key}:${team_key}`)?.assigned_user;
        if (upserted?.assigned_user && upserted.assigned_user !== prev) {
          await notifyScoutAssignment({
            assignmentId: upserted.id,
            userId: upserted.assigned_user,
            matchKey: row.match_key,
            teamKey: team_key,
            scoutingType: scouting_type
          });
        }
      }
      return json({ success: true });
    }

    if (action === 'bulk-assign') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return json({ error: 'items required' }, { status: 400 });

      const rows = items.map((i) => ({
        scouting_type,
        match_key: i.match_key,
        team_key: i.team_key,
        assigned_user: i.user_id
      }));

      const matchKeys = [...new Set(items.map((i) => i.match_key))];
      const teamKeys = [...new Set(items.map((i) => i.team_key))];

      let prevMap = new Map();
      if (matchKeys.length && teamKeys.length) {
        const { data: existingRows } = await db
          .from('scout_match_assignments')
          .select('id, match_key, team_key, assigned_user')
          .eq('scouting_type', scouting_type)
          .in('match_key', matchKeys)
          .in('team_key', teamKeys);

        prevMap = new Map((existingRows || []).map((row) => [`${row.match_key}:${row.team_key}`, row]));
      }

      const { data: updatedRows, error } = await db
        .from('scout_match_assignments')
        .upsert(rows, { onConflict: 'scouting_type,match_key,team_key' })
        .select('id, match_key, team_key, assigned_user');

      if (error) return json({ error: error.message }, { status: 500 });

      for (const row of updatedRows || []) {
        const prev = prevMap.get(`${row.match_key}:${row.team_key}`)?.assigned_user;
        if (row.assigned_user && row.assigned_user !== prev) {
          await notifyScoutAssignment({
            assignmentId: row.id,
            userId: row.assigned_user,
            matchKey: row.match_key,
            teamKey: row.team_key,
            scoutingType: scouting_type
          });
        }
      }
      return json({ success: true });
    }

    if (action === 'complete') {
      const { match_key, team_key, user_id } = body;
      if (!match_key || !team_key || !user_id) {
        return json({ error: 'match_key, team_key, user_id required' }, { status: 400 });
      }

      if (!isLocal && (!actorId || user_id !== actorId)) {
        return json({ error: 'Forbidden' }, { status: 403 });
      }

      const { data: row, error: rErr } = await db
        .from('scout_match_assignments')
        .select('assigned_user')
        .eq('scouting_type', scouting_type)
        .eq('match_key', match_key)
        .eq('team_key', team_key)
        .single();

      if (rErr) return json({ error: rErr.message }, { status: 500 });
      if (row.assigned_user !== user_id) return json({ error: 'Not owner' }, { status: 403 });

      const { error } = await db
        .from('scout_match_assignments')
        .update({ completed_at: new Date().toISOString() })
        .eq('scouting_type', scouting_type)
        .eq('match_key', match_key)
        .eq('team_key', team_key);

      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true });
    }

    return json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    return json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
