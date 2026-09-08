/**
 * Data layer for Fusion CAM - the Fusion-360-backed milling pipeline
 * (autocam/fusion/).
 * Mirrors camJobs.js's role for the existing turning/routing pipeline:
 * shared Supabase helpers used by the /autocam/fusion UI, kept in one
 * place so job/part/plate creation stays consistent.
 *
 * Job queue: Fusion milling jobs are just cam_jobs rows with
 * operation_type='milling' - reusing the exact same queue/status lifecycle
 * turning/routing jobs use (see cam-generate/+server.js), not a separate
 * table. The Fusion-specific payload (which plate or box tube this job is
 * for, what kind of operation) lives in cam_jobs.params as
 * { fusionJobKind: 'plate:cam' | 'plate:arrange' | 'box_tube', plateId, boxTubeId }.
 * A Runner claims/completes these via /api/fusion-runner, not this file -
 * this file is for the browser UI (creating catalog rows, queuing jobs,
 * reading status), same separation camJobs.js already has from
 * cam-generate/+server.js.
 */

import { supabase } from '$lib/supabase.js';

export const FUSION_JOB_KINDS = ['plate:arrange', 'plate:cam', 'box_tube'];
export const FUSION_OUTPUT_JOB_KINDS = ['plate:cam', 'box_tube'];

export function isFusionOutputJob(job) {
  return FUSION_OUTPUT_JOB_KINDS.includes(job?.params?.fusionJobKind);
}
// How many jobs the Job Queue tab loads before someone asks for more.
// Sized to fill the visible list on a normal screen without paying for the
// rest of the history up front.
export const FUSION_JOB_PAGE_SIZE = 25;

// Deliberately excludes step_file_name, gcode, and fusion_nc_files. The NC
// artifacts are base64 and can dwarf every other field; fetch them only
// when someone actually asks to download/post a completed job.
const FUSION_JOB_SELECT = 'id, name, source_type, part_id, operation_type, params, material_id, tool_id, machine_id, status, claimed_by, claimed_at, errors, warnings, stats, progress, progress_message, requested_by, created_at, updated_at, cam_machines(name, controller), cam_tools(name, diameter)';
const FUSION_JOB_UPDATE_SELECT = 'id, status, claimed_by, claimed_at, errors, warnings, stats, progress, progress_message, updated_at';

async function uploadFusionStep({ name, fallback, stepFile }) {
  if (!stepFile) return null;
  const extension = stepFile.name.split('.').pop() || 'step';
  const safeName = (name || fallback).replace(/[^a-zA-Z0-9]/g, '_');
  const path = `${crypto.randomUUID()}_${safeName}_fusion.${extension}`;
  const { error } = await supabase.storage.from('manufacturing-files')
    .upload(path, stepFile, { cacheControl: '3600', upsert: false });
  if (error) throw new Error(error.message || 'Failed to upload STEP file');
  return path;
}

async function removeFailedFusionUpload(path, insertError) {
  if (path) {
    try {
      const { error } = await supabase.storage.from('manufacturing-files').remove([path]);
      if (error) console.error(`Could not remove orphaned Fusion upload ${path}`, error);
    } catch (error) {
      console.error(`Could not remove orphaned Fusion upload ${path}`, error);
    }
  }
  throw insertError;
}

/* ── Part categories (material + thickness groupings) ───────────────── */

export async function fetchPartCategories() {
  const { data, error } = await supabase
    .from('fusion_part_categories')
    .select('*, cam_materials(name, category)')
    .order('thickness');
  if (error) throw error;
  return data || [];
}

export async function createPartCategory({ materialId, thickness }) {
  const { data, error } = await supabase
    .from('fusion_part_categories')
    .insert({ material_id: materialId, thickness })
    .select('*, cam_materials(name, category)')
    .single();
  if (error) throw error;
  return data;
}

export async function deletePartCategory(id) {
  const { error } = await supabase.from('fusion_part_categories').delete().eq('id', id);
  if (error) throw error;
}

