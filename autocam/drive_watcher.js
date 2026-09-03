/**
 * Google Drive integration for AutoCAM, both directions - see
 * implementations/drive-watcher-cron-plan.md (input: STEP file in a folder
 * auto-triggers a job) and implementations/direct-machine-file-transfer-plan.md
 * (output: a completed job's G-code gets written to a separate Drive folder,
 * so a Drive desktop sync client on the machine's control PC picks it up
 * with no manual download - see runDriveWatcherSweep for input,
 * deliverJobToDrive for output).
 *
 * FOLDER ARCHITECTURE (explicit user requirement, not a guess): the input
 * folder (`cam_machines.drive_folder_id`) is meant to be a subfolder literally
 * named "cad" inside a larger Shared Drive structure - dropping a CAD file
 * there is the trigger. The output folder (`drive_output_folder_id`) is
 * meant to be a sibling "cammed" folder - but delivered G-code is NOT
 * dropped directly into it. Every delivery is grouped into a dated
 * subfolder ("2026-08-20", Pacific time - see todayDriveDateFolderName),
 * created on first use each day and reused for every job delivered that
 * same day. Both folder IDs are supplied directly by whoever configures a
 * machine (paste the "cad"/"cammed" folder's own ID) - this module never
 * has to search a parent for a child folder by that name.
 *
 * STATUS: built, wired up, and safe to ship with zero configuration - but
 * genuinely untested against a real Google Drive folder, because this
 * environment has no Google credentials. Both entry points below are
 * deliberate no-ops ({ ok: true, skipped: true, reason: 'not_configured' } /
 * { delivered: false, reason: 'not_configured' }) until
 * GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY is set AND the relevant
 * cam_machines.drive_folder_id / drive_output_folder_id is set for a given
 * machine. The first real sweep/delivery against a real folder should be
 * treated as unverified - watch it closely, same as every G-code file this
 * app produces gets a "run it in a simulator first" warning.
 *
 * No googleapis npm dependency - this repo has had no npm install access at
 * points in its history (see the DXF/Clipper decisions in turning.js /
 * routing.js) and Drive API v3 + a service-account OAuth2 token exchange is
 * a small enough surface to hand-roll with plain fetch() and Node's built-in
 * crypto (RS256 JWT signing) - same zero-dependency approach already used
 * elsewhere in this CAM system.
 *
 * Scope: drive.readonly (input folders) + drive.file (output folders only -
 * access to a folder the service account can already reach because it was
 * explicitly shared with it, not blanket write access to the account's whole
 * Drive). Per the plan's security notes, the service account should only
 * ever be shared with the specific folders being watched/delivered to.
 *
 * SHARED DRIVES: fully supported, and the recommended target specifically
 * for the output folder - files a service account creates in someone's
 * personal "My Drive" are attributed to the service account's own storage
 * quota, which is normally zero, and can fail with storageQuotaExceeded;
 * files created inside a Shared Drive are owned by the Shared Drive itself,
 * sidestepping that entirely. Every Drive API call below passes
 * supportsAllDrives=true (the API silently excludes Shared Drive content
 * otherwise), and getFileDriveId() detects whether a given folder lives in
 * a Shared Drive so the Changes API calls can be scoped to it correctly
 * (driveId/includeItemsFromAllDrives/corpora) - required, not optional, for
 * the input sweep to see anything happening inside a Shared Drive at all.
 */

import { createClient } from '@supabase/supabase-js';
import { normalizeGcodeComments } from './gcodeComments.js';
import { env } from '$env/dynamic/private';
import { gcodeFileNameFor } from './camJobs.js';
import { PACIFIC_TIME_ZONE } from '$lib/timezone.js';
import { getServiceAccountAccessToken as getScopedAccessToken } from '$lib/server/google_service_account.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const MAX_FILES_PER_SWEEP_PER_MACHINE = 10;
const STEP_NAME_RE = /\.(step|stp)$/i;

// Thin Drive-scoped wrapper around the generic (JWT-signing moved to
// $lib/server/google_service_account.js so the Sheets sync can mint its
// own differently-scoped token from the same credentials without
// duplicating this logic or importing from autocam/). Kept exported under
// its original name - cam-generate's completion path reaches this
// indirectly via deliverJobToDrive, not directly, but this preserves the
// same public shape either way.
export async function getServiceAccountAccessToken(serviceAccountJson) {
  return getScopedAccessToken(serviceAccountJson, DRIVE_SCOPE);
}

