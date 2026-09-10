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
import { isAuthorizedFusionRunnerRequest, getBearerToken } from '$lib/server/fusion_runner_auth.js';
import { validateFusionNcFiles } from '$lib/server/fusion_nc_artifacts.js';
import { measureNcFileExtents } from '$lib/server/fusion_program_extents.js';

function getServiceSupabase() {
  const url = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new Error('Fusion Runner API is missing Supabase service configuration');
  return createClient(url, serviceKey);
}

const AUTOCAM_FILES_BUCKET = 'manufacturing-drive';
const AUTOCAM_FILES_FOLDER = 'AutoCAM';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_CLAIM_MS = 15 * 60 * 1000;

function autoCamArtifactPath(jobId, artifact, index, kind) {
  // Fusion validates artifact names before this point. Keep the original
  // program identity, while the job prefix prevents retries or same-named
  // tube faces from overwriting another job in the shared AutoCAM folder.
  const leafName = String(artifact.name || `program-${index + 1}.nc`)
    .split('/').at(-1)
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return kind === 'box_tube'
    ? `${AUTOCAM_FILES_FOLDER}/${jobId.slice(0, 8)}/${leafName}`
    : `${AUTOCAM_FILES_FOLDER}/${jobId.slice(0, 8)}-${leafName}`;
}

function validateTubeNcArtifacts(ncFiles) {
  const sides = ncFiles.map((artifact) => String(artifact.name).match(/-side-(12|3|6|9)\.(?:nc|ngc|tap)$/i)?.[1]);
  if (ncFiles.length !== 4 || new Set(sides).size !== 4 || sides.some((side) => !side)) {
    throw new Error('Box-tube CAM must post exactly four per-setup NC files: Side 12, Side 3, Side 6, and Side 9');
  }
}

async function publishNcArtifactsToAutoCamFiles(supabase, jobId, ncFiles, kind) {
  if (!ncFiles?.length) return;
  for (const [index, artifact] of ncFiles.entries()) {
    const path = autoCamArtifactPath(jobId, artifact, index, kind);
    const { error } = await supabase.storage
      .from(AUTOCAM_FILES_BUCKET)
      .upload(path, Buffer.from(artifact.contentBase64, 'base64'), {
        upsert: true,
        contentType: 'text/plain'
      });
    if (error) throw new Error(`Could not post ${artifact.name} to Files/AutoCAM: ${error.message}`);
  }
}

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
// machineIds: a Runner declares which cam_machines row(s) it physically is
// (autocam/fusion/runner/config.py's RUNNER_MACHINE_ID, comma-separated for
// a computer that drives more than one physical machine - e.g. one control
// laptop shared between two routers) and only claims jobs that are either
// unassigned to a specific machine (cam_jobs.machine_id IS NULL) or
// assigned to one of its own - so a router's Runner can't accidentally
// grab a job queued for the mill, and vice versa, once multiple physical
// machines are polling at once. At least one machineId is required:
// claim-anything fallback can put a program on the wrong physical machine.
//
// cam_machines.authorized_runner_id closes a real gap in that: nothing
// stopped two different physical computers from both configuring the SAME
// machineId (both laptops thinking they're "New Router"), and whichever
// one polled first would win the claim even if it wasn't the computer
// actually wired to the real machine - confirmed live (two different
// hostnames both syncing as the same machine). NULL means "no
// restriction," unchanged behavior. When set, a mismatched runnerId is
// silently excluded from that one machineId's assigned jobs (it can still
// claim unassigned jobs, and any of its OTHER authorized machineIds
// normally) - not an error, since "nothing to claim for that machine right
// now" is the correct, quiet outcome for a computer that legitimately
// isn't the authorized one, same as if nothing were queued at all.
async function claimNextJob(supabase, runnerId, machineIds) {
  const { data: machines, error: machineError } = await supabase
    .from('cam_machines')
    .select('id, authorized_runner_id')
    .in('id', machineIds);
  if (machineError) throw new Error(`Could not check machine authorization: ${machineError.message}`);
  const authorizedMachineIds = machineIds.filter((id) => {
    const machine = machines?.find((m) => m.id === id);
    return !machine?.authorized_runner_id || machine.authorized_runner_id === runnerId;
  });

  let query = supabase
    .from('cam_jobs')
    .select('id')
    .eq('status', 'queued')
    .eq('operation_type', 'milling')
    .order('created_at', { ascending: true })
    .limit(5);
  // Every entry in authorizedMachineIds already passed UUID_RE (validated
  // by the caller) before reaching here - required, since .or() takes a
  // raw filter string rather than a parameterized value like .eq()/.in() do.
  query = authorizedMachineIds.length
    ? query.or(`machine_id.is.null,machine_id.in.(${authorizedMachineIds.join(',')})`)
    : query.is('machine_id', null);
  const { data: candidates, error: findError } = await query;
  if (findError) throw new Error(`Could not look up queued milling jobs: ${findError.message}`);
  if (!candidates?.length) return null;

  for (const candidate of candidates) {
    const { data: claimed, error: claimError } = await supabase
      .from('cam_jobs')
      .update({ status: 'claimed', claimed_by: runnerId, claimed_at: new Date().toISOString() })
      .eq('id', candidate.id)
      .eq('status', 'queued') // compare-and-swap: only one runner can ever win this specific job
      .select('*, cam_tools(nose_radius, diameter, tool_type, tool_number, fusion_tool_library_file), cam_machines(name, controller, post_processor), cam_materials(name)')
      .single();
    if (claimError?.code === 'PGRST116') continue; // lost the CAS race; try the next candidate
    if (claimError) throw new Error(`Could not claim Fusion job ${candidate.id}: ${claimError.message}`);
    if (claimed) return claimed;
  }
  return null; // every candidate got claimed by someone else between the select and our CAS attempts
}

