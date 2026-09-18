import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createClient } from '@supabase/supabase-js';
import { summarizeVision, trajectoryMetrics, reconcileWithReference, reconcileVisionSources, visionAutoPath } from '$lib/visionAnalytics.js';
import { fetchTbaMatchReference } from '$lib/server/vision_reference.js';
import { notifyVisionRunFailed, notifyVisionCriticalDiscrepancy } from '$lib/server/slack_notifications.js';

const serviceClient = () => createClient(env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const authorized = (request) => {
  const expected = env.VISION_RUNNER_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  return Boolean(expected && supplied && expected.length === supplied.length);
};

async function checkToken(request) {
  if (!authorized(request)) return false;
  const expected = new TextEncoder().encode(env.VISION_RUNNER_TOKEN);
  const supplied = new TextEncoder().encode(request.headers.get('authorization').replace(/^Bearer\s+/i, ''));
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ supplied[index];
  return difference === 0;
}

export async function POST({ request }) {
  if (!(await checkToken(request))) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const action = body?.action;
  const db = serviceClient();

  // Runner fleet visibility: every poll iteration (whether or not it claims
  // a job) reports in here, so "online" is derivable as "heartbeat within
  // the last couple poll intervals" without the runner needing its own
  // separate reporting loop. Uses the runner's own reported current queue
  // depth if it just checked, otherwise the caller (dashboard) computes it
  // fresh from vision_runs directly - this table is about runner liveness,
  // not a cache of queue state.
  if (action === 'heartbeat') {
    const runnerId = String(body.runner_id || '').trim();
    if (!runnerId) return json({ error: 'runner_id required' }, { status: 400 });
    const { error } = await db.from('vision_runners').upsert({
      runner_id: runnerId,
      last_seen_at: new Date().toISOString(),
      model_path: body.model_path || null,
      qwen_model: body.qwen_model || null,
      qwen_endpoint: body.qwen_endpoint || null,
      runtime_metrics: body.runtime_metrics || {},
      current_run_id: body.current_run_id || null,
      last_error: body.last_error || null
    }, { onConflict: 'runner_id' });
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true });
  }

  if (action === 'claim') {
    const runnerId = String(body.runner_id || '').trim();
    if (!runnerId) return json({ error: 'runner_id required' }, { status: 400 });
    const { data: candidates, error } = await db.from('vision_runs').select('id').eq('status', 'queued').order('created_at').limit(5);
    if (error) return json({ error: error.message }, { status: 500 });
    for (const candidate of candidates || []) {
      const { data: run } = await db.from('vision_runs').update({ status: 'claimed', claimed_by: runnerId, claimed_at: new Date().toISOString() }).eq('id', candidate.id).eq('status', 'queued').select('*, vision_matches(*)').single();
      if (!run) continue;
      const { data: views } = await db.from('vision_views').select('*').eq('vision_match_id', run.vision_match_id);
      const signedViews = [];
      for (const view of views || []) {
        const { data: signed } = await db.storage.from('vision-recordings').createSignedUrl(view.storage_path, 3600);
        signedViews.push({ ...view, signed_url: signed?.signedUrl || null });
      }
      return json({ run: { ...run, views: signedViews } });
    }
    return json({ run: null });
  }

  if (action === 'processing') {
    const { data, error } = await db.from('vision_runs').update({ status: 'processing', started_at: new Date().toISOString() }).eq('id', body.run_id).eq('status', 'claimed').select('id');
    if (error) return json({ error: error.message }, { status: 500 });
    if (!data?.length) return json({ error: 'Run was not claimable' }, { status: 409 });
    return json({ success: true });
  }

  if (action === 'complete') {
    const { data: run } = await db.from('vision_runs').select('*, vision_matches(match_key)').eq('id', body.run_id).single();
    if (!run || run.status !== 'processing') return json({ error: 'Run is not processing' }, { status: 409 });
    // track_key is the runner's own run-scoped handle for a robot
    // ("<view id>:<tracker id>"), not a column. Insert the tracks first, then
    // swap each observation's track_key for the real vision_tracks UUID, so
    // naming one robot in review can attribute every event it produced
    // instead of forcing a correction per observation. The key->id mapping
    // relies on INSERT ... RETURNING handing rows back in insertion order,
    // which Postgres guarantees for the single statement PostgREST issues.
    // auto_start_zone rides along in metrics rather than as its own column:
    // it's a derived per-track fact of exactly the same kind as the mobility
    // numbers already stored there, and the runner is the only place it can be
    // computed (see resolve_auto_start_zone for why).
    const tracks = (body.tracks || []).map(({ track_key, auto_start_zone, ...track }) => ({
      ...track,
      vision_run_id: run.id,
      metrics: {
        ...trajectoryMetrics(track.trajectory),
        ...(track.metrics || {}),
        autoStartZone: auto_start_zone || null,
        autoPathCandidate: visionAutoPath(track, { autoEndMs: Number(run.config?.auto_end_ms) || undefined })
      }
    }));
    const trackKeys = (body.tracks || []).map((track) => track.track_key || null);
    const qwenClips = (body.qwen_clips || []).map((clip) => ({ ...clip, vision_run_id: run.id }));
    const trackIdByKey = new Map();
    if (tracks.length) {
      const { data: insertedTracks, error } = await db.from('vision_tracks').insert(tracks).select('id');
      if (error) return json({ error: error.message }, { status: 500 });
      (insertedTracks || []).forEach((row, index) => {
        if (trackKeys[index]) trackIdByKey.set(trackKeys[index], row.id);
      });
    }
    const observations = (body.observations || []).map(({ track_key, ...observation }) => ({
      ...observation,
      vision_run_id: run.id,
      model_version: run.model_version,
      source: observation.source || 'legacy',
      review_status: 'unreviewed',
      track_id: (track_key && trackIdByKey.get(track_key)) || null
    }));
    if (observations.length) {
      const { error } = await db.from('vision_observations').insert(observations);
      if (error) return json({ error: error.message }, { status: 500 });
    }
    if (qwenClips.length) {
      const { error } = await db.from('vision_qwen_clips').insert(qwenClips);
      if (error) return json({ error: error.message }, { status: 500 });
    }
    const primaryObservations = observations.filter((observation) => observation.source !== 'qwen3_vl');
    const qwenObservations = observations.filter((observation) => observation.source === 'qwen3_vl');
    const summary = summarizeVision(primaryObservations, tracks);
    const qwenSummary = summarizeVision(qwenObservations, []);
    const reference = await fetchTbaMatchReference(run.vision_matches?.match_key, env.TBA_API_KEY || env.PUBLIC_TBA_API_KEY);
    if (reference) await db.from('vision_reference_snapshots').upsert({ vision_run_id: run.id, source: 'tba', match_key: run.vision_matches.match_key, payload: reference }, { onConflict: 'vision_run_id,source' });
    const referenceDiscrepancies = reference ? reconcileWithReference(summary, reference, run.config?.thresholds) : [];
    const sourceDiscrepancies = qwenObservations.length ? reconcileVisionSources(summary, qwenSummary, run.config?.thresholds) : [];
    const discrepancies = [...referenceDiscrepancies, ...sourceDiscrepancies].map((item) => ({ ...item, vision_run_id: run.id }));
    let insertedDiscrepancies = [];
    if (discrepancies.length) {
      const { data } = await db.from('vision_discrepancies').insert(discrepancies).select('id, severity');
      insertedDiscrepancies = data || [];
    }
    await Promise.all([
      db.from('vision_runs').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', run.id).eq('status', 'processing'),
      db.from('vision_matches').update({ status: discrepancies.length ? 'review' : 'complete', updated_at: new Date().toISOString() }).eq('id', run.vision_match_id)
    ]);
    // Fire-and-forget: a Slack delivery failure shouldn't fail the run's own
    // completion, which has already been committed above.
    for (const discrepancy of insertedDiscrepancies) {
      if (discrepancy.severity === 'critical') {
        notifyVisionCriticalDiscrepancy(discrepancy.id).catch((err) => console.error('notifyVisionCriticalDiscrepancy failed', err));
      }
    }
    return json({ success: true, summary, qwen_summary: qwenSummary, reference, discrepancy_count: discrepancies.length });
  }

  if (action === 'fail') {
    const { data } = await db.from('vision_runs').update({ status: 'failed', error: String(body.error || 'Runner failed'), completed_at: new Date().toISOString() }).eq('id', body.run_id).in('status', ['claimed','processing']).select('id');
    if (data?.length) {
      notifyVisionRunFailed(body.run_id).catch((err) => console.error('notifyVisionRunFailed failed', err));
    }
    return json({ success: true });
  }
  return json({ error: 'Invalid action' }, { status: 400 });
}
