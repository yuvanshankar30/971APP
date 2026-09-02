/**
 * Shared helpers for the AutoCAM (CAM Studio) job queue.
 * Used by both /manufacture (queue-from-existing-part) and /autocam
 * (queue-from-upload or queue-from-existing-part) so job creation stays
 * consistent in one place.
 */

import { supabase } from '$lib/supabase.js';

export const ACTIVE_CAM_JOB_STATUSES = ['queued', 'claimed', 'processing'];
export const TERMINAL_CAM_JOB_STATUSES = ['completed', 'failed', 'rejected'];

// All cam_jobs.gcode_format must stay 'ngc' - see autocam-runner/README.md.
export const CAM_GCODE_FORMAT = 'ngc';

const CAM_STATUS_DISPLAY = {
  queued: 'Generating CAM',
  claimed: 'Generating CAM',
  processing: 'Generating CAM',
  completed: 'Completed',
  failed: 'Autocam Failed',
  rejected: 'Job Rejected'
};

/** Collapsed, user-facing label for a job status (queued/claimed/processing all read as "Generating CAM"). */
export function camJobStatusLabel(status) {
  return CAM_STATUS_DISPLAY[status] || status || '';
}

export function isCamJobActive(job) {
  return !!job && ACTIVE_CAM_JOB_STATUSES.includes(job.status);
}

/** User-given job name if set, else a sensible fallback (linked part name or uploaded filename). */
export function jobDisplayName(job) {
  if (job?.name) return job.name;
  if (job?.source_type === 'part') return job?.parts?.name || (job?.part_id ? `Part #${job.part_id}` : 'Untitled job');
  return job?.step_file_name?.split('/').pop() || 'Untitled job';
}

const VALID_GCODE_EXTENSIONS = ['ngc', 'tap'];

/**
 * Turn a part/file name into a safe `<slug>.<ext>` filename. Extension
 * defaults to 'ngc' (this app's baseline) - pass 'tap' for a machine profile
 * that expects Mach3/Mach4-style output (currently router-only, see
 * implementations/toolchange-gcode-plan.md). gcode_format on the job row itself stays 'ngc'
 * regardless - it's a content-format marker, not the download extension.
 */
export function gcodeFileNameFor(name, extension = 'ngc') {
  const slug = String(name || 'part')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'part';
  const ext = VALID_GCODE_EXTENSIONS.includes(extension) ? extension : 'ngc';
  return `${slug}.${ext}`;
}

// router/lathe workflow -> the operation_type generation dispatches on.
export const WORKFLOW_OPERATION_TYPE = { router: 'routing', lathe: 'turning' };

function isStepFile(name) {
  return /\.(step|stp)$/i.test(name || '');
}

async function uploadStepFile(file) {
  if (!file) return { error: 'No STEP file provided' };
  if (!isStepFile(file.name)) return { error: 'CAM input must be a .step or .stp file' };
  const storagePath = `cam-jobs/${crypto.randomUUID()}-${file.name}`;
  const { error } = await supabase.storage
    .from('manufacturing-files')
    .upload(storagePath, file, { cacheControl: '3600', upsert: false });
  return error ? { error: error.message } : { path: storagePath };
}

const TERMINAL_STATUSES = ['completed', 'failed', 'rejected'];
const PROGRESS_POLL_MS = 400;
// Must stay comfortably above the server's own maxDuration (60s, see
// src/routes/api/cam-generate/+server.js) - if this were shorter, the
// client could give up and report a false failure while the server is
// still legitimately working within its own time budget.
const PROGRESS_TIMEOUT_MS = 75000;

/**
 * Calls the server-side generator immediately after a job is queued - there
 * is no external Runner for turning/routing, generation is synchronous math
 * that finishes in well under a second for realistic files. While that
 * request is in flight, polls the job row for `progress`/`progress_message`
 * so the UI can show real incremental progress instead of an indefinite
 * spinner, via the optional `onProgress(job)` callback.
 *
 * Also enforces a client-side timeout: if the job is still non-terminal
 * after PROGRESS_TIMEOUT_MS (the server should never take remotely this
 * long for turning/routing), it's surfaced as a failure here even if the
 * server-side row never got updated - e.g. because the server process
 * itself couldn't reach the database. Without this, a stuck server-side
 * write would otherwise leave the job showing "Generating CAM" forever.
 *
 * Returns the job row after generation (status will be 'completed' or
 * 'failed' by the time this resolves).
 */
