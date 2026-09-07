// Job-claim API for the Fusion CAM Runner (autocam/fusion/runner/). Polled by
// an external Fusion 360 machine, not called from the browser - authenticated
// via a shared-secret bearer token (fusion_runner_auth.js), not a Supabase
// Auth session, so this uses the service-role client throughout (same
// pattern as api/drive-watcher/+server.js).
//
// Lifecycle mirrors what autocam/runner/README.md already documented before
// this existed: queued -> claimed -> processing -> completed/failed. Every
// transition is a compare-and-swap on cam_jobs.status, the exact idiom
// api/cam-generate/+server.js already uses for turning/routing jobs - a
// second concurrent caller's UPDATE matches zero rows and the API reports
// "already claimed" instead of two Runners double-processing the same job.
//
// Only cam_jobs rows with operation_type='milling' are ever visible here -
// turning/routing jobs stay exclusively on cam-generate's synchronous path,
// completely unaffected by this file.
import { buildJobPayload } from '$autocam/fusion/jobPayload.js';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createClient } from '@supabase/supabase-js';
import { isAuthorizedFusionRunnerRequest } from '$lib/server/fusion_runner_auth.js';
import { validateFusionNcFiles } from '$lib/server/fusion_nc_artifacts.js';
import { measureNcFileExtents } from '$lib/server/fusion_program_extents.js';

function getServiceSupabase() {
  const url = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new Error('Fusion Runner API is missing Supabase service configuration');
  return createClient(url, serviceKey);
}

// Completing a job deliberately does NOT copy its G-code into the Files
// tab. That is the "Post to Files" button's job in JobQueueTab.svelte, and
// it stays a deliberate human action - direct instruction, after an earlier
// automatic version filled the shared Files folders with output from test
// and retry jobs nobody wanted kept. The G-code is always safely on the
// completed cam_jobs row either way, so nothing is lost by waiting to be
// asked.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_CLAIM_MS = 15 * 60 * 1000;

// claimed_at doubles as the runner heartbeat. A workstation crash before
// Fusion begins work otherwise strands a job in claimed. Processing jobs are
// intentionally never retried automatically: Fusion may already have changed
// a document or exported an artifact, so retrying them could duplicate CAM
// work. Those require an operator's explicit review.
const TRANSIENT_FETCH_ERROR_RE = /fetch failed/i;
const STALE_REQUEUE_RETRY_ATTEMPTS = 3;
const STALE_REQUEUE_RETRY_DELAY_MS = 200;

async function requeueStaleFusionJobs(supabase) {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  let error;
  // Seen in production as every claim request failing 500 with
  // "Could not recover stale Fusion jobs: TypeError: fetch failed" - a
  // transient network blip between this server and Supabase, not a real
  // Postgres error. If it persists across polls, the runner (which already
  // retries claim failures on its own, see SpartanRoboticsAutoCAM.py) never
  // gets past this step to claim anything. Retrying the same update here
  // absorbs a one-off blip instead of failing the whole claim cycle on it.
  for (let attempt = 0; attempt < STALE_REQUEUE_RETRY_ATTEMPTS; attempt++) {
    ({ error } = await supabase.from('cam_jobs').update({
      status: 'queued',
      claimed_by: null,
      claimed_at: null,
      progress: 0,
      progress_message: 'Runner claim expired before processing; queued for retry'
    }).eq('operation_type', 'milling').eq('status', 'claimed').lt('claimed_at', cutoff));
    const isLastAttempt = attempt === STALE_REQUEUE_RETRY_ATTEMPTS - 1;
    if (!error || !TRANSIENT_FETCH_ERROR_RE.test(error.message || '') || isLastAttempt) break;
    await new Promise((resolve) => setTimeout(resolve, STALE_REQUEUE_RETRY_DELAY_MS * (attempt + 1)));
  }
  if (error) throw new Error(`Could not recover stale Fusion jobs: ${error.message}`);
}