export async function POST({ request, url }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = url.searchParams.get('action') || body?.action;

  try {
    const supabase = getServiceSupabase();
    let authorized = isAuthorizedFusionRunnerRequest({ url, headers: request.headers, env });
    if (!authorized) {
      const bearerToken = getBearerToken(request.headers);
      if (bearerToken) {
        const { data: runnerToken } = await supabase
          .from('runner_tokens')
          .select('id')
          .eq('token', bearerToken)
          .is('revoked_at', null)
          .maybeSingle();
        authorized = !!runnerToken;
      }
    }
    if (!authorized) return json({ error: 'Unauthorized' }, { status: 401 });

    if (action === 'update-manifest') {
      // The manifest is generated alongside the downloadable Runner zip at
      // build time and contains its version and checksum. Keep discovery
      // authenticated even though the static artifact itself is served by
      // the app, so only configured Runner instances poll for updates.
      return json({
        manifestUrl: `${url.origin}/downloads/SpartanRoboticsAutoCAM-FusionAddIn.manifest.json?check=${Date.now()}`
      });
    }
    if (action === 'sync-folders') {
      const projectName = String(body?.projectName || '').trim();
      const tree = body?.tree;
      if (!projectName) return json({ error: 'projectName is required' }, { status: 400 });
      if (!tree || typeof tree !== 'object') return json({ error: 'tree is required' }, { status: 400 });
      if (String(tree.name || '').trim() !== projectName) {
        return json({ error: 'Folder tree root must match projectName' }, { status: 422 });
      }
      const { error } = await supabase.from('fusion_data_folders').upsert({
        project_name: projectName,
        tree,
        synced_by: String(body?.runnerId || '').trim() || null,
        synced_at: new Date().toISOString()
      });
      if (error) throw new Error(error.message);
      return json({ success: true });
    }

    if (action === 'register-machine') {
      // Lets setup.py get a real RUNNER_MACHINE_ID without a human having to
      // open /autocam/fusion -> Machines and copy a UUID by hand. Get-or-
      // create by name (case-insensitive) so re-running setup for the same
      // physical machine is idempotent instead of creating duplicates.
      // Newly created rows start disabled: this only gets the machine a
      // real cam_machines id so job routing (the machine_id filter in the
      // 'claim' action below) has something real to match against - the
      // post-processor, controller, and tool library it needs to actually
      // run a job still require a human to configure via /autocam before
      // enabling it, same as a manually-created machine profile always has.
      const name = String(body?.name || '').trim();
      if (!name) return json({ error: 'name is required' }, { status: 400 });
      const { data: existing, error: findError } = await supabase
        .from('cam_machines')
        .select('id, name')
        .ilike('name', name)
        .maybeSingle();
      if (findError) throw new Error(findError.message);
      if (existing) return json({ machine: existing, created: false });
      const { data: created, error: createError } = await supabase
        .from('cam_machines')
        .insert({ name, enabled: false })
        .select('id, name')
        .single();
      if (createError) throw new Error(createError.message);
      return json({ machine: created, created: true });
    }

    if (action === 'recover-own-jobs') {
      // Direct instruction: on a Fusion/Runner restart, this Runner's own
      // interrupted job(s) should not just sit stuck until the 15-minute
      // stale-claim sweep (requeueStaleFusionJobs) eventually notices - and
      // scoped ONLY to this runnerId's own claims, never the shared queue,
      // so one machine restarting can never touch what another machine or
      // an operator queued from the web UI.
      const runnerId = String(body?.runnerId || '').trim();
      if (!runnerId) return json({ error: 'runnerId is required' }, { status: 400 });

      // A 'claimed' job never actually started (Fusion hadn't begun real
      // work on it yet) - safe to put straight back in the queue for
      // anyone to pick up, the same outcome requeueStaleFusionJobs already
      // produces after 15 minutes of silence, just immediate instead of a
      // pointless wait once the crash/restart itself already proves this
      // Runner isn't coming back to it this session.
      const { data: requeued, error: requeueError } = await supabase.from('cam_jobs')
        .update({
          status: 'queued',
          claimed_by: null,
          claimed_at: null,
          progress: 0,
          progress_message: 'Runner restarted before starting this job; requeued automatically'
        })
        .eq('claimed_by', runnerId).eq('status', 'claimed').eq('operation_type', 'milling')
        .select('id');
      if (requeueError) throw new Error(requeueError.message);

      // A 'processing' job may already have changed a document or exported
      // an artifact before the crash - the same reason requeueStaleFusionJobs
      // deliberately never auto-retries one (see its own comment above).
      // Failing it here instead of leaving it silently stuck in
      // 'processing' forever surfaces the need for an operator's review
      // right away, rather than only ever finding out by noticing the job
      // never moved.
      const { data: failed, error: failError } = await supabase.from('cam_jobs')
        .update({
          status: 'failed',
          errors: ['Runner restarted while this job was processing - it may be partially complete; review before retrying'],
          progress_message: 'Runner restarted mid-job'
        })
        .eq('claimed_by', runnerId).eq('status', 'processing').eq('operation_type', 'milling')
        .select('id');
      if (failError) throw new Error(failError.message);

      return json({ success: true, requeued: requeued?.length || 0, failed: failed?.length || 0 });
    }

    if (action === 'claim') {
      const runnerId = String(body?.runnerId || '').trim();
      if (!runnerId) return json({ error: 'runnerId is required' }, { status: 400 });
      // machineIds (plural) is the current shape - a Runner driving more
      // than one physical machine sends all of them. machineId (singular)
      // is accepted too, for any Runner install that hasn't picked up the
      // multi-machine config.py/SpartanRoboticsAutoCAM.py change yet.
      // Only trusted as a raw PostgREST .or() filter fragment once every
      // entry is validated as a real UUID shape - unlike .eq()/.in(), .or()
      // takes a raw string, so an unvalidated value here would be a
      // filter-injection risk.
      const rawMachineIds = Array.isArray(body?.machineIds)
        ? body.machineIds
        : typeof body?.machineId === 'string'
          ? [body.machineId]
          : null;
      if (!rawMachineIds?.length || !rawMachineIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
        return json({ error: 'machineIds is required and must be an array of UUIDs' }, { status: 400 });
      }
      const machineIds = rawMachineIds;
      await requeueStaleFusionJobs(supabase);
      const job = await claimNextJob(supabase, runnerId, machineIds);
      if (!job) return json({ job: null });
      try {
        const payload = await buildJobPayload(supabase, job);
        return json({ job: { ...job, payload } });
      } catch (error) {
        const message = error.message || 'Could not resolve Fusion job inputs';
        const { error: failError } = await supabase.from('cam_jobs')
          .update({ status: 'failed', errors: [message], progress_message: message })
          .eq('id', job.id).eq('status', 'claimed').eq('claimed_by', runnerId);
        if (failError) throw failError;
        return json({ job: null, error: message });
      }
    }

    if (action === 'grow-plate') {
      // Not tied to a specific job - AutoArrange grows a plate to fit an
      // individually oversized part rather than rejecting it (a plate's
      // declared size only bounds Arrange's nesting room; the real CAM
      // stock is sized to the actual imported geometry regardless - see
      // AutoArrange.py), and reports the size it actually used back here so
      // the next job queued against this same plate starts from the larger
      // size instead of growing again from scratch every time.
      const rawPlateId = body?.plateId;
      if (typeof rawPlateId !== 'string' || !UUID_RE.test(rawPlateId)) return json({ error: 'plateId is required and must be a UUID' }, { status: 400 });
      const length = Number(body?.length);
      const width = Number(body?.width);
      if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0) {
        return json({ error: 'length and width are required and must be positive numbers' }, { status: 400 });
      }
      const { data: currentPlate, error: currentError } = await supabase
        .from('fusion_plates').select('id, width, length').eq('id', rawPlateId).maybeSingle();
      if (currentError) throw new Error(currentError.message);
      if (!currentPlate) return json({ error: 'Plate not found' }, { status: 404 });
      // Never shrink - a concurrent job on the same category could have
      // already grown this plate further since this Runner last read it.
      const nextLength = Math.max(Number(currentPlate.length), length);
      const nextWidth = Math.max(Number(currentPlate.width), width);
      if (nextLength === Number(currentPlate.length) && nextWidth === Number(currentPlate.width)) {
        return json({ success: true, grown: false });
      }
      const { error: updateError } = await supabase.from('fusion_plates')
        .update({ length: nextLength, width: nextWidth })
        .eq('id', rawPlateId);
      if (updateError) throw new Error(updateError.message);
      return json({ success: true, grown: true, length: nextLength, width: nextWidth });
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
      if (kind === 'box_tube') validateTubeNcArtifacts(ncFiles);
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
      // Files is the permanent operator-facing copy. Publish every exact
      // artifact before the status change, so a completed job always has its
      // separate plate or tube-face programs available in Files/AutoCAM.
      await publishNcArtifactsToAutoCamFiles(supabase, currentJob.id, ncFiles, kind);
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

    return json({ error: `Unknown action: ${action}. Expected one of: claim, processing, heartbeat, complete, fail, sync-folders, register-machine, update-manifest, grow-plate, recover-own-jobs` }, { status: 400 });
  } catch (error) {
    return json({ error: error?.message || 'Internal server error' }, { status: 500 });
  }
}
