import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import {
  normalizeAutoPathFile,
  normalizeMatchScoutEntry,
  normalizePitProblemReport,
  normalizeTeamKey,
  requiresPitProblemReport,
  validatePitProblemHandoff
} from '$lib/server/matchScoutingSchema.js';
import { exportAutoPathImageToDrive } from '$lib/server/auto_path_drive_export.js';
import { notifyAcePitProblem } from '$lib/server/ace_pit_notifications.js';

// Backend for match scouting and the pit-problem handoff.
//
// Both existed only in the browser before this: the match scouting workspace
// had no server at all, and a flagged pit problem went to window.localStorage
// - which is per-device, so the pit crew it was written for could never see
// it. Everything here exists to get that data off the one phone it was
// entered on.

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

// Writes go through the service client for the same reason pitscout does:
// scouts are not granted direct table rights, and the route is the gate.
function writeClient(fallback) {
  try {
    return getSupabase();
  } catch {
    return fallback;
  }
}

async function actorFor(client) {
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

export async function GET({ request, url }) {
  const client = clientFor(request);
  const actor = await actorFor(client);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const db = writeClient(client);
  if (url.searchParams.get('resource') === 'start-photos') {
    const { data, error } = await db.from('scouting_settings').select('start_position_photos').eq('id', 1).maybeSingle();
    if (error) return json({ error: error.message }, { status: 500 });
    const photos = {};
    for (const [key, path] of Object.entries(data?.start_position_photos || {})) {
      if (typeof path !== 'string' || !path.startsWith('match-starts/')) continue;
      const { data: signed } = await db.storage.from('pit-scout-photos').createSignedUrl(path, 3600);
      if (signed?.signedUrl) photos[key] = signed.signedUrl;
    }
    return json({ success: true, data: photos });
  }
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });

  const resource = url.searchParams.get('resource') || 'entries';

  if (resource === 'auto-paths') {
    const teamKey = normalizeTeamKey(url.searchParams.get('team_key'));
    if (!teamKey) return json({ error: 'A valid team_key is required' }, { status: 400 });
    const { data, error } = await db
      .from('match_scout_auto_paths')
      .select('id, event_key, team_key, name, alliance, path, created_by, created_at, updated_at')
      .eq('event_key', eventKey)
      .eq('team_key', teamKey)
      .order('updated_at', { ascending: false });
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data });
  }

  if (resource === 'pit-problems') {
    // The pit crew's actual question is "what is still open", so unresolved
    // reports come first and newest-first within that.
    let query = db.from('pit_problem_reports').select('*').eq('event_key', eventKey);
    if (url.searchParams.get('open') === '1') query = query.eq('resolved', false);
    const teamKey = normalizeTeamKey(url.searchParams.get('team_key'));
    if (teamKey) query = query.eq('team_key', teamKey);
    const { data, error } = await query.order('resolved').order('created_at', { ascending: false });
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data });
  }

  let query = db.from('match_scout_entries').select('*').eq('event_key', eventKey);
  if (url.searchParams.get('mine') === '1') query = query.eq('created_by', actor.id);
  const teamKey = normalizeTeamKey(url.searchParams.get('team_key'));
  if (teamKey) query = query.eq('team_key', teamKey);
  const matchKey = String(url.searchParams.get('match_key') || '').trim();
  if (matchKey) query = query.eq('match_key', matchKey);
  const { data, error } = await query.order('match_key').order('team_key');
  if (error) return json({ error: error.message }, { status: 500 });
  const entries = data || [];
  const scoutIds = [...new Set(entries.map((entry) => entry.created_by).filter(Boolean))];
  const profiles = scoutIds.length
    ? await db.from('user_profiles').select('id,full_name,email').in('id', scoutIds)
    : { data: [], error: null };
  const scoutNames = new Map((profiles.data || []).map((profile) => [
    profile.id,
    profile.full_name || profile.email || profile.id
  ]));
  return json({
    success: true,
    data: entries.map((entry) => ({ ...entry, scout_name: entry.scout_name || scoutNames.get(entry.created_by) || null }))
  });
}

