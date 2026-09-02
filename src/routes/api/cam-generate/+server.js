import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL, PUBLIC_APP_ORIGIN, PUBLIC_SITE_URL } from '$env/static/public';
import { readStepMeshes, extractTurningProfileFromMeshes, extractRoutingContoursFromMeshes, extractTubeFeaturesFromMeshes } from '$autocam/stepProfile.js';
import { generateTurningGcode } from '$autocam/turning.js';
import { generateRoutingGcode } from '$autocam/routing.js';
import { generateTubestockGcode, tubestockFaceFileName } from '$autocam/tubestock.js';
import { deliverJobToDrive } from '$autocam/drive_watcher.js';
import stockData from '$lib/stock.json';

// How far past the underside an auto-derived through cut reaches, so the
// part actually separates. Matches routing.js's own allowance, which is what
// its too-deep refusal already permits.
const THROUGH_CUT_ALLOWANCE = 0.02;
// Vite-built asset URL for occt-import-js's WASM binary - the same one
// CadViewer.svelte already fetches successfully client-side. Fetching it
// over HTTP (below) instead of reading it off disk sidesteps Vercel's
// build-time file tracer entirely, which doesn't see the WASM binary as a
// dependency when it's only referenced via a runtime require.resolve() -
// see stepProfile.js and autocam/docs/vercel-cam-generate-timeout-fix.md.
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

// Vercel serverless functions default to a short execution limit (as low as
// 10s on some plans) - this route does a STEP file download, WASM parser
// load (occt-import-js, slow on a cold start), geometry extraction, and
// several Supabase round trips, which can plausibly exceed that default.
// Raises the ceiling on Vercel; vestigial (silently ignored, not harmful)
// now that the app deploys via adapter-node/Cloud Run instead of Vercel's
// adapter-auto - left in case a Vercel deployment ever comes back.
export const config = { maxDuration: 60 };

function getClientFromRequest(request) {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
}

// Prefers the known-good, build-time-configured public origin over the
// request's own url.origin. Behind a reverse proxy that terminates TLS
// (Cloud Run's setup - it forwards to the container over plain HTTP),
// SvelteKit's own adapter-node docs are explicit that "HTTP doesn't give
// SvelteKit a reliable way to know the URL that is currently being
// requested" without the ORIGIN env var (or trusted proxy headers)
// configured - url.origin can silently resolve with the wrong scheme
// (http instead of https), which would break this self-fetch outright.
// ORIGIN is now set in cloudbuild.yaml's deploy step to the same value as
// these two, but this fallback chain means a real generation failure here
// doesn't depend on that one env var alone - same resolution order already
// established in camJobs.js/drive_watcher.js for the equivalent problem.
function resolveAppOrigin(requestOrigin) {
  return PUBLIC_APP_ORIGIN || PUBLIC_SITE_URL || requestOrigin;
}

let wasmBinaryPromise = null;
function getWasmBinary(origin) {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = fetch(new URL(occtWasmUrl, origin))
      .then((res) => {
        if (!res.ok) throw new Error(`Could not fetch occt-import-js WASM binary (HTTP ${res.status})`);
        return res.arrayBuffer();
      })
      .then((buf) => new Uint8Array(buf))
      .catch((e) => { wasmBinaryPromise = null; throw e; }); // don't cache a failure - let the next request retry
  }
  return wasmBinaryPromise;
}

class CancelledError extends Error {}

// Combines the progress write AND the cancellation check into one round
// trip (conditioned on status still being 'processing' - if 0 rows match,
// something else, like the "Cancel" button, already moved this job out of
// "processing", so bail immediately instead of continuing to grind on a job
// nobody's waiting on). This used to be two separate calls (a select to
// check, an update to write) - serverless functions (Vercel) have a real
// execution time budget, and every extra network round trip to Supabase
// eats into it, so cutting this in half matters more here than it would on
// a long-running local Node process.
async function setProgress(supabase, jobId, progress, progress_message) {
  const { data, error } = await supabase
    .from('cam_jobs')
    .update({ progress, progress_message })
    .eq('id', jobId)
    .eq('status', 'processing')
    .select('id');
  if (error) {
    console.error('CAM progress update failed (non-fatal)', error);
    return; // best-effort - a network blip on a progress update must not take down generation
  }
  if (!data?.length) throw new CancelledError('Job was cancelled before generation finished');
}

// Best-effort terminal-failure write - also never allowed to throw. This is
// the single most important guarantee in this file: no matter what breaks
// above (a thrown exception, a bad STEP file, a Supabase hiccup), the job
// must always end up in a terminal status instead of sitting at "queued" /
// "processing" forever with the UI spinning indefinitely.
async function markFailed(supabase, jobId, message) {
  try {
    await supabase.from('cam_jobs').update({
      status: 'failed',
      errors: [message],
      progress_message: message
    }).eq('id', jobId);
  } catch (e) {
    console.error('CAM job failed AND the failure write itself failed - job may be stuck', jobId, e);
  }
}