// Claims the oldest queued milling job for this runner. Two-step: find a
// candidate, then CAS it - a plain "UPDATE ... ORDER BY ... LIMIT 1" isn't
// expressible via PostgREST, so this accepts a narrow, harmless race (two
// runners might both pick the SAME candidate id) that the CAS below always
// resolves correctly (only one caller's conditional UPDATE ever matches).
//
// machineId: a Runner declares which cam_machines row it
// physically is (autocam/fusion/runner/config.py's RUNNER_MACHINE_ID) and only
// claims jobs that are either unassigned to a specific machine
// (cam_jobs.machine_id IS NULL) or assigned to its own - so a router's
// Runner can't accidentally grab a job queued for the mill, and vice versa,
// once multiple physical machines are polling at once. It is required:
// claim-anything fallback can put a program on the wrong physical machine.
async function claimNextJob(supabase, runnerId, machineId) {
  let query = supabase
    .from('cam_jobs')
    .select('id')
    .eq('status', 'queued')
    .eq('operation_type', 'milling')
    .order('created_at', { ascending: true })
    .limit(5);
  query = query.or(`machine_id.is.null,machine_id.eq.${machineId}`);
  const { data: candidates, error: findError } = await query;
  if (findError) throw new Error(`Could not look up queued milling jobs: ${findError.message}`);
  if (!candidates?.length) return null;

  for (const candidate of candidates) {
    const { data: claimed, error: claimError } = await supabase
      .from('cam_jobs')
      .update({ status: 'claimed', claimed_by: runnerId, claimed_at: new Date().toISOString() })
      .eq('id', candidate.id)
      .eq('status', 'queued') // compare-and-swap: only one runner can ever win this specific job
      .select('*, cam_tools(nose_radius, diameter, fusion_tool_library_file), cam_machines(name, controller, post_processor), cam_materials(name)')
      .single();
    if (claimError?.code === 'PGRST116') continue; // lost the CAS race; try the next candidate
    if (claimError) throw new Error(`Could not claim Fusion job ${candidate.id}: ${claimError.message}`);
    if (claimed) return claimed;
  }
  return null; // every candidate got claimed by someone else between the select and our CAS attempts
}

