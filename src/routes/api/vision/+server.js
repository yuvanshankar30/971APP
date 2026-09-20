import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { getSupabase } from '$lib/server/971bot.js';
import { fetchTbaMatchRoster, fetchTbaMatchVideoSources } from '$lib/server/vision_reference.js';
import { buildVisionReleasePreview, VALID_CLIMB_POS } from '$lib/server/visionRelease.js';
import { evaluateVisionReadiness } from '$lib/visionReadiness.js';
import { estimateFuelFromShots, summarizeVision, teamVisionAnalytics } from '$lib/visionAnalytics.js';
import { modelApprovalStatus } from '$lib/server/visionModelApproval.js';

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

async function actorFor(client) {
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

const safeName = (value) => String(value || 'recording.mov').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-100);

// A runner is considered online if it's heartbeated more recently than this.
// vision_runner.py's own default poll interval is 10s (VISION_POLL_SECONDS);
// this is a generous multiple of that so one slow iteration (a big video
// download, a GPU busy on inference) doesn't flap a healthy runner offline.
const RUNNER_ONLINE_THRESHOLD_MS = 60_000;

export async function GET({ request, url }) {
  const client = clientFor(request);
  const actor = await actorFor(client);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const dashboardEventKey = url.searchParams.get('dashboard');
  if (dashboardEventKey) {
    const { data: matches, error } = await client
      .from('vision_matches')
      .select('id, match_key, status, vision_runs(id, status, model_name, model_version, created_at, completed_at, released_at)')
      .eq('event_key', dashboardEventKey)
      .order('match_key');
    if (error) return json({ error: error.message }, { status: 403 });

    const runIds = [];
    const runCounts = { total: 0, queued: 0, claimed: 0, processing: 0, complete: 0, failed: 0, cancelled: 0, released: 0 };
    for (const match of matches || []) {
      for (const run of match.vision_runs || []) {
        runCounts.total += 1;
        runIds.push(run.id);
        if (Object.hasOwn(runCounts, run.status)) runCounts[run.status] += 1;
        if (run.released_at) runCounts.released += 1;
      }
    }

    const { data: discrepancies } = runIds.length
      ? await client.from('vision_discrepancies').select('id, severity, status').in('vision_run_id', runIds)
      : { data: [] };
    const discrepancyCounts = { total: (discrepancies || []).length, open: 0, open_critical: 0, resolved: 0 };
    for (const discrepancy of discrepancies || []) {
      if (discrepancy.status === 'open') {
        discrepancyCounts.open += 1;
        if (discrepancy.severity === 'critical') discrepancyCounts.open_critical += 1;
      } else {
        discrepancyCounts.resolved += 1;
      }
    }

    const [{ data: runners }, { count: queueDepth }] = await Promise.all([
      client.from('vision_runners').select('*').order('runner_id'),
      client.from('vision_runs').select('id', { count: 'exact', head: true }).eq('status', 'queued')
    ]);
    const now = Date.now();
    const fleet = (runners || []).map((runner) => ({
      ...runner,
      online: runner.last_seen_at ? (now - new Date(runner.last_seen_at).getTime()) < RUNNER_ONLINE_THRESHOLD_MS : false
    }));

    return json({
      success: true,
      data: {
        event_key: dashboardEventKey,
        matches_total: (matches || []).length,
        matches_complete: (matches || []).filter((match) => match.status === 'complete').length,
        runs: runCounts,
        discrepancies: discrepancyCounts,
        queue_depth: queueDepth ?? 0,
        runners: fleet
      }
    });
  }

  let id = url.searchParams.get('id');
  const lookupEventKey = url.searchParams.get('event_key');
  const lookupMatchKey = url.searchParams.get('match_key');
  if (!id && lookupEventKey && lookupMatchKey) {
    // A caller (e.g. the Strategy match detail panel) that only knows the
    // TBA event/match key, not this table's own id - resolve it here so it
    // can reuse the exact same single-match response built below instead of
    // fetching the unfiltered "list every vision_matches row" branch.
    const { data: lookup } = await client.from('vision_matches').select('id').eq('event_key', lookupEventKey).eq('match_key', lookupMatchKey).maybeSingle();
    if (!lookup) return json({ success: true, data: null });
    id = lookup.id;
  }
  if (!id) {
    const { data, error } = await client.from('vision_matches').select('*, vision_views(count), vision_runs(id,status,model_name,model_version,created_at)').order('created_at', { ascending: false });
    if (error) return json({ error: error.message }, { status: 403 });
    return json({ success: true, data });
  }
  const [{ data: match, error }, { data: rawViews }, { data: runs }, { data: videoSources }] = await Promise.all([
    client.from('vision_matches').select('*').eq('id', id).single(),
    client.from('vision_views').select('*').eq('vision_match_id', id).order('created_at'),
    client.from('vision_runs').select('*').eq('vision_match_id', id).order('created_at', { ascending: false }),
    client.from('vision_video_sources').select('*').eq('vision_match_id', id).order('created_at')
  ]);
  if (error) return json({ error: error.message }, { status: 404 });
  const views = [];
  for (const view of rawViews || []) {
    const { data: signed } = await client.storage.from('vision-recordings').createSignedUrl(view.storage_path, 900);
    views.push({ ...view, signed_url: signed?.signedUrl || null });
  }
  const runId = url.searchParams.get('run_id') || runs?.[0]?.id;
  let tracks = [], observations = [], discrepancies = [], qwenClips = [], shotEstimates = {};
  if (runId) {
    const results = await Promise.all([
      client.from('vision_tracks').select('*').eq('vision_run_id', runId),
      client.from('vision_observations').select('*').eq('vision_run_id', runId).order('started_ms'),
      client.from('vision_discrepancies').select('*').eq('vision_run_id', runId).order('created_at'),
      client.from('vision_qwen_clips').select('id,view_id,started_ms,ended_ms,model,revision,dtype,latency_ms,clip_quality,event_count,normalized_result,created_at').eq('vision_run_id', runId).order('started_ms'),
      client.from('vision_reference_snapshots').select('payload').eq('vision_run_id', runId).eq('source', 'tba').maybeSingle()
    ]);
    tracks = results[0].data || [];
    observations = results[1].data || [];
    discrepancies = results[2].data || [];
    qwenClips = results[3].data || [];
    const reference = results[4].data?.payload;
    if (reference) {
      const primary = observations.filter((observation) => observation.source !== 'qwen3_vl');
      shotEstimates = estimateFuelFromShots(summarizeVision(primary, tracks), reference);
    }
  }
  const teamAnalytics = teamVisionAnalytics(tracks, observations);
  return json({ success: true, data: { match, views: views || [], videoSources: videoSources || [], runs: runs || [], tracks, observations, discrepancies, qwenClips, shotEstimates, teamAnalytics } });
}