// supportsAllDrives=true is appended to every call here - without it, the
// Drive API silently excludes Shared Drive ("Team Drive") content from
// every operation below (listing, downloading, uploading), for backward
// compatibility with clients written before Shared Drives existed. This
// matters for real setups here, not a hypothetical - see getFileDriveId.
async function driveFetch(accessToken, path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${DRIVE_API}${path}${sep}supportsAllDrives=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive API request failed (${res.status}): ${path}`);
  return res;
}

// Which Shared Drive (if any) a folder lives in - null for a folder in
// someone's personal "My Drive". The Changes API needs to be told this
// explicitly (driveId param below) to see activity inside a Shared Drive at
// all; unlike supportsAllDrives, there's no single blanket flag for it.
async function getFileDriveId(accessToken, fileId) {
  const res = await driveFetch(accessToken, `/files/${fileId}?fields=driveId`);
  const body = await res.json();
  return body.driveId || null;
}

async function getStartPageToken(accessToken, driveId) {
  const q = driveId ? `?driveId=${encodeURIComponent(driveId)}` : '';
  const res = await driveFetch(accessToken, `/changes/startPageToken${q}`);
  const body = await res.json();
  return body.startPageToken;
}

// Walks the Changes API from `pageToken` to the end, returning every
// candidate file change plus the cursor to persist for next time. Multiple
// changes.list pages are followed within one sweep (bounded by Drive's own
// page size, not by our batch cap - the per-file batch cap below limits how
// much work one sweep actually DOES, not how much cursor-walking it needs).
// `driveId` (see getFileDriveId) scopes this to a specific Shared Drive when
// the watched folder lives in one - required, not optional, for the sweep
// to see anything happening inside a Shared Drive at all.
async function listChangesSince(accessToken, pageToken, driveId) {
  let token = pageToken;
  const changes = [];
  const scope = driveId ? `&driveId=${encodeURIComponent(driveId)}&includeItemsFromAllDrives=true&corpora=drive` : '';
  for (let guard = 0; guard < 50; guard += 1) { // hard stop - never loop forever on a misbehaving response
    const fields = 'newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,mimeType,parents,trashed))';
    const res = await driveFetch(accessToken, `/changes?pageToken=${encodeURIComponent(token)}&fields=${encodeURIComponent(fields)}&pageSize=100${scope}`);
    const body = await res.json();
    changes.push(...(body.changes || []));
    if (body.newStartPageToken) return { changes, nextPageToken: body.newStartPageToken };
    if (!body.nextPageToken) return { changes, nextPageToken: token }; // shouldn't happen per Drive's API contract, but don't lose the cursor if it does
    token = body.nextPageToken;
  }
  return { changes, nextPageToken: token };
}

async function downloadFile(accessToken, fileId) {
  const res = await driveFetch(accessToken, `/files/${fileId}?alt=media`);
  return new Uint8Array(await res.arrayBuffer());
}

// Multipart upload (metadata + content in one request) - the standard Drive
// API v3 way to create a file with content in one call. Hand-rolled (see
// file header) rather than using a client library; G-code is plain text so
// no base64/binary encoding is needed for the content part.
async function uploadFileToDriveFolder(accessToken, folderId, filename, content, mimeType = 'text/plain') {
  const boundary = `971hub-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Drive upload failed (${res.status}): ${responseBody.error?.message || res.statusText}`);
  return responseBody; // { id, name, ... }
}

// YYYY-MM-DD in the team's local (Pacific) time, not server/UTC time - a job
// finished at 11pm Pacific should land in that day's folder, not tomorrow's
// just because the server happens to be running in UTC. en-CA's date
// formatting conveniently IS YYYY-MM-DD (a standard trick), no manual
// zero-padding/reassembly needed.
export function todayDriveDateFolderName() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// Same slugify rule as gcodeFileNameFor (camJobs.js) - kept as a tiny local
// copy rather than exported/reused from there, since that function's
// contract (produce a plain "<slug>.<ext>" for one file, used all over the
// app for downloads/display) shouldn't have to know about this module's
// extra machine-prefix/collision-suffix needs.
function slugify(value, fallback) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

// HHMMSS in Pacific time - see todayDriveDateFolderName for why Pacific, not
// server/UTC time.
function nowDriveTimeSuffix() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PACIFIC_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('hour')}${get('minute')}${get('second')}`;
}