/* ── Parts (a named quantity of a category's stock) ──────────────────── */

export async function fetchParts() {
  const { data, error } = await supabase
    .from('fusion_parts')
    .select('*, fusion_part_categories(thickness, cam_materials(name, category)), parts(id, name, project_id, workflow)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Creates a part row, optionally uploading a STEP file to the shared
 * manufacturing-files bucket first - same bucket/naming pattern
 * manufacture/+page.svelte already uses for turning/routing parts.
 *
 * partId (optional) links this Fusion part to a real manufacturing request
 * (public.parts) - see the migration this shipped with for why it's
 * nullable. Not every Fusion CAM part is for an existing request.
 */
export async function createPart({ name, epic, ticket, quantity, categoryId, stepFile, createdBy, partId, fusionFileName }) {
  const stepFileName = await uploadFusionStep({ name, fallback: 'part', stepFile });

  // No spaces - this becomes the Fusion document name (camPlate.py) and
  // feeds the exported G-code path, both of which treat it as one token.
  // Matches the DB check constraint (fusion_parts_fusion_file_name_no_spaces).
  const cleanedFusionFileName = fusionFileName ? fusionFileName.trim().replace(/\s+/g, '') : null;

  const { data, error } = await supabase
    .from('fusion_parts')
    .insert({
      name,
      epic: epic || null,
      ticket: ticket || null,
      quantity: quantity ?? 0,
      original_quantity: quantity ?? 0,
      category_id: categoryId,
      step_file_name: stepFileName,
      created_by: createdBy || null,
      part_id: partId || null,
      fusion_file_name: cleanedFusionFileName || null
    })
    .select('*, fusion_part_categories(thickness, cam_materials(name, category)), parts(id, name, project_id, workflow)')
    .single();
  if (error) await removeFailedFusionUpload(stepFileName, error);
  return data;
}

export async function renamePart(id, name) {
  const { data, error } = await supabase
    .from('fusion_parts')
    .update({ name })
    .eq('id', id)
    .select('*, fusion_part_categories(thickness, cam_materials(name, category)), parts(id, name, project_id, workflow)')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Changes how many of a part actually exist, not just how many are still
 * unassigned. `quantity` means "still unassigned to any plate" (see
 * assignPartToPlate's own doc comment) - editing it directly would silently
 * change how many are considered nested without changing the real total.
 * Takes the new true total (`original_quantity`) and shifts `quantity` by
 * the same delta, so however many are already nested elsewhere stays
 * untouched - increasing the total makes more available to nest, decreasing
 * it removes from what's available (never from what's already nested).
 */
export async function updatePartQuantity(id, newOriginalQuantity) {
  const { data: part, error: fetchError } = await supabase
    .from('fusion_parts')
    .select('quantity, original_quantity, part_id')
    .eq('id', id)
    .single();
  if (fetchError) throw fetchError;

  const alreadyNested = part.original_quantity - part.quantity;
  if (newOriginalQuantity < alreadyNested) {
    throw new Error(`Can't go below ${alreadyNested} - that many are already nested onto a plate`);
  }

  const { data, error } = await supabase
    .from('fusion_parts')
    .update({ original_quantity: newOriginalQuantity, quantity: newOriginalQuantity - alreadyNested })
    .eq('id', id)
    .select('*, fusion_part_categories(thickness, cam_materials(name, category)), parts(id, name, project_id, workflow)')
    .single();
  if (error) throw error;

  // A linked Fusion row is the CAM representation of this manufacturing
  // request, not an independent demand count.  Keep the request's quantity
  // aligned whenever an operator changes the total from Fusion CAM.
  if (part.part_id) {
    const { error: linkedPartError } = await supabase
      .from('parts')
      .update({ quantity: newOriginalQuantity, updated_at: new Date().toISOString() })
      .eq('id', part.part_id);
    if (linkedPartError) throw linkedPartError;
  }
  return data;
}

export async function deletePart(id) {
  const { error } = await supabase.from('fusion_parts').delete().eq('id', id);
  if (error) throw error;
}

/* ── Plates (stock parts get nested onto) ─────────────────────────────── */

export async function fetchPlates() {
  const { data, error } = await supabase
    .from('fusion_plates')
    .select('*, fusion_part_categories(material_id, thickness, cam_materials(name, category)), fusion_part_category_assignments(quantity, fusion_parts(id, name))')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createPlate({ name, width, length, trueDepth, categoryId }) {
  const { data, error } = await supabase
    .from('fusion_plates')
    .insert({ name, width, length, true_depth: trueDepth, category_id: categoryId })
    .select('*, fusion_part_categories(material_id, thickness, cam_materials(name, category))')
    .single();
  if (error) throw error;
  return data;
}

export async function renamePlate(id, name) {
  const { data, error } = await supabase
    .from('fusion_plates')
    .update({ name })
    .eq('id', id)
    .select('*, fusion_part_categories(material_id, thickness, cam_materials(name, category))')
    .single();
  if (error) throw error;
  return data;
}

export async function deletePlate(id) {
  const { error } = await supabase.from('fusion_plates').delete().eq('id', id);
  if (error) throw error;
}

/** Set the total on this plate. Database triggers validate stock and update inventory atomically. */
export async function assignPartToPlate({ categoryId, plateId, partId, quantity }) {
  if (!categoryId || !plateId || !partId || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error('Choose matching stock and a positive whole-number quantity');
  }
  const { data, error } = await supabase
    .from('fusion_part_category_assignments')
    .upsert({ category_id: categoryId, plate_id: plateId, part_id: partId, quantity }, { onConflict: 'plate_id,part_id' })
    .select().single();
  if (error) throw error;
  return data;
}

/** The deletion trigger restores inventory, including plate cascade deletes. */
export async function removePartFromPlate({ plateId, partId }) {
  if (!plateId || !partId) throw new Error('Plate and part are required');
  const { error } = await supabase.from('fusion_part_category_assignments')
    .delete().eq('plate_id', plateId).eq('part_id', partId);
  if (error) throw error;
}

/* ── Box tubes ─────────────────────────────────────────────────────────── */

export async function fetchBoxTubes() {
  const { data, error } = await supabase
    .from('fusion_box_tubes')
    .select('*, parts(id, name, project_id, workflow)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// partId (optional) links this box tube to a real manufacturing request -
// see createPart's own doc comment, same reasoning.
export async function createBoxTube({ name, epic, ticket, quantity, stepFile, createdBy, partId }) {
  const stepFileName = await uploadFusionStep({ name, fallback: 'boxtube', stepFile });

  const { data, error } = await supabase
    .from('fusion_box_tubes')
    .insert({
      name,
      epic: epic || null,
      ticket: ticket || null,
      quantity: quantity ?? 1,
      step_file_name: stepFileName,
      created_by: createdBy || null,
      part_id: partId || null
    })
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) await removeFailedFusionUpload(stepFileName, error);
  return data;
}

export async function deleteBoxTube(id) {
  const { error } = await supabase.from('fusion_box_tubes').delete().eq('id', id);
  if (error) throw error;
}

/* ── Job queue (reuses cam_jobs - see file header) ───────────────────── */

/**
 * One page of milling jobs, newest first.
 *
 * Paged rather than "the most recent 200 in one request": a real queue of
 * 175 jobs was 290KB and ~340ms before a single row rendered, and almost
 * none of it is what someone opening this tab is looking at - they want the
 * few most recent jobs. Older ones load on request instead.
 *
 * Returns { jobs, hasMore } - hasMore is resolved by asking for one row
 * past the page and reporting whether it existed, which avoids a second
 * count() round-trip just to decide whether to show a "Load more" button.
 */
export async function fetchFusionJobs({ offset = 0, limit = FUSION_JOB_PAGE_SIZE } = {}) {
  const { data, error } = await supabase
    .from('cam_jobs')
    .select(FUSION_JOB_SELECT)
    .eq('operation_type', 'milling')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit); // one extra row: presence of it means there is another page
  if (error) throw error;
  const rows = data || [];
  return { jobs: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * STEP file paths for a set of fusion_parts ids, as { partId: stepFileName }.
 *
 * A Fusion job's own cam_jobs.step_file_name is always null - the CAD lives
 * on the fusion_parts row the job was queued for, reachable through
 * params.selectedPartId - so "View CAD" has to resolve it separately.
 *
 * Batched into one request for a whole page of jobs rather than one per
 * row, and selecting only the two columns needed, so showing the button
 * does not undo the paging work in fetchFusionJobs.
 */
export async function fetchFusionPartStepFiles(partIds) {
  const ids = [...new Set((partIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from('fusion_parts')
    .select('id, step_file_name')
    .in('id', ids)
    .not('step_file_name', 'is', null);
  if (error) throw error;
  return Object.fromEntries((data || []).map((part) => [part.id, part.step_file_name]));
}

/**
 * "Install CAD" for a Fusion part/job - downloads its real STEP file from
 * storage. Same signed-URL-then-open-in-a-new-tab technique
 * manufacture/+page.svelte's installCadStepFile/downloadFromStorage
 * already use for turning/routing parts, generalized here since every
 * Fusion CAM STEP file lives in the same 'manufacturing-files' bucket
 * (see uploadFusionStep above) regardless of whether it's reached through
 * fusion_parts directly or through a job's params.selectedPartId (see
 * fetchFusionPartStepFiles).
 */
export async function installFusionPartCad(stepFileName) {
  if (!stepFileName) throw new Error('This part has no STEP file to install');
  let { data, error } = await supabase.storage
    .from('manufacturing-files')
    .createSignedUrl(stepFileName, 60);
  // The stored name can be URL-encoded in some older rows - matches the
  // same decode-and-retry manufacture/+page.svelte's downloadFromStorage
  // already does for the identical bucket/naming scheme.
  if (error && error.message?.includes('Object not found')) {
    const decoded = decodeURIComponent(stepFileName);
    ({ data, error } = await supabase.storage.from('manufacturing-files').createSignedUrl(decoded, 60));
  }
  if (error) throw new Error(error.message || 'Could not create a download link for this STEP file');
  return data.signedUrl;
}

/** Refresh only mutable fields for the handful of jobs a Runner can change. */
export async function fetchFusionJobUpdates(jobIds) {
  const ids = [...new Set((jobIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await supabase.from('cam_jobs')
    .select(FUSION_JOB_UPDATE_SELECT)
    .eq('operation_type', 'milling')
    .in('id', ids);
  if (error) throw error;
  return data || [];
}

/** Load the heavy base64 output for one completed job on demand. */
export async function fetchFusionJobNcFiles(jobId) {
  if (!jobId) throw new Error('Job is required');
  const { data, error } = await supabase.from('cam_jobs')
    .select('fusion_nc_files')
    .eq('id', jobId)
    .eq('operation_type', 'milling')
    .eq('status', 'completed')
    .single();
  if (error) throw error;
  return data?.fusion_nc_files || [];
}

/**
 * Maps manufacturing request ids (public.parts.id) to the most recent Fusion
 * milling job that actually covers them - traced through
 * fusion_parts/fusion_box_tubes (linked via their own part_id) to whichever
 * plate or box tube they were nested/queued onto, then to that plate/tube's
 * most recent milling cam_jobs row. Used by /manufacture to show real Fusion
 * CAM status next to a request instead of the old per-part legacy AutoCAM
 * job (which queued directly against the part - Fusion CAM's nest-many-
 * parts-onto-one-plate model means the job a request cares about is one
 * step removed, so this does that lookup once for a whole list of requests
 * rather than each caller re-deriving it).
 *
 * A request with no linked Fusion part, or a Fusion part never nested onto
 * anything queued yet, simply has no entry in the returned map.
 */
export async function fetchFusionJobsByManufacturingPartIds(partIds) {
  const ids = [...new Set((partIds || []).filter(Boolean))];
  if (!ids.length) return {};

  const [{ data: fParts, error: fPartsError }, { data: fTubes, error: fTubesError }] = await Promise.all([
    supabase.from('fusion_parts').select('id, part_id').in('part_id', ids),
    supabase.from('fusion_box_tubes').select('id, part_id').in('part_id', ids)
  ]);
  if (fPartsError) throw fPartsError;
  if (fTubesError) throw fTubesError;

  const fusionPartIds = (fParts || []).map((fp) => fp.id);
  let assignments = [];
  if (fusionPartIds.length) {
    const { data, error } = await supabase
      .from('fusion_part_category_assignments')
      .select('part_id, plate_id')
      .in('part_id', fusionPartIds);
    if (error) throw error;
    assignments = data || [];
  }

  // plateId -> Set of manufacturing part ids nested onto it
  const plateToManufacturingParts = new Map();
  const fusionPartToManufacturingPart = new Map((fParts || []).map((fp) => [fp.id, fp.part_id]));
  for (const a of assignments) {
    const mpId = fusionPartToManufacturingPart.get(a.part_id);
    if (!mpId) continue;
    if (!plateToManufacturingParts.has(a.plate_id)) plateToManufacturingParts.set(a.plate_id, new Set());
    plateToManufacturingParts.get(a.plate_id).add(mpId);
  }

  // boxTubeId -> manufacturing part id (1:1 - see createBoxTube's own doc comment)
  const boxTubeToManufacturingPart = new Map((fTubes || []).filter((t) => t.part_id).map((t) => [t.id, t.part_id]));

  if (!plateToManufacturingParts.size && !boxTubeToManufacturingPart.size) return {};

  const targetQueries = [];
  const plateIds = [...plateToManufacturingParts.keys()];
  const boxTubeIds = [...boxTubeToManufacturingPart.keys()];
  if (plateIds.length) {
    targetQueries.push(supabase.from('cam_jobs').select(FUSION_JOB_SELECT)
      .eq('operation_type', 'milling').in('params->>plateId', plateIds));
  }
  if (boxTubeIds.length) {
    targetQueries.push(supabase.from('cam_jobs').select(FUSION_JOB_SELECT)
      .eq('operation_type', 'milling').in('params->>boxTubeId', boxTubeIds));
  }
  const queryResults = await Promise.all(targetQueries);
  const jobs = [];
  for (const { data, error } of queryResults) {
    if (error) throw error;
    jobs.push(...(data || []));
  }
  jobs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const result = {};
  for (const job of jobs) {
    // Arrangement is a Fusion operation, but it does not generate machine
    // output. Manufacturing cards must reflect only a real CAM run; otherwise
    // a newer completed arrange job masks the plate:cam job and falsely
    // advertises downloadable/reviewable G-code.
    if (!isFusionOutputJob(job)) continue;
    const plateId = job.params?.plateId;
    const boxTubeId = job.params?.boxTubeId;
    const mpIds = new Set();
    if (plateId && plateToManufacturingParts.has(plateId)) {
      for (const id of plateToManufacturingParts.get(plateId)) mpIds.add(id);
    }
    if (boxTubeId && boxTubeToManufacturingPart.has(boxTubeId)) {
      mpIds.add(boxTubeToManufacturingPart.get(boxTubeId));
    }
    for (const mpId of mpIds) {
      if (!result[mpId]) result[mpId] = job; // first match wins - jobs is already newest-first
    }
  }
  return result;
}

/**
 * Reads the cached Fusion Data Panel folder tree for the given project
 * (default FUSION_DATA_PROJECT_NAME's real value, "2026 Season CAM") -
 * pushed up by a live Runner (see SpartanRoboticsAutoCAM.py's
 * _sync_data_folders and the "sync-folders" action on /api/fusion-runner).
 * The web app has no direct connection to Fusion's Data Panel, so this can
 * be stale (as of the last sync) or missing (no Runner has synced yet) -
 * callers should handle a null return.
 */
export async function fetchFusionFolderTree(projectName = '2026 Season CAM') {
  const { data, error } = await supabase
    .from('fusion_data_folders')
    .select('*')
    .eq('project_name', projectName)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Queues a Fusion milling job against a plate or a box tube - a cam_jobs
 * row with operation_type='milling', status='queued', and the matching stock
 * reference. Plate jobs carry a plate snapshot/grouping contract; box-tube
 * jobs are deliberately direct and carry only boxTubeId. A tube cannot be
 * nested on a plate and must never acquire plate/grouping fields by accident.
 * Left at 'queued' for a Runner to claim via
 * /api/fusion-runner - no synchronous generation happens here (unlike
 * turning/routing's cam-generate, this genuinely needs an external Fusion
 * 360 process).
 */
export async function queueFusionJob({ fusionJobKind, plateId, boxTubeId, machineId, materialId, toolId, requestedBy, name, partId, groupingMode, selectedPartId, selectedPartIds, fusionFileName, fusionFolderPath }) {
  if (!FUSION_JOB_KINDS.includes(fusionJobKind)) {
    throw new Error(`Invalid fusionJobKind: ${fusionJobKind}`);
  }
  if (fusionJobKind === 'box_tube' && !boxTubeId) {
    throw new Error('A box tube is required for a tube-stock CAM job');
  }
  const params = {
    fusionJobKind,
    ...(fusionJobKind.startsWith('plate:') ? {
      plateId: plateId || null,
      fusionGroupingMode: groupingMode,
      selectedPartId: selectedPartId || null,
      selectedPartIds: Array.isArray(selectedPartIds) ? selectedPartIds : null
    } : { boxTubeId }),
    // Where the saved Fusion document goes and what it's named - chosen at
    // queue time (Plates tab). Optional; camPlate.py falls back to its
    // existing defaults when these aren't set.
    fusionFileName: fusionFileName || null,
    fusionFolderPath: fusionFolderPath || null
  };
  const { data, error } = await supabase
    .from('cam_jobs')
    .insert({
      name: name || null,
      source_type: 'upload',
      operation_type: 'milling',
      params,
      material_id: materialId || null,
      tool_id: toolId || null,
      machine_id: machineId || null,
      status: 'queued',
      requested_by: requestedBy || null,
      // Only ever set for a box-tube job (a clean 1:1) - a plate job leaves
      // this null, since a plate nests many parts that may be for several
      // (or no) requests at once; see the migration this shipped with.
      part_id: partId || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function cancelFusionJob(id) {
  const { data, error } = await supabase
    .from('cam_jobs')
    .update({ status: 'failed', errors: ['Cancelled by user'] })
    .eq('id', id)
    .eq('operation_type', 'milling')
    .in('status', ['queued', 'claimed', 'processing'])
    .select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('Fusion job is no longer active');
}

/** Delete a queued or terminal Fusion job. Active Runner work must be cancelled first. */
export async function deleteFusionJob(id) {
  if (!id) throw new Error('Job is required');
  const { data, error } = await supabase
    .from('cam_jobs')
    .delete()
    .eq('id', id)
    .eq('operation_type', 'milling')
    .in('status', ['queued', 'completed', 'failed', 'rejected'])
    .select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('Active Fusion jobs must be cancelled before deletion');
}

/**
 * Delete every failed Fusion job in one request, not one row at a time -
 * a job queue can accumulate dozens of failed rows from iterating on CAM
 * logic, and each one carries a real errors/warnings payload the jobs
 * list has to fetch and render. `.eq('status', 'failed')` is itself the
 * safety scope: this can never touch a queued/claimed/processing job,
 * same as deleteFusionJob's own status allowlist.
 *
 * Returns the count actually deleted, so the caller can report a real
 * number rather than assuming the whole visible list was failed.
 */
export async function deleteAllFailedFusionJobs() {
  const { data, error } = await supabase
    .from('cam_jobs')
    .delete()
    .eq('operation_type', 'milling')
    .eq('status', 'failed')
    .select('id');
  if (error) throw error;
  return data?.length || 0;
}