export async function POST({ request }) {
  const client = clientFor(request);
  const actor = await actorFor(client);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const action = body?.action;

  if (action === 'create-match') {
    if (!body.event_key || !body.match_key) return json({ error: 'event_key and match_key required' }, { status: 400 });
    // Best-effort: a missing TBA key or a match TBA doesn't know about yet
    // must not block creating the match. Review falls back to free text.
    const roster = await fetchTbaMatchRoster(body.match_key, env.TBA_API_KEY || env.PUBLIC_TBA_API_KEY);
    const { data, error } = await client.from('vision_matches').insert({
      event_key: body.event_key, match_key: body.match_key,
      capture_notes: body.capture_notes || null, created_by: actor.id,
      team_roster: roster || {}
    }).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data });
  }

  // Schedules change before a match is played, and a match created without a
  // TBA key (or before TBA had the match) has an empty roster.
  if (action === 'refresh-roster') {
    if (!body.id || !body.match_key) return json({ error: 'match id and match_key required' }, { status: 400 });
    const roster = await fetchTbaMatchRoster(body.match_key, env.TBA_API_KEY || env.PUBLIC_TBA_API_KEY);
    if (!roster) return json({ error: 'The Blue Alliance had no roster for that match key' }, { status: 404 });
    const { data, error } = await client.from('vision_matches').update({ team_roster: roster }).eq('id', body.id).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data });
  }

  if (action === 'resolve-video-sources') {
    if (!body.id) return json({ error: 'match id required' }, { status: 400 });
    const { data: sourceMatch, error: sourceMatchError } = await client.from('vision_matches').select('match_key').eq('id', body.id).single();
    if (sourceMatchError || !sourceMatch?.match_key) return json({ error: 'Vision match not found' }, { status: 404 });
    const sources = await fetchTbaMatchVideoSources(sourceMatch.match_key, env.TBA_API_KEY || env.PUBLIC_TBA_API_KEY);
    if (sources == null) return json({ error: 'The Blue Alliance video lookup failed' }, { status: 502 });
    if (sources.length) {
      const rows = sources.map((source) => ({
        vision_match_id: body.id, provider: source.provider, external_id: source.external_id,
        url: source.url, label: source.label, provenance: source.provenance,
        review_only: true, calibrated: false, saved_by: actor.id
      }));
      const { error } = await client.from('vision_video_sources').upsert(rows, { onConflict: 'vision_match_id,url' });
      if (error) return json({ error: error.message }, { status: 400 });
    }
    return json({ success: true, data: sources });
  }

  if (action === 'add-view') {
    if (!body.vision_match_id || !body.file_name || !body.label) return json({ error: 'vision_match_id, label, and file_name required' }, { status: 400 });
    const { data: match, error: matchError } = await client.from('vision_matches').select('event_key,match_key').eq('id', body.vision_match_id).single();
    if (matchError) return json({ error: matchError.message }, { status: 404 });
    const storagePath = `${match.event_key}/${match.match_key}/${crypto.randomUUID()}-${safeName(body.file_name)}`;
    const { data: view, error } = await client.from('vision_views').insert({
      vision_match_id: body.vision_match_id, label: body.label, storage_path: storagePath,
      camera_position: body.camera_position || null, frame_rate: body.frame_rate || null,
      width: body.width || null, height: body.height || null, sync_offset_ms: body.sync_offset_ms || 0,
      homography: body.homography || null, calibration_points: body.calibration_points || [],
      field_mask: body.field_mask || null, goal_zones: body.goal_zones || []
    }).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    const { data: upload, error: uploadError } = await client.storage.from('vision-recordings').createSignedUploadUrl(storagePath);
    if (uploadError) return json({ error: uploadError.message }, { status: 500 });
    return json({ success: true, data: { view, upload } });
  }

  // A run that dies mid-processing otherwise sits in `processing` forever:
  // the runner only terminates runs it is actively working, so a crashed or
  // reassigned worker leaves one wedged with no way out and no way to try the
  // match again. Cancelling is a compare-and-swap against the statuses that
  // can still be abandoned, so it can't stomp a run that just completed.
  if (action === 'cancel-run') {
    if (!body.id) return json({ error: 'run id required' }, { status: 400 });
    const { data, error } = await client.from('vision_runs')
      .update({ status: 'cancelled', error: body.reason || 'Cancelled by a reviewer', completed_at: new Date().toISOString() })
      .eq('id', body.id)
      .in('status', ['queued', 'claimed', 'processing'])
      .select('id, status');
    if (error) return json({ error: error.message }, { status: 400 });
    if (!data?.length) {
      return json({ error: 'That run already finished - only a queued, claimed or processing run can be cancelled' }, { status: 409 });
    }
    return json({ success: true, data: data[0] });
  }

  // Re-queue a match after a failed or cancelled run. Deliberately a new run
  // rather than resetting the old one: model identity and config are immutable
  // per run by design, and the failed attempt stays on the record.
  if (action === 'retry-run') {
    if (!body.id) return json({ error: 'run id required' }, { status: 400 });
    const { data: previous, error: readError } = await client.from('vision_runs').select('*').eq('id', body.id).single();
    if (readError) return json({ error: readError.message }, { status: 404 });
    if (!['failed', 'cancelled'].includes(previous.status)) {
      return json({ error: 'Only a failed or cancelled run can be retried' }, { status: 400 });
    }
    const { data, error } = await client.from('vision_runs').insert({
      vision_match_id: previous.vision_match_id,
      model_name: previous.model_name,
      model_version: previous.model_version,
      qwen_model: previous.qwen_model,
      qwen_revision: previous.qwen_revision,
      qwen_dtype: previous.qwen_dtype,
      config: previous.config || {},
      created_by: actor.id
    }).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    await client.from('vision_matches').update({ status: 'queued', updated_at: new Date().toISOString() }).eq('id', previous.vision_match_id);
    return json({ success: true, data });
  }

  // Calibration on an already-uploaded view. Separate from add-view because
  // calibration is drawn against the recording itself (see the Calibrate
  // panel), which by definition can't happen until the file is uploaded.
  if (action === 'update-view') {
    if (!body.id) return json({ error: 'view id required' }, { status: 400 });
    const updates = {};
    if (body.field_mask !== undefined) updates.field_mask = body.field_mask || null;
    if (body.goal_zones !== undefined) updates.goal_zones = body.goal_zones || [];
    if (body.start_zones !== undefined) updates.start_zones = body.start_zones || [];
    if (body.homography !== undefined) updates.homography = body.homography || null;
    if (body.calibration_points !== undefined) updates.calibration_points = body.calibration_points || [];
    if (body.sync_offset_ms !== undefined) updates.sync_offset_ms = Number(body.sync_offset_ms) || 0;
    if (!Object.keys(updates).length) return json({ error: 'Nothing to update' }, { status: 400 });
    const { data, error } = await client.from('vision_views').update(updates).eq('id', body.id).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data });
  }

  if (action === 'queue-run') {
    if (!body.vision_match_id || !body.model_name || !body.model_version) return json({ error: 'vision_match_id and model identity required' }, { status: 400 });
    const [{ data: views }, { data: match }, { data: runners }] = await Promise.all([
      client.from('vision_views').select('id, field_mask, goal_zones, homography, start_zones').eq('vision_match_id', body.vision_match_id),
      client.from('vision_matches').select('team_roster').eq('id', body.vision_match_id).single(),
      client.from('vision_runners').select('last_seen_at')
    ]);
    if (!views?.length) return json({ error: 'Upload at least one camera view first' }, { status: 400 });
    const now = Date.now();
    const readiness = evaluateVisionReadiness({
      match, views, modelName: body.model_name, modelVersion: body.model_version,
      runners: (runners || []).map((runner) => ({
        ...runner,
        online: runner.last_seen_at ? now - new Date(runner.last_seen_at).getTime() < RUNNER_ONLINE_THRESHOLD_MS : false
      }))
    });
    if (readiness.blocking.length) {
      return json({ error: readiness.blocking.map((check) => check.label).join('; '), readiness }, { status: 400 });
    }
    if (readiness.warnings.length && !body.acknowledge_readiness_warnings) {
      return json({ error: 'Acknowledge the vision readiness warnings before queueing a shadow run', readiness }, { status: 409 });
    }
    const { data, error } = await client.from('vision_runs').insert({
      vision_match_id: body.vision_match_id,
      model_name: body.model_name,
      model_version: body.model_version,
      qwen_model: body.qwen_model || 'Qwen/Qwen3-VL-30B-A3B-Instruct',
      qwen_revision: body.qwen_revision || '9c4b90e1e4ba969fd3b5378b57d966d725f1b86c',
      qwen_dtype: 'bfloat16',
      config: body.config || {},
      created_by: actor.id
    }).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    await client.from('vision_matches').update({ status: 'queued', updated_at: new Date().toISOString() }).eq('id', body.vision_match_id);
    return json({ success: true, data });
  }

  if (action === 'review') {
    const allowed = ['accepted_vision','accepted_reference','corrected','unobservable','dismissed'];
    if (!body.id || !allowed.includes(body.status)) return json({ error: 'Valid discrepancy id and status required' }, { status: 400 });
    const { data, error } = await client.from('vision_discrepancies').update({ status: body.status, reviewer_id: actor.id, review_notes: body.review_notes || null, reviewed_at: new Date().toISOString() }).eq('id', body.id).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data });
  }
  if (action === 'update-track') {
    if (!body.id) return json({ error: 'track id required' }, { status: 400 });
    const { data, error } = await client.from('vision_tracks').update({
      team_key: body.team_key || null,
      identity_confidence: body.team_key ? 1 : 0,
      needs_review: !body.team_key
    }).eq('id', body.id).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });

    // Naming a robot is the whole point of the identity editor, so push it
    // down to that robot's own events. Without this the assignment only ever
    // reached vision_tracks, summarizeVision reads team identity off the
    // observations, and release-run would emit nothing for a track a human
    // had just carefully identified. Observations already reviewed are left
    // alone - a human decision outranks a later bulk re-attribution.
    const { data: attributed, error: cascadeError } = await client
      .from('vision_observations')
      .update({ team_key: body.team_key || null })
      .eq('track_id', body.id)
      .eq('review_status', 'unreviewed')
      .select('id');
    if (cascadeError) return json({ error: cascadeError.message }, { status: 400 });
    return json({ success: true, data, attributed_observations: attributed?.length || 0 });
  }
  if (action === 'update-observation') {
    if (!body.id) return json({ error: 'observation id required' }, { status: 400 });
    const { data, error } = await client.from('vision_observations').update({
      team_key: body.team_key || null,
      value: body.value || {},
      confidence: Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : undefined
    }).eq('id', body.id).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data });
  }
  // Bulk review. A single match can produce dozens of observations across
  // several views, and clearing them one click at a time is slower than
  // scouting the match by hand - which would defeat the point of the tool.
  // Deliberately limited to the non-destructive verdicts: 'corrected' needs a
  // per-observation value and team, so it stays single-row only.
  if (action === 'review-observations') {
    const allowed = ['accepted', 'rejected', 'unobservable'];
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
    if (!ids.length || !allowed.includes(body.status)) {
      return json({ error: 'ids[] and a status of accepted, rejected or unobservable are required' }, { status: 400 });
    }
    if (ids.length > 500) return json({ error: 'Too many observations in one request (max 500)' }, { status: 400 });
    const { data, error } = await client.from('vision_observations').update({
      review_status: body.status,
      reviewer_id: actor.id,
      reviewed_at: new Date().toISOString()
    }).in('id', ids).select('id');
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data: { reviewed: data?.length || 0 } });
  }
  if (action === 'review-observation') {
    const allowed = ['accepted','corrected','rejected','unobservable'];
    if (!body.id || !allowed.includes(body.status)) return json({ error: 'Valid observation id and review status required' }, { status: 400 });
    const updates = {
      review_status: body.status,
      reviewer_id: actor.id,
      reviewed_at: new Date().toISOString()
    };
    if (body.status === 'corrected') {
      if (body.value && typeof body.value === 'object') updates.value = body.value;
      if (body.team_key !== undefined) updates.team_key = body.team_key || null;
    }
    const { data, error } = await client.from('vision_observations').update(updates).eq('id', body.id).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data });
  }

  if (['approve-model', 'revoke-model', 'set-event-model-policy'].includes(action)) {
    const { data: actorProfile } = await client.from('user_profiles').select('role, permissions').eq('id', actor.id).single();
    const canManage = actorProfile?.role === 'admin' || (actorProfile?.permissions || []).includes('VISION_RELEASE');
    if (!canManage) return json({ error: 'VISION_RELEASE permission required' }, { status: 403 });
    const db = getSupabase();
    if (action === 'set-event-model-policy') {
      if (!body.event_key) return json({ error: 'event_key required' }, { status: 400 });
      const { data, error } = await db.from('vision_event_policies').upsert({
        event_key: body.event_key, require_approved_model: Boolean(body.require_approved_model),
        updated_by: actor.id, updated_at: new Date().toISOString()
      }).select('*').single();
      if (error) return json({ error: error.message }, { status: 400 });
      return json({ success: true, data });
    }
    if (!body.model_name || !body.model_version) return json({ error: 'model_name and model_version required' }, { status: 400 });
    if (action === 'approve-model') {
      const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) return json({ error: 'expires_at must be a valid timestamp' }, { status: 400 });
      const { data, error } = await db.from('vision_model_approvals').upsert({
        model_name: body.model_name, model_version: body.model_version,
        approved_by: actor.id, approved_at: new Date().toISOString(), expires_at: expiresAt?.toISOString() || null,
        revoked_at: null, revoked_by: null, notes: body.notes || null
      }, { onConflict: 'model_name,model_version' }).select('*').single();
      if (error) return json({ error: error.message }, { status: 400 });
      return json({ success: true, data });
    }
    const { data, error } = await db.from('vision_model_approvals').update({
      revoked_at: new Date().toISOString(), revoked_by: actor.id
    }).eq('model_name', body.model_name).eq('model_version', body.model_version).select('*').single();
    if (error) return json({ error: error.message }, { status: 400 });
    return json({ success: true, data });
  }

  // Reviewed-result consumer: the one path that lets a project owner turn
  // advisory vision output into real scouting data. Every other action
  // above is available to any approved user; this one requires the
  // separate VISION_RELEASE permission (see permissions.js).
  if (action === 'preview-release' || action === 'release-run') {
    if (!body.run_id) return json({ error: 'run_id required' }, { status: 400 });

    const { data: actorProfile } = await client.from('user_profiles').select('role, permissions').eq('id', actor.id).single();
    const canRelease = actorProfile?.role === 'admin' || (actorProfile?.permissions || []).includes('VISION_RELEASE');
    if (!canRelease) return json({ error: 'VISION_RELEASE permission required' }, { status: 403 });

    const db = getSupabase(); // service role: writes to scout_data_events, a
    // table this actor's own RLS identity has no INSERT grant on (see
    // docs/guides/scoutingvision.md) - the permission check above is the real gate.
    const { data: run, error: runError } = await db.from('vision_runs').select('*, vision_matches(match_key,event_key)').eq('id', body.run_id).single();
    if (runError) return json({ error: runError.message }, { status: 404 });
    if (run.status !== 'complete') return json({ error: 'Only a completed run can be released' }, { status: 400 });
    if (run.released_at) return json({ error: 'This run has already been released' }, { status: 409 });

    const matchKey = run.vision_matches?.match_key;
    if (!matchKey) return json({ error: 'Run has no associated match' }, { status: 400 });

    const eventKey = run.vision_matches?.event_key;
    const { data: policy } = eventKey
      ? await db.from('vision_event_policies').select('require_approved_model').eq('event_key', eventKey).maybeSingle()
      : { data: null };
    if (policy?.require_approved_model) {
      const { data: approval } = await db.from('vision_model_approvals').select('approved_at,expires_at,revoked_at')
        .eq('model_name', run.model_name).eq('model_version', run.model_version).maybeSingle();
      const approvalStatus = modelApprovalStatus(policy, approval);
      if (!approvalStatus.allowed) {
        return json({ error: `Event policy blocks release: ${run.model_name} ${run.model_version} is ${approvalStatus.reason.replace('_', ' ')}` }, { status: 409 });
      }
    }

    const [{ data: tracks }, { data: observations }, { data: runViews }] = await Promise.all([
      db.from('vision_tracks').select('*').eq('vision_run_id', run.id),
      db.from('vision_observations').select('*').eq('vision_run_id', run.id),
      db.from('vision_views').select('id, start_zones').eq('vision_match_id', run.vision_match_id)
    ]);
    const { rows, skippedClimbs, teamCount } = buildVisionReleasePreview({
      matchKey, run, observations: observations || [], tracks: tracks || [], views: runViews || []
    });
    if (!rows.length) {
      return json({
        error: skippedClimbs.length
          ? `No releasable results: ${skippedClimbs.length} climb(s) have a level that isn't one of ${[...VALID_CLIMB_POS].join(', ')} - correct them in review, or set a default climb level on the run.`
          : 'No reviewed, attributable team results to release yet - accept/correct observations and resolve team identity first',
        skipped_climbs: skippedClimbs
      }, { status: 400 });
    }

    if (action === 'preview-release') {
      return json({ success: true, data: { rows, skipped_climbs: skippedClimbs, team_count: teamCount } });
    }
    if (body.preview_rows && JSON.stringify(body.preview_rows) !== JSON.stringify(rows)) {
      return json({ error: 'Reviewed results changed after the release preview. Preview the run again.' }, { status: 409 });
    }

    // One transaction for the scouting rows, the run's released_at, and the
    // audit entry (see 20260829_vision_release_atomic.sql). Doing these as
    // three REST calls meant a failure between them could leave real scouting
    // data with no release state and no provenance, and let two concurrent
    // releases both pass the already-released check and double every event.
    // The compare-and-swap inside the function is what makes the second
    // caller lose cleanly.
    const { data: released, error: releaseError } = await db.rpc('release_vision_run', {
      p_run_id: run.id,
      p_actor: actor.id,
      p_rows: rows,
      p_team_count: teamCount
    });
    if (releaseError) return json({ error: releaseError.message }, { status: 500 });
    if (!released?.ok) {
      return json({ error: 'This run has already been released' }, { status: 409 });
    }

    return json({ success: true, data: { released_count: released.released_count, skipped_climbs: skippedClimbs } });
  }

  return json({ error: 'Invalid action' }, { status: 400 });
}