async function markCamJobFailed(jobId, message) {
  const failure = { status: 'failed', errors: [message], progress_message: message };
  try {
    const { error } = await supabase.from('cam_jobs').update(failure).eq('id', jobId);
    if (error) console.error('Could not persist terminal CAM job status', error);
  } catch (error) {
    // The caller still receives a terminal result even if the same database
    // outage that broke polling also prevents this best-effort status write.
    console.error('Could not persist terminal CAM job status', error);
  }
  return { id: jobId, ...failure };
}

export async function triggerGenerationAndRefetch(jobId, onProgress, {
  pollMs = PROGRESS_POLL_MS,
  timeoutMs = PROGRESS_TIMEOUT_MS
} = {}) {
  let fetchError = null;
  let fetchSettled = false;
  let pollError = null;

  // The endpoint builds its own Supabase client from whatever Authorization
  // header this request carries (src/routes/api/cam-generate/+server.js) -
  // without the current session's access token attached here, that client
  // has no real identity, cam_jobs' RLS policies (all scoped to
  // "authenticated") deny every query, and the endpoint returns a fast 404
  // "no rows" that this function was never checking for anyway (it only
  // watches the database row, not this response) - so the job just sits at
  // "queued" forever until the timeout below gives up. Real bug, not a
  // hypothetical: this is what was actually causing every failure tonight.
  let accessToken;
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw new Error(sessionError.message);
    accessToken = sessionData?.session?.access_token;
  } catch (error) {
    return markCamJobFailed(jobId, `Could not read the current session: ${error.message}`);
  }

  // Fired but deliberately not awaited directly - the server writes progress
  // and the final status straight to the job row as it goes, so polling that
  // row is what actually drives this function, not this promise. Awaiting it
  // directly would risk hanging forever if the request itself never settles.
  try {
    fetch('/api/cam-generate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
      },
      body: JSON.stringify({ jobId })
    })
      .then(async (response) => {
        if (response.ok) return;
        let detail = '';
        try { detail = (await response.json())?.error || ''; } catch { /* response body is optional */ }
        throw new Error(detail || `Generation server returned HTTP ${response.status}`);
      })
      .catch((error) => { fetchError = error; console.error('CAM generation request failed', error); })
      .finally(() => { fetchSettled = true; });
  } catch (error) {
    fetchError = error;
    fetchSettled = true;
  }

  const pollStart = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, pollMs));
    let result;
    try {
      result = await supabase.from('cam_jobs').select('*').eq('id', jobId).single();
    } catch (error) {
      pollError = error;
      break;
    }
    const { data, error } = result || {};
    if (error || !data) {
      pollError = new Error(error?.message || 'The queued CAM job could not be found while generation was running');
      break;
    }
    if (onProgress) {
      try { onProgress(data); } catch (error) { console.error('CAM progress callback failed', error); }
    }
    if (TERMINAL_STATUSES.includes(data.status)) return data;
    // A network-level failure (not just a slow server) - no point waiting out the full timeout.
    if (fetchSettled && fetchError) break;
    if (Date.now() - pollStart >= timeoutMs) break;
  }

  // Still not terminal - the server never finished writing a result. Surface
  // a clear, specific failure here instead of leaving the job (and the UI)
  // spinning on "Generating CAM" forever with no explanation.
  const message = pollError
    ? `Could not read CAM generation progress: ${pollError.message}`
    : fetchError
      ? `Could not reach the generation server: ${fetchError.message}`
      : `Generation did not finish within ${timeoutMs / 1000}s - the server may have hit its execution time limit, crashed, or lost its database connection mid-request. On Vercel, check the deployment's function logs for /api/cam-generate; locally, check the terminal running "npm run dev".`;
  return markCamJobFailed(jobId, message);
}

