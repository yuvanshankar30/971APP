// Job-claim API for the Fusion CAM Runner (autocam/fusion/runner/ - a fork
// of Team Valor 6800's open-source AutoCAM Runner add-in). Polled by an
// external Fusion 360 machine, not called from the browser - authenticated
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

function getServiceSupabase() {
  const url = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  return createClient(url, serviceKey);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claims the oldest queued milling job for this runner. Two-step: find a
// candidate, then CAS it - a plain "UPDATE ... ORDER BY ... LIMIT 1" isn't
// expressible via PostgREST, so this accepts a narrow, harmless race (two
// runners might both pick the SAME candidate id) that the CAS below always
// resolves correctly (only one caller's conditional UPDATE ever matches).
//
// machineId (optional): a Runner that declares which cam_machines row it
// physically is (autocam/fusion/runner/config.py's RUNNER_MACHINE_ID) only
// claims jobs that are either unassigned to a specific machine
// (cam_jobs.machine_id IS NULL) or assigned to its own - so a router's
// Runner can't accidentally grab a job queued for the mill, and vice versa,
// once multiple physical machines are polling at once. A Runner that
// doesn't declare a machineId (not yet configured, or a genuinely
// single-machine deployment) falls back to the original claim-anything
// behavior, so this stays backward compatible rather than a breaking
// requirement.
async function claimNextJob(supabase, runnerId, machineId) {
  let query = supabase
    .from('cam_jobs')
    .select('id')
    .eq('status', 'queued')
    .eq('operation_type', 'milling')
    .order('created_at', { ascending: true })
    .limit(5);
  if (machineId) {
    query = query.or(`machine_id.is.null,machine_id.eq.${machineId}`);
  }
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
    if (claimError) continue; // lost the race on this one (or a real error) - try the next candidate
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
  const supabase = getServiceSupabase();

  try {
    if (action === 'claim') {
      const runnerId = String(body?.runnerId || '').trim();
      if (!runnerId) return json({ error: 'runnerId is required' }, { status: 400 });
      // Only trusted as a raw PostgREST .or() filter fragment once validated
      // as a real UUID shape - unlike .eq(), .or() takes a raw string, so an
      // unvalidated value here would be a filter-injection risk.
      const rawMachineId = body?.machineId;
      if (rawMachineId != null && rawMachineId !== '' && (typeof rawMachineId !== 'string' || !UUID_RE.test(rawMachineId))) {
        return json({ error: 'machineId must be a UUID' }, { status: 400 });
      }
      const machineId = typeof rawMachineId === 'string' && UUID_RE.test(rawMachineId) ? rawMachineId : null;
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
    if (!jobId) return json({ error: 'jobId is required' }, { status: 400 });

    if (action === 'processing') {
      const { data, error } = await supabase
        .from('cam_jobs')
        .update({ status: 'processing', progress: body?.progress ?? 10, progress_message: body?.progressMessage || 'Fusion Runner processing...' })
        .eq('id', jobId)
        .eq('operation_type', 'milling')
        .eq('status', 'claimed') // CAS: only the runner that actually claimed it can move it to processing
        .select('id');
      if (error) throw new Error(error.message);
      if (!data?.length) return json({ error: 'Job was not in the claimed state (already progressed, cancelled, or claimed by another runner)' }, { status: 409 });
      return json({ success: true });
    }

    if (action === 'complete') {
      const { data, error } = await supabase
        .from('cam_jobs')
        .update({
          status: 'completed',
          gcode: body?.gcode,
          gcode_file_name: body?.gcodeFileName || 'output.ngc',
          stats: body?.stats || null,
          progress: 100,
          progress_message: 'Done'
        })
        .eq('id', jobId)
        .eq('operation_type', 'milling')
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
      }).eq('id', jobId).eq('operation_type', 'milling').in('status', ['claimed', 'processing']).select('id');
      if (error) throw error;
      if (!data?.length) return json({ error: 'Job is not an active Fusion job' }, { status: 409 });
      return json({ success: true });
    }

    return json({ error: `Unknown action: ${action}. Expected one of: claim, processing, complete, fail` }, { status: 400 });
  } catch (error) {
    return json({ error: error?.message || 'Internal server error' }, { status: 500 });
  }
}