export async function POST({ request }) {
  const client = clientFor(request);
  const actor = await actorFor(client);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const action = body?.action;
  const db = writeClient(client);

  if (action === 'save-auto-path') {
    const { value, error: invalid } = normalizeAutoPathFile(body, actor.id);
    if (invalid) return json({ error: invalid }, { status: 400 });
    const { data, error } = await db
      .from('match_scout_auto_paths')
      .insert(value)
      .select('id, event_key, team_key, name, alliance, path, created_by, created_at, updated_at')
      .single();
    if (error?.code === '23505') {
      return json({ error: 'You already have a saved path with that name for this team. Choose a new name.' }, { status: 409 });
    }
    if (error) return json({ error: error.message }, { status: 500 });
    const driveExport = await exportAutoPathImageToDrive(data);
    return json({ success: true, data, drive_export: driveExport });
  }

  if (action === 'save-entry') {
    // All live submissions follow v2. The legacy normalizer exists only for
    // historical data; omitting form_version cannot bypass required answers.
    const { value, error: invalid } = normalizeMatchScoutEntry({ ...body, form_version: 2 }, actor.id);
    if (invalid) return json({ error: invalid }, { status: 400 });
    const handoffError = validatePitProblemHandoff(body);
    if (handoffError) return json({ error: handoffError }, { status: 400 });

    // Keyed on the scout as well as the match, so two people covering the
    // same robot both keep their observations instead of overwriting each
    // other, while one scout revising their own report updates it in place.
    const { data, error } = await db
      .from('match_scout_entries')
      .upsert(value, { onConflict: 'event_key,match_key,team_key,created_by' })
      .select('*')
      .single();
    if (error) return json({ error: error.message }, { status: 500 });

    let pitProblem = null;
    let aceNotification = null;
    if (body.teleop_robot_status === 'dead' || body.mechanical_break === true || body.report_pit_problem === true || requiresPitProblemReport(body.robot_disabled)) {
      const { value: report, error: reportInvalid } = normalizePitProblemReport({
        event_key: body.event_key,
        team_key: body.team_key,
        match_key: body.match_key,
        summary: body.pit_problem_summary,
        detail: body.pit_problem_detail,
        robot_disabled: value.robot_disabled
      }, actor.id);
      if (reportInvalid) return json({ error: reportInvalid }, { status: 400 });

      // Retrying a submission updates the same scout's still-open handoff
      // instead of filling the pit queue with duplicate reports.
      const { data: existing } = await db
        .from('pit_problem_reports')
        .select('id, slack_channel, slack_ts, slack_notified_at')
        .eq('event_key', report.event_key)
        .eq('team_key', report.team_key)
        .eq('match_key', report.match_key)
        .eq('source', 'Match scout')
        .eq('created_by', actor.id)
        .eq('resolved', false)
        .limit(1)
        .maybeSingle();

      const reportQuery = existing?.id
        ? db.from('pit_problem_reports').update({
            summary: report.summary,
            detail: report.detail,
            severity: report.severity
          }).eq('id', existing.id)
        : db.from('pit_problem_reports').insert(report);
      const { data: savedProblem, error: reportError } = await reportQuery.select('*').single();
      if (reportError) return json({ error: reportError.message }, { status: 500 });
      pitProblem = savedProblem;

      aceNotification = await notifyAcePitProblem(savedProblem, data.scout_name || actor.email);
      if (aceNotification.ok) {
        const slackDelivery = {
          slack_channel: aceNotification.channel,
          slack_ts: aceNotification.ts,
          slack_notified_at: new Date().toISOString()
        };
        const { error: slackTrackingError } = await db.from('pit_problem_reports').update(slackDelivery).eq('id', savedProblem.id);
        if (slackTrackingError) console.error('Failed to save ACE pit Slack delivery metadata', slackTrackingError.message);
        pitProblem = { ...savedProblem, ...slackDelivery };
      }
    }

    return json({ success: true, data, pit_problem: pitProblem, ace_notification: aceNotification });
  }

  if (action === 'report-pit-problem') {
    const { value, error: invalid } = normalizePitProblemReport(body, actor.id);
    if (invalid) return json({ error: invalid }, { status: 400 });
    const { data, error } = await db.from('pit_problem_reports').insert(value).select('*').single();
    if (error) return json({ error: error.message }, { status: 500 });
    const aceNotification = await notifyAcePitProblem(data, body.scout_name || actor.email);
    if (aceNotification.ok) {
      const slackDelivery = {
        slack_channel: aceNotification.channel,
        slack_ts: aceNotification.ts,
        slack_notified_at: new Date().toISOString()
      };
      const { error: slackTrackingError } = await db.from('pit_problem_reports').update(slackDelivery).eq('id', data.id);
      if (slackTrackingError) console.error('Failed to save ACE pit Slack delivery metadata', slackTrackingError.message);
      return json({ success: true, data: { ...data, ...slackDelivery }, ace_notification: aceNotification });
    }
    return json({ success: true, data, ace_notification: aceNotification });
  }

  if (action === 'delete-entry') {
    if (!body?.id) return json({ error: 'id is required' }, { status: 400 });

    // Removing someone's submitted report is meaningfully more sensitive
    // than submitting your own, so this checks scouting-admin-equivalent
    // access rather than just "logged in" - same bar as publishing scout
    // assignments (see computeScoutingAccess in api/scout-assignments).
    const { data: profileRow } = await db
      .from('user_profiles')
      .select('role, permissions, team_role')
      .eq('id', actor.id)
      .single();
    const { data: rosterRows } = await db
      .from('roster_entries')
      .select('key:key_id(key_name)')
      .eq('user_id', actor.id);
    const rosterKeys = new Set((rosterRows || []).map((row) => String(row?.key?.key_name || '').toLowerCase().trim()).filter(Boolean));
    const perms = new Set(Array.isArray(profileRow?.permissions) ? profileRow.permissions.map(String) : []);
    const isAdmin = profileRow?.role === 'admin';
    const isCompetitionLead = String(profileRow?.team_role || '').trim().toLowerCase() === 'competition lead';
    const hasLeadKey = rosterKeys.has('scouting admin') || rosterKeys.has('data scout lead') || rosterKeys.has('scouting lead');
    const canDelete = isAdmin || isCompetitionLead || perms.has('DATA_SCOUT_ADMIN') || perms.has('VIEW_ADMIN_PANEL') || hasLeadKey;
    if (!canDelete) return json({ error: 'Forbidden' }, { status: 403 });

    const { error } = await db.from('match_scout_entries').delete().eq('id', body.id);
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true });
  }

  if (action === 'resolve-pit-problem') {
    if (!body?.id) return json({ error: 'id is required' }, { status: 400 });
    const resolved = body.resolved !== false;
    const { data, error } = await db
      .from('pit_problem_reports')
      .update({
        resolved,
        // Reopening clears the resolution rather than leaving a stale one, so
        // "who closed this" always refers to the closure that is in force.
        resolved_by: resolved ? actor.id : null,
        resolved_at: resolved ? new Date().toISOString() : null
      })
      .eq('id', body.id)
      .select('*')
      .single();
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data });
  }

  return json({ error: 'Invalid action' }, { status: 400 });
}