// Naming convention for a file delivered to Drive: <machine>_<part>_<HHMMSS>.<ext>
// The machine prefix and time suffix exist for one concrete reason: multiple
// machines can be (and, per the real setup this was built for, ARE) configured
// to share the SAME drive_output_folder_id, so more than one machine's output
// can land in the exact same dated folder. Without a machine prefix, two
// routers cutting a same-named part would produce ambiguous or literally
// identical filenames in that shared folder - the whole point of separate
// "cad/oldrouter" and "cad/newrouter" input folders (route to the right
// physical machine) would be lost the moment the file reaches Cammed, since
// nothing in the filename says which router actually generated it. The date
// itself is deliberately NOT repeated here (see todayDriveDateFolderName) -
// it's already the enclosing folder's name.
export function driveDeliveryFileName(job, machine) {
  const machineSlug = slugify(machine?.name, 'machine');
  const rawName = (job.gcode_file_name || 'output.ngc').replace(/\.[a-z0-9]+$/i, '');
  const partSlug = slugify(rawName, 'part');
  const ext = (job.gcode_file_name || 'output.ngc').match(/\.([a-z0-9]+)$/i)?.[1] || 'ngc';
  return `${machineSlug}_${partSlug}_${nowDriveTimeSuffix()}.${ext}`;
}

// Finds a child folder of `parentFolderId` named exactly `folderName`
// (case-sensitive, Drive's own `=` query operator), creating it if it
// doesn't exist yet. Used to group each day's delivered G-code into one
// dated subfolder ("2026-08-20") inside the machine's output folder, shared
// across every job delivered that same day - see
// implementations/drive-watcher-implementation.md's architecture note.
// `driveId` (see getFileDriveId, same pattern the input-sweep side already
// uses for the Changes API) scopes files.list to that specific Shared
// Drive - more correct AND faster than the blanket corpora=allDrives
// Google's own docs advise against, and null-safe for a folder that turns
// out to live in someone's personal My Drive instead.
async function findOrCreateDateFolder(accessToken, parentFolderId, folderName, driveId) {
  const escapedName = folderName.replace(/'/g, "\\'");
  const query = `'${parentFolderId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const scope = driveId ? `&driveId=${encodeURIComponent(driveId)}&includeItemsFromAllDrives=true&corpora=drive` : '';
  const listRes = await driveFetch(accessToken, `/files?q=${encodeURIComponent(query)}&fields=files(id,name)${scope}`);
  const listBody = await listRes.json();
  if (listBody.files?.[0]?.id) return listBody.files[0].id;

  const createRes = await fetch(`${DRIVE_API}/files?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] })
  });
  const createBody = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !createBody.id) {
    throw new Error(`Could not create Drive date folder "${folderName}" (${createRes.status}): ${createBody.error?.message || createRes.statusText}`);
  }
  return createBody.id;
}

// Cheap sanity check, not a real parse - real validation happens inside
// /api/cam-generate (readStepMeshes), which already has a hardened error
// path for garbage input. This just avoids queuing an obviously-not-a-STEP
// file (e.g. someone drops a PDF in the wrong folder) before that point.
function looksLikeStepFile(bytes) {
  const head = Buffer.from(bytes.slice(0, 256)).toString('utf8', 0, 256);
  return /ISO-10303/i.test(head);
}

function getServiceSupabase() {
  const url = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new Error('Missing SUPABASE_URL/SUPABASE_SERVICE_KEY for the Drive watcher');
  return createClient(url, serviceKey);
}