/**
 * Queue + immediately generate a CAM job from a part. Uses the part's
 * already-uploaded STEP file (getPartStepFileName) by default - no separate
 * CAM-specific upload needed, since router and lathe parts both require a
 * STEP file at creation time now. Pass `profileFile` only to attach/replace
 * the STEP for a part that doesn't have one yet (e.g. a legacy lathe part
 * created before STEP was required for that workflow).
 * @param {Object} part - part row (needs id, name, workflow, file_name/file_url for its STEP)
 * @param {Object} options - { operationType, materialId, toolId, machineId, params, userId, name, notes, profileFile, onProgress, onQueued, gcodeExtension }
 */
export async function queueCamJobForPart(part, options = {}) {
  if (!part?.id) return { success: false, error: 'Missing part' };
  const operationType = options.operationType || WORKFLOW_OPERATION_TYPE[part.workflow];
  if (!operationType) return { success: false, error: `No CAM operation type for workflow "${part.workflow}"` };

  let stepPath;
  if (options.profileFile) {
    const upload = await uploadStepFile(options.profileFile);
    if (upload.error) return { success: false, error: upload.error };
    stepPath = upload.path;
  } else {
    stepPath = getPartStepFileName(part);
    if (!stepPath) return { success: false, error: 'This part has no STEP file attached yet' };
  }

  const { data, error } = await supabase
    .from('cam_jobs')
    .insert({
      name: options.name || null,
      notes: options.notes || null,
      source_type: 'part',
      part_id: part.id,
      operation_type: operationType,
      step_file_name: stepPath,
      material_id: options.materialId || null,
      tool_id: options.toolId || null,
      machine_id: options.machineId || null,
      params: options.params || {},
      gcode_file_name: gcodeFileNameFor(part.name, options.gcodeExtension),
      gcode_format: CAM_GCODE_FORMAT,
      status: 'queued',
      requested_by: options.userId || null
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (options.onQueued) options.onQueued(data);
  const finalJob = await triggerGenerationAndRefetch(data.id, options.onProgress);
  return { success: finalJob?.status === 'completed', job: finalJob || data, error: finalJob?.errors?.[0] };
}

/**
 * Queue + generate CAM jobs for several parts at once, all sharing the same
 * material/tool/machine/params (e.g. "run this same router setup across a
 * batch of brackets") - one queueCamJobForPart call per part, run
 * SEQUENTIALLY rather than in parallel. Sequential is deliberate: each call
 * already blocks on a full /api/cam-generate round trip (STEP download +
 * WASM parser load + geometry extraction), and firing a dozen of those at
 * once would pile up concurrent cold WASM inits against the same serverless
 * function for no real benefit, since generation itself is already
 * sub-second once warm - a queue of one-at-a-time requests finishes in
 * about the same wall-clock time as short-lived parallel bursts would, with
 * a much smaller chance of tripping a rate limit or timeout.
 *
 * @param {Array<Object>} parts - part rows (see queueCamJobForPart)
 * @param {Object} options - same shape as queueCamJobForPart's options,
 *   applied to every part, plus `onPartStart(part, index, total)` and
 *   `onPartDone(part, index, total, result)` called around each one.
 * @returns {Promise<Array<{part, success, job, error}>>} one result per part, same order as input
 */
export async function queueCamJobsForParts(parts, options = {}) {
  const results = [];
  const total = parts.length;
  for (let i = 0; i < total; i += 1) {
    const part = parts[i];
    if (options.onPartStart) options.onPartStart(part, i, total);
    // A batch shares one material choice, except where the part itself
    // already records what it's made of - see the /autocam page's
    // materialIdForStockAssignment. Falls back to the batch-wide choice
    // for any part whose stock doesn't resolve to a known material.
    const result = await queueCamJobForPart(part, options.materialIdForPart
      ? { ...options, materialId: options.materialIdForPart(part) || options.materialId }
      : options);
    results.push({ part, success: result.success, job: result.job, error: result.error });
    if (options.onPartDone) options.onPartDone(part, i, total, result);
  }
  return results;
}

/**
 * Upload a fresh STEP file and queue + generate a CAM job from it (no
 * existing part) - used by the /autocam page's manual "New Job" flow.
 * @param {File} profileFile - the .step/.stp file
 * @param {Object} options - { operationType (required), materialId, toolId, machineId, params, userId, baseName, notes, onProgress, onQueued, gcodeExtension }
 */
export async function queueCamJobFromUpload(profileFile, options = {}) {
  if (!options.operationType) return { success: false, error: 'operationType is required (turning, routing, or tubestock)' };

  const upload = await uploadStepFile(profileFile);
  if (upload.error) return { success: false, error: upload.error };

  const baseName = options.baseName || (profileFile?.name || 'part').replace(/\.(step|stp)$/i, '');
  const { data, error } = await supabase
    .from('cam_jobs')
    .insert({
      name: options.name || null,
      notes: options.notes || null,
      source_type: 'upload',
      operation_type: options.operationType,
      step_file_name: upload.path,
      material_id: options.materialId || null,
      tool_id: options.toolId || null,
      machine_id: options.machineId || null,
      params: options.params || {},
      gcode_file_name: gcodeFileNameFor(baseName, options.gcodeExtension),
      gcode_format: CAM_GCODE_FORMAT,
      status: 'queued',
      requested_by: options.userId || null
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (options.onQueued) options.onQueued(data);
  const finalJob = await triggerGenerationAndRefetch(data.id, options.onProgress);
  return { success: finalJob?.status === 'completed', job: finalJob || data, error: finalJob?.errors?.[0] };
}

/**
 * Re-queue + regenerate from a failed (or completed) job's already-uploaded
 * STEP file - no re-upload needed, the file is still in storage.
 * @param {Object} job - a cam_jobs row (needs step_file_name, operation_type)
 * @param {Object} options - { userId, onProgress } - other fields (material/tool/machine/params) carry over from the job
 */
export async function retryCamJob(job, options = {}) {
  if (!job?.step_file_name) return { success: false, error: 'No stored CAM profile to retry from' };

  // Regenerates the SAME row in place (same id, same position in the jobs
  // list) rather than inserting a new one - a retry is "try this job again",
  // not a new job, and duplicate rows for every failed attempt made the
  // jobs list confusing to read.
  const { error } = await supabase
    .from('cam_jobs')
    .update({ status: 'queued', gcode: null, stats: null, errors: null, progress: 0, progress_message: null })
    .eq('id', job.id);
  if (error) return { success: false, error: error.message };

  const finalJob = await triggerGenerationAndRefetch(job.id, options.onProgress);
  return { success: finalJob?.status === 'completed', job: finalJob, error: finalJob?.errors?.[0] };
}

/** Rename a job in place - no regeneration, just the display name. */
export async function renameCamJob(jobId, name) {
  const { error } = await supabase.from('cam_jobs').update({ name: name || null }).eq('id', jobId);
  return error ? { success: false, error: error.message } : { success: true };
}

/** Update a job's free-text notes in place - no regeneration, purely informational. */
export async function updateCamJobNotes(jobId, notes) {
  const { error } = await supabase.from('cam_jobs').update({ notes: notes || null }).eq('id', jobId);
  return error ? { success: false, error: error.message } : { success: true };
}

/** Permanently delete a job row. Does not delete the underlying STEP file from storage, since it may still be referenced elsewhere. */
export async function deleteCamJob(jobId) {
  const { error } = await supabase.from('cam_jobs').delete().eq('id', jobId);
  return error ? { success: false, error: error.message } : { success: true };
}

/**
 * Edit an existing job's material/tool/machine/params in place and
 * regenerate from its already-uploaded STEP file - no re-upload needed.
 * Updates the same row (unlike retryCamJob, which inserts a new one to
 * preserve history) since this is an explicit edit of this specific job.
 * @param {Object} job - the job row being edited (needs id, step_file_name)
 * @param {Object} updates - { name, notes, materialId, toolId, machineId, params, onProgress, gcodeExtension }
 */
export async function updateCamJobAndRegenerate(job, updates = {}) {
  if (!job?.id) return { success: false, error: 'Missing job' };
  if (!job.step_file_name) return { success: false, error: 'No stored CAM profile to regenerate from' };

  const { error } = await supabase
    .from('cam_jobs')
    .update({
      name: updates.name ?? job.name ?? null,
      notes: updates.notes ?? job.notes ?? null,
      material_id: updates.materialId || null,
      tool_id: updates.toolId || null,
      machine_id: updates.machineId || null,
      params: updates.params || {},
      gcode_file_name: updates.gcodeExtension ? gcodeFileNameFor(jobDisplayName(job), updates.gcodeExtension) : job.gcode_file_name,
      status: 'queued',
      gcode: null,
      stats: null,
      errors: null,
      progress: 0,
      progress_message: null
    })
    .eq('id', job.id);

  if (error) return { success: false, error: error.message };
  if (updates.onQueued) updates.onQueued(job.id);
  const finalJob = await triggerGenerationAndRefetch(job.id, updates.onProgress);
  return { success: finalJob?.status === 'completed', job: finalJob, error: finalJob?.errors?.[0] };
}

/**
 * Manually mark a non-terminal job (queued/claimed/processing) as failed -
 * an escape hatch for jobs that got stuck before the client-side timeout in
 * triggerGenerationAndRefetch existed, or any other way a job's tab/session
 * got closed mid-generation. Safe no-op-ish on an already-terminal job.
 */
export async function cancelStuckCamJob(jobId) {
  const message = 'Cancelled by user (job was stuck)';
  const { error } = await supabase
    .from('cam_jobs')
    .update({ status: 'failed', errors: [message], progress_message: message })
    .eq('id', jobId);
  return error ? { success: false, error: error.message } : { success: true };
}

/**
 * Storage path of an uploaded STEP file for a part, if any. Mirrors the
 * getStepFileName() logic already used in the manufacture pages.
 */
export function getPartStepFileName(part) {
  let meta = {};
  try { meta = JSON.parse(part?.file_url || '{}') || {}; } catch { meta = {}; }
  if (meta.step_file) return meta.step_file;
  if (part?.file_name && /\.(step|stp)$/i.test(part.file_name)) return part.file_name;
  return null;
}

export function partHasStepFile(part) {
  return !!getPartStepFileName(part);
}

/** Trigger a browser download of a completed job's G-code (always .ngc). */
export function downloadGcodeBlob(job) {
  if (!job?.gcode) return;
  downloadGcodeText(job.gcode, job.gcode_file_name || `output.${CAM_GCODE_FORMAT}`);
}

/** Download a generated G-code artifact, including an individual tube face. */
export function downloadGcodeText(gcode, fileName) {
  if (!gcode) return;
  const blob = new Blob([gcode], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || `output.${CAM_GCODE_FORMAT}`;
  a.click();
  URL.revokeObjectURL(url);
}

/** "Install CAD" - download a job's source STEP file straight from storage. */
export async function downloadStepFile(stepFileName) {
  if (!stepFileName) return { success: false, error: 'No STEP file attached to this job' };
  let { data, error } = await supabase.storage.from('manufacturing-files').createSignedUrl(stepFileName, 60);
  if (error) {
    const retry = await supabase.storage.from('manufacturing-files').createSignedUrl(decodeURIComponent(stepFileName), 60);
    data = retry.data;
    error = retry.error;
  }
  if (error || !data?.signedUrl) return { success: false, error: error?.message || 'Could not locate the STEP file in storage' };
  window.open(data.signedUrl, '_blank');
  return { success: true };
}

/**
 * Load the most recent cam_jobs row for each of the given part IDs.
 * Returns a Map keyed by part_id -> job row.
 */
export async function loadLatestCamJobsForParts(partIds = []) {
  const ids = [...new Set((partIds || []).filter((id) => id !== null && id !== undefined))];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('cam_jobs')
    .select('*')
    .in('part_id', ids)
    .order('created_at', { ascending: false });

  const map = new Map();
  if (error || !data) return map;
  for (const job of data) {
    if (!map.has(job.part_id)) map.set(job.part_id, job); // first hit per part_id is the newest (already ordered desc)
  }
  return map;
}

/** Returns a map of completed CAM job id to its grouped router program. */
export async function loadCamGroupsForJobs(jobIds = []) {
  const ids = [...new Set((jobIds || []).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from('cam_job_group_items')
    .select('cam_job_id, cam_job_groups(id, name, project_id)')
    .in('cam_job_id', ids);
  if (error) return map;
  for (const item of data || []) {
    if (item.cam_job_groups) map.set(item.cam_job_id, item.cam_job_groups);
  }
  return map;
}