export async function POST({ request, url }) {
  if (!isAuthorizedFusionRunnerRequest({ url, headers: request.headers, env })) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = url.searchParams.get('action') || body?.action;

  try {
    const supabase = getServiceSupabase();
    if (action === 'sync-folders') {
      const projectName = String(body?.projectName || '').trim();
      const tree = body?.tree;
      if (!projectName) return json({ error: 'projectName is required' }, { status: 400 });
      if (!tree || typeof tree !== 'object') return json({ error: 'tree is required' }, { status: 400 });
      const { error } = await supabase.from('fusion_data_folders').upsert({
        project_name: projectName,
        tree,
        synced_by: String(body?.runnerId || '').trim() || null,
        synced_at: new Date().toISOString()
      });
      if (error) throw new Error(error.message);
      return json({ success: true });
    }

    if (action === 'claim') {
      const runnerId = String(body?.runnerId || '').trim();
      if (!runnerId) return json({ error: 'runnerId is required' }, { status: 400 });
      // Only trusted as a raw PostgREST .or() filter fragment once validated
      // as a real UUID shape - unlike .eq(), .or() takes a raw string, so an
      // unvalidated value here would be a filter-injection risk.
      const rawMachineId = body?.machineId;
      if (typeof rawMachineId !== 'string' || !UUID_RE.test(rawMachineId)) return json({ error: 'machineId is required and must be a UUID' }, { status: 400 });
      const machineId = rawMachineId;
      await requeueStaleFusionJobs(supabase);
      const job = await claimNextJob(supabase, runnerId, machineId);
      if (!job) return json({ job: null });
      try {
        const payload = await buildJobPayload(supabase, job);
        return json({ job: { ...job, payload } });
      } catch (error) {
        const message = error.message || 'Could not resolve Fusion job inputs';
        const { error: failError } = await supabase.from('cam_jobs')
          .update({ status: 'failed', errors: [message], progress_message: message })
          .eq('id', job.id).eq('status', 'claimed');
        if (failError) throw failError;
        return json({ job: null, error: message });
      }
    }

    const jobId = body?.jobId;
    const runnerId = String(body?.runnerId || '').trim();
    if (!jobId) return json({ error: 'jobId is required' }, { status: 400 });
    if (!runnerId) return json({ error: 'runnerId is required' }, { status: 400 });

    if (action === 'processing') {
      const { data, error } = await supabase
        .from('cam_jobs')
        .update({ status: 'processing', claimed_at: new Date().toISOString(), progress: body?.progress ?? 10, progress_message: body?.progressMessage || 'Fusion Runner processing...' })
        .eq('id', jobId)
        .eq('operation_type', 'milling')
        .eq('claimed_by', runnerId)
        .eq('status', 'claimed') // CAS: only the runner that actually claimed it can move it to processing
        .select('id');
      if (error) throw new Error(error.message);
      if (!data?.length) return json({ error: 'Job was not in the claimed state (already progressed, cancelled, or claimed by another runner)' }, { status: 409 });
      return json({ success: true });
    }

    if (action === 'heartbeat') {
      const update = { claimed_at: new Date().toISOString() };
      if (Number.isFinite(body?.progress)) update.progress = Math.max(0, Math.min(99, body.progress));
      if (body?.progressMessage) update.progress_message = String(body.progressMessage).slice(0, 500);
      const { data, error } = await supabase.from('cam_jobs').update(update)
        .eq('id', jobId).eq('operation_type', 'milling').eq('claimed_by', runnerId)
        .in('status', ['claimed', 'processing']).select('id');
      if (error) throw new Error(error.message);
      if (!data?.length) return json({ error: 'Job is not active or belongs to another runner' }, { status: 409 });
      return json({ success: true });
    }

    if (action === 'complete') {
      const { data: currentJob, error: currentError } = await supabase
        .from('cam_jobs').select('id, params').eq('id', jobId).eq('operation_type', 'milling').eq('claimed_by', runnerId).eq('status', 'processing').single();
      if (currentError || !currentJob) return json({ error: 'Job was not in the processing state - not completed' }, { status: 409 });
      const kind = currentJob.params?.fusionJobKind;
      const ncFiles = kind === 'plate:arrange' ? null : validateFusionNcFiles(body?.ncFiles);
      // How far the posted program actually travels, measured from the file
      // itself. Issue #359: "program exceeds machine maximum" was reported
      // repeatedly on the real router, and every time the program's own span
      // turned out to be modest - the real cause was the machine's G54 work
      // offset sitting tens of inches out. Proving that meant parsing the
      // .ngc by hand each incident; recording it here answers "is the
      // program too big?" up front so the next person goes straight to the
      // work offset. Merged into stats rather than replacing them, and
      // deliberately never fatal: this is diagnostic metadata, and a job
      // with real G-code must still complete if measuring it fails.
      let programExtents = null;
      try {
        programExtents = measureNcFileExtents(ncFiles);
      } catch (extentsError) {
        console.error(`measureNcFileExtents failed for job ${jobId}:`, extentsError.message);
      }
      const stats = programExtents
        ? { ...(body?.stats || {}), program_extents: programExtents }
        : body?.stats || null;
      const { data, error } = await supabase
        .from('cam_jobs')
        .update({
          status: 'completed',
          // Fusion output is stored as separate base64 artifacts. It is not
          // decoded, annotated, concatenated, or renamed by this app.
          gcode: null,
          gcode_file_name: null,
          fusion_nc_files: ncFiles,
          stats,
          // The Runner's own coverage self-check (camPlate.py) compares the
          // posted program against the part's CAD geometry and reports any
          // internal feature left with no toolpath over it, or a program that
          // never cuts through the material. A completed job can still carry
          // these - the G-code is real - so they are recorded rather than
          // failing the job, and are the thing to read instead of opening the
          // simulation to check a cutout by eye.
          warnings: Array.isArray(body?.warnings) && body.warnings.length ? body.warnings : null,
          progress: 100,
          progress_message: 'Done'
        })
        .eq('id', jobId)
        .eq('operation_type', 'milling')
        .eq('claimed_by', runnerId)
        .eq('status', 'processing') // CAS: same guarantee cam-generate's own completion write has - a cancel landing mid-flight can never get silently clobbered back to "completed"
        .select('id');
      if (error) throw new Error(error.message);
      if (!data?.length) return json({ error: 'Job was not in the processing state - not completed' }, { status: 409 });
      return json({ success: true });
    }

    if (action === 'fail') {
      const message = body?.error || 'Fusion Runner reported a failure';
      const { data, error } = await supabase.from('cam_jobs').update({
        status: 'failed',
        errors: [message],
        progress_message: message
      }).eq('id', jobId).eq('operation_type', 'milling').eq('claimed_by', runnerId).in('status', ['claimed', 'processing']).select('id');
      if (error) throw error;
      if (!data?.length) return json({ error: 'Job is not an active Fusion job' }, { status: 409 });
      return json({ success: true });
    }

    return json({ error: `Unknown action: ${action}. Expected one of: claim, processing, heartbeat, complete, fail, sync-folders` }, { status: 400 });
  } catch (error) {
    return json({ error: error?.message || 'Internal server error' }, { status: 500 });
  }
}