// Inserts the cam_jobs row for one newly-discovered file, using the
// mapped machine's operation_type/defaults - the exact same mechanism the
// manual "select a Machine Profile" dropdown already uses. Turning lands as
// a draft (status stays 'queued', generation is never triggered) since
// stockDiameter is a real stock-selection decision this can't guess safely -
// see the plan doc. Routing calls the existing /api/cam-generate endpoint,
// unmodified, via a service-role-authenticated internal request - no
// generation logic is duplicated here.
async function queueJobForDriveFile(supabase, machine, file, bytes, appOrigin) {
  const storagePath = `cam-jobs/drive-${file.id}-${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from('manufacturing-files')
    .upload(storagePath, bytes, { contentType: 'application/step', upsert: false });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  const { data: job, error: insertError } = await supabase
    .from('cam_jobs')
    .insert({
      name: file.name.replace(STEP_NAME_RE, ''),
      source_type: 'upload',
      operation_type: machine.operation_type,
      step_file_name: storagePath,
      material_id: machine.default_material_id || null,
      tool_id: machine.default_tool_id || null,
      machine_id: machine.id,
      params: machine.default_params || {},
      gcode_file_name: gcodeFileNameFor(file.name.replace(STEP_NAME_RE, ''), machine.gcode_extension),
      gcode_format: 'ngc',
      status: 'queued'
    })
    .select()
    .single();
  if (insertError) throw new Error(`cam_jobs insert failed: ${insertError.message}`);

  if (machine.operation_type === 'routing') {
    const res = await fetch(`${appOrigin}/api/cam-generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Service-role key as the bearer token, not a user JWT - there is no
        // logged-in user for a background sweep. Supabase evaluates RLS off
        // the JWT's own role claim regardless of which apikey built the
        // client, so this grants the same access cam-generate's service-role
        // RLS policies already allow - see migrations/20260817_cam_studio_system.sql.
        authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({ jobId: job.id })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`/api/cam-generate returned ${res.status}: ${body.error || 'unknown error'}`);
    }
  }
  // Turning: intentionally left at status='queued' - a human opens it, sets
  // stock diameter, and clicks "Save & Regenerate" from /autocam.

  return job;
}

/**
 * Runs one sweep across every cam_machines row with a drive_folder_id set.
 * Safe to call with zero configuration (returns a clear skip reason instead
 * of throwing). Never throws for a single bad file/machine - every failure
 * is caught, recorded in drive_watcher_files, and logged server-side, so one
 * corrupt file can't take down the rest of the sweep. No Slack notification -
 * check drive_watcher_files (or a completed job's own status/errors in
 * /autocam) for failures.
 */
export async function runDriveWatcherSweep({ appOrigin } = {}) {
  const serviceAccountJson = env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountJson) {
    return { ok: true, skipped: true, reason: 'not_configured', detail: 'GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY is not set' };
  }

  const supabase = getServiceSupabase();
  const { data: machines, error: machinesError } = await supabase
    .from('cam_machines')
    .select('*')
    .eq('enabled', true)
    .not('drive_folder_id', 'is', null);
  if (machinesError) throw new Error(`Could not load cam_machines: ${machinesError.message}`);
  if (!machines?.length) {
    return { ok: true, skipped: true, reason: 'no_mapped_folders', detail: 'No enabled machine has a drive_folder_id set' };
  }

  const accessToken = await getServiceAccountAccessToken(serviceAccountJson);
  const resolvedOrigin = appOrigin || env.PUBLIC_APP_ORIGIN || env.APP_ORIGIN || env.SITE_URL;
  if (!resolvedOrigin) throw new Error('No app origin available (PUBLIC_APP_ORIGIN/APP_ORIGIN/SITE_URL) - required to call /api/cam-generate');

  const results = [];
  for (const machine of machines) {
    const folderId = machine.drive_folder_id;
    try {
      const driveId = await getFileDriveId(accessToken, folderId); // null if this folder is in a personal "My Drive", the Shared Drive's ID otherwise
      const { data: state } = await supabase.from('drive_watcher_state').select('page_token').eq('folder_id', folderId).maybeSingle();
      const startToken = state?.page_token || (await getStartPageToken(accessToken, driveId));

      const { changes, nextPageToken } = await listChangesSince(accessToken, startToken, driveId);

      const candidates = changes.filter((c) =>
        !c.removed &&
        c.file &&
        !c.file.trashed &&
        STEP_NAME_RE.test(c.file.name || '') &&
        (c.file.parents || []).includes(folderId)
      );

      let queuedCount = 0;
      for (const change of candidates.slice(0, MAX_FILES_PER_SWEEP_PER_MACHINE)) {
        const file = change.file;
        const { data: already } = await supabase.from('drive_watcher_files').select('drive_file_id').eq('drive_file_id', file.id).maybeSingle();
        if (already) continue; // idempotency - never process the same Drive file twice

        try {
          const bytes = await downloadFile(accessToken, file.id);
          if (!looksLikeStepFile(bytes)) throw new Error('Downloaded file does not look like a STEP file (no ISO-10303 header)');
          const job = await queueJobForDriveFile(supabase, machine, file, bytes, resolvedOrigin);
          await supabase.from('drive_watcher_files').insert({ drive_file_id: file.id, cam_job_id: job.id, status: 'queued' });
          queuedCount += 1;
        } catch (fileError) {
          const message = fileError?.message || String(fileError);
          await supabase.from('drive_watcher_files').insert({ drive_file_id: file.id, status: 'failed', error: message });
          console.error(`Drive watcher: "${file.name}" in folder mapped to "${machine.name}" failed to queue`, message);
        }
      }

      await supabase.from('drive_watcher_state').upsert({ folder_id: folderId, page_token: nextPageToken, updated_at: new Date().toISOString() });
      results.push({ machineId: machine.id, machineName: machine.name, folderId, candidates: candidates.length, queued: queuedCount });
    } catch (machineError) {
      const message = machineError?.message || String(machineError);
      console.error(`Drive watcher: sweep failed for machine "${machine.name}"`, message);
      results.push({ machineId: machine.id, machineName: machine.name, folderId, error: message });
    }
  }

  return { ok: true, skipped: false, results };
}