// Synchronous, server-side G-code generation. Called right after a job is
// queued (auto-trigger on upload, or the /autocam manual flow) - there is no
// external Runner/queue-poller for turning or routing, since both are pure
// geometry math that finishes in well under a second for realistic profiles.
//
// Everything from the job load onward is inside one try/catch so a job can
// never get stuck at "queued"/"processing" - any failure, anywhere, gets
// written back as a specific `failed` status + error message.
export async function POST({ request, url }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const jobId = body?.jobId;
  if (!jobId) return json({ success: false, error: 'jobId is required' }, { status: 400 });

  const supabase = getClientFromRequest(request);

  try {
    const { data: job, error: loadError } = await supabase
      .from('cam_jobs')
      .select('*, cam_tools(nose_radius, diameter), cam_machines(name, controller, drive_output_folder_id), cam_materials(name, default_params)')
      .eq('id', jobId)
      .single();

    if (loadError || !job) {
      return json({ success: false, error: loadError?.message || 'Job not found' }, { status: 404 });
    }
    if (job.status !== 'queued') {
      return json({ success: false, error: `Job is already ${job.status}, not generating again` }, { status: 409 });
    }
    if (job.operation_type === 'milling') {
      // Real milling now exists, just not through this synchronous
      // turning/routing endpoint - see autocam/fusion/ (the Fusion-360-
      // backed pipeline, /autocam/fusion in the UI). A milling job created
      // through the old queueCamJobForPart/queueCamJobFromUpload flow was
      // never routed to a Runner and never will be from here; reject
      // loudly rather than leaving it stuck at "queued" forever - same
      // reasoning as every other terminal-status write in this file.
      await supabase.from('cam_jobs').update({
        status: 'rejected',
        errors: ['Milling does not run through this endpoint - use Fusion CAM (/autocam/fusion) instead']
      }).eq('id', jobId);
      return json({ success: false, error: 'Milling does not run through this endpoint - use Fusion CAM instead' }, { status: 400 });
    }
    if (!job.step_file_name) {
      await markFailed(supabase, jobId, 'No STEP file attached to this job');
      return json({ success: false, error: 'No STEP file attached to this job' }, { status: 400 });
    }

    const { data: claimData, error: claimError } = await supabase
      .from('cam_jobs')
      .update({ status: 'processing', progress: 5, progress_message: 'Downloading STEP file...' })
      .eq('id', jobId)
      .eq('status', 'queued') // compare-and-swap: only one caller can ever win the claim
      .select('id');
    if (claimError) throw new Error(`Could not claim job for processing: ${claimError.message}`);
    if (!claimData?.length) throw new CancelledError('Job was already claimed or cancelled before processing started');

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('manufacturing-files')
      .download(job.step_file_name);
    if (downloadError || !fileBlob) {
      throw new Error(downloadError?.message || 'Could not download the STEP file from storage');
    }

    await setProgress(supabase, jobId, 20, 'Loading STEP geometry parser...');
    const stepBuffer = new Uint8Array(await fileBlob.arrayBuffer());
    const wasmBinary = await getWasmBinary(resolveAppOrigin(url.origin));
    const meshes = await readStepMeshes(stepBuffer, wasmBinary);

    await setProgress(supabase, jobId, 55, 'Extracting toolpath geometry...');
    const params = { ...(job.params || {}) };
    if (job.cam_tools?.nose_radius && params.noseRadius === undefined) params.noseRadius = job.cam_tools.nose_radius;
    if (job.cam_tools?.diameter && params.toolDiameter === undefined) params.toolDiameter = job.cam_tools.diameter;
    // Routing dialect (LinuxCNC vs WinCNC) is a property of the physical
    // machine, not a per-job choice - always follows the linked Machine
    // Profile, same as gcode_extension. Turning has no dialect switch (it
    // always targets the Haas TL-1's Fanuc-dialect control - see turning.js).
    if (job.cam_machines?.controller && params.controller === undefined) params.controller = job.cam_machines.controller;

    // A material with no default_params for THIS operation contributed
    // nothing: applyMaterialDefaults is a silent no-op in that case, so the
    // job kept the generator's own generic fallback, which is tuned for
    // aluminum. The job form warns about it, but the person who fills in the
    // form is not necessarily the person standing at the machine - so the
    // generated program says it too, where it cannot be missed.
    const materialDefaults = job.cam_materials?.default_params?.[job.operation_type];
    params.materialName = job.cam_materials?.name || null;
    params.materialFeedsUnverified = !!job.cam_materials && !(materialDefaults && Object.keys(materialDefaults).length > 0);

    let result;
    if (job.operation_type === 'turning') {
      const profile = extractTurningProfileFromMeshes(meshes);
      await setProgress(supabase, jobId, 80, 'Generating turning G-code...');
      result = generateTurningGcode(profile, params);
    } else if (job.operation_type === 'tubestock') {
      const features = extractTubeFeaturesFromMeshes(meshes);
      // Resolve the operator's real-stock pick (CamParamFields.svelte's
      // "Stock" select, an id into stock.json) into the two dimensions it
      // actually promises - generateTubestockGcode compares those against
      // the STEP file's own measured cross-section and refuses to run on a
      // mismatch. Stays optional: an unresolved/unset id just skips the
      // check rather than blocking generation.
      const selectedStock = (stockData.router || []).find((s) => s.isTube && s.id === params.stockCatalogId);
      const tubestockParams = selectedStock
        ? { ...params, expectedOuterA: selectedStock.outer_width, expectedOuterB: selectedStock.outer_height }
        : params;
      await setProgress(supabase, jobId, 80, 'Generating tube stock G-code...');
      result = generateTubestockGcode(features, tubestockParams);
    } else {
      const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
      // The operator's pick from this team's real sheet stock (the routing
      // "Stock" select in CamParamFields). Its thickness is what is actually
      // on the table, so it outranks the CAD model for deciding how deep to
      // cut - and generateRoutingGcode refuses outright if the programmed
      // depth would reach past it into the spoilboard. Optional: with no
      // stock picked this behaves exactly as before, off the STEP thickness.
      const selectedSheet = (stockData.router || []).find((s) => !s.isTube && s.id === params.stockCatalogId);
      const routingParams = { ...params, measuredThickness: thickness };
      if (selectedSheet?.thickness > 0) {
        routingParams.stockThickness = selectedSheet.thickness;
        // Through-cut the real stock, with enough break-through to actually
        // free the part, rather than stopping at the model's own thickness.
        if (params.targetDepth === undefined) routingParams.targetDepth = selectedSheet.thickness + THROUGH_CUT_ALLOWANCE;
      } else if (params.targetDepth === undefined && thickness) {
        // Same break-through allowance as the stock path above, for the same
        // reason. Auto-derived depth means "cut this part out", and stopping
        // exactly ON the underside does not reliably free it: sheets are not
        // perfectly flat, spoilboards are not perfectly level, and Z-zero
        // carries setup error. Measured on four real jobs, every one had its
        // cut depth equal to the measured thickness to six decimal places -
        // zero margin on all of them.
        //
        // Cutting a hair into the spoilboard is what a spoilboard is for. A
        // depth entered by hand is left exactly as entered, since that is a
        // deliberate number and may well be a pocket rather than a profile.
        routingParams.targetDepth = thickness + THROUGH_CUT_ALLOWANCE;
      }
      await setProgress(supabase, jobId, 80, 'Generating routing G-code...');
      result = generateRoutingGcode(contours, routingParams);
      // Recorded so the job row shows the depth that was actually used.
      params.targetDepth = routingParams.targetDepth;
      params.stockThickness = routingParams.stockThickness;
    }

    const gcodeFileName = job.gcode_file_name || 'output.ngc';
    const facePrograms = (result.gcodeFiles || []).map((file) => ({
      ...file,
      fileName: tubestockFaceFileName(gcodeFileName, file.angleDeg)
    }));
    const stats = facePrograms.length
      ? { ...result.stats, facePrograms }
      : result.stats;

    // Conditioned on status still being 'processing' (compare-and-swap) so a
    // cancel that lands in the split second between the last check above and
    // this write can never get silently clobbered back to "completed". No
    // separate 95%-progress write first - it's this same write, one round
    // trip instead of two.
    const { data: updateData, error: updateError } = await supabase
      .from('cam_jobs')
      .update({
        status: 'completed',
        gcode: result.gcode,
        gcode_file_name: gcodeFileName,
        params, // includes any auto-derived values (e.g. targetDepth from STEP thickness)
        stats,
        progress: 100,
        progress_message: 'Done'
      })
      .eq('id', jobId)
      .eq('status', 'processing')
      .select('id');
    if (updateError) throw new Error(updateError.message);
    if (!updateData?.length) throw new CancelledError('Job was cancelled just before it finished');

    // Best-effort - never throws, never affects the already-successful
    // 'completed' status or this response. See deliverJobToDrive's own doc
    // comment and autocam/docs/direct-machine-file-transfer-plan.md.
    await deliverJobToDrive(
      {
        id: jobId,
        gcode: result.gcode,
        gcode_file_name: gcodeFileName,
        gcode_files: facePrograms.map((file) => ({ gcode: file.gcode, gcode_file_name: file.fileName }))
      },
      job.cam_machines
    );

    return json({ success: true, jobId, stats });
  } catch (e) {
    if (e instanceof CancelledError) {
      // The job's status already reflects whatever cancelled it (set by the
      // "Cancel" button, a delete, etc.) - don't overwrite that with a
      // generic failure message.
      return json({ success: false, error: e.message, cancelled: true }, { status: 409 });
    }
    const message = e?.message || String(e) || 'CAM generation failed';
    await markFailed(supabase, jobId, message);
    return json({ success: false, error: message }, { status: 500 });
  }
}