/**
 * OUTPUT side: after a job completes, if its machine has a
 * drive_output_folder_id configured, upload the finished G-code into that
 * day's dated subfolder ("2026-08-20", created if this is the first
 * delivery today, reused for every later one the same day - see
 * findOrCreateDateFolder/todayDriveDateFolderName and the file header's
 * FOLDER ARCHITECTURE note) so a Drive desktop sync client on the machine's
 * control PC picks it up with no manual download - see
 * implementations/direct-machine-file-transfer-plan.md. Applies to ANY
 * completed job on that machine, not just Drive-triggered ones - delivery
 * is a property of the machine, not of how the job started.
 *
 * Never throws - called as a best-effort step after a job is already marked
 * 'completed' (see /api/cam-generate/+server.js); a Drive delivery failure
 * must not affect the job's status or the response to whoever triggered
 * generation. Safe with zero configuration (returns a clear skip reason).
 *
 * @param {Object} job - a cam_jobs row with gcode/gcode_file_name populated;
 *   tube jobs may additionally supply gcode_files for one output per face.
 * @param {Object} machine - the linked cam_machines row (needs drive_output_folder_id)
 */
export async function deliverJobToDrive(job, machine) {
  if (!machine?.drive_output_folder_id) return { delivered: false, reason: 'not_configured' };
  const serviceAccountJson = env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountJson) return { delivered: false, reason: 'not_configured' };
  const outputs = Array.isArray(job?.gcode_files) && job.gcode_files.length
    ? job.gcode_files
    : (job?.gcode ? [{ gcode: job.gcode, gcode_file_name: job.gcode_file_name }] : []);
  if (!outputs.length) return { delivered: false, reason: 'no_gcode' };

  try {
    const accessToken = await getServiceAccountAccessToken(serviceAccountJson);
    const driveId = await getFileDriveId(accessToken, machine.drive_output_folder_id);
    const dateFolderName = todayDriveDateFolderName();
    const dateFolderId = await findOrCreateDateFolder(accessToken, machine.drive_output_folder_id, dateFolderName, driveId);
    const filenames = [];
    for (const output of outputs) {
      const filename = driveDeliveryFileName({ ...job, ...output }, machine);
      // Same normalisation as the download path - a file delivered to the
      // machine's Drive folder is run directly, so it must not carry a
      // nested comment that closes early and leaves live text behind it.
      await uploadFileToDriveFolder(accessToken, dateFolderId, filename, normalizeGcodeComments(output.gcode, { dialect: 'preserve' }), 'text/plain');
      filenames.push(filename);
    }
    return { delivered: true, dateFolder: dateFolderName, filenames };
  } catch (e) {
    const message = e?.message || String(e);
    console.error(`Drive watcher: delivery failed for job ${job.id} (machine "${machine.name}")`, message);
    return { delivered: false, reason: 'error', error: message };
  }
}
