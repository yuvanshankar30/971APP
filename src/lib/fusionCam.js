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

export const FUSION_JOB_KINDS = ['plate:arrange', 'plate:cam', 'box_tube', 'turning'];
export const FUSION_OUTPUT_JOB_KINDS = ['plate:cam', 'box_tube', 'turning'];

// The only two lathe programs HandleSpacer.py/HandleHexShaft.py implement -
// see autocam/fusion/runner/commands/ for both. Kept here (not inferred from
// the Runner) so the UI's own dropdown/validation never drifts from what the
// Runner can actually run.
export const TURNING_CAM_TYPES = [
  { value: 'spacer', label: 'Spacer' },
  { value: 'hexShaft', label: 'Hex Shaft' }
];

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
const FUSION_JOB_SELECT = 'id, name, source_type, part_id, operation_type, params, material_id, tool_id, machine_id, status, claimed_by, claimed_at, errors, warnings, stats, progress, progress_message, requested_by, created_at, updated_at, cam_machines(name, controller), cam_tools(name, diameter), cam_materials(name)';
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
export async function createPart({ name, epic, ticket, quantity, categoryId, stepFile, createdBy, partId, fusionFileName, projectId, stockAssignment }) {
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
      fusion_file_name: cleanedFusionFileName || null,
      project_id: projectId || null,
      stock_assignment: stockAssignment || null
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
 * Attaches or replaces a part's STEP file after it already exists. Real
 * gap this closes: a part created without CAD (or with a corrected STEP
 * needed later) had no way to fix that other than deleting and recreating
 * the whole record - losing its quantity history, plate assignment, and
 * any linked manufacturing request in the process. The old file (if any)
 * is left in storage, same as deletePart already leaves a deleted part's
 * file behind - this app does not garbage-collect orphaned uploads.
 */
export async function updatePartStepFile(id, stepFile) {
  const stepFileName = await uploadFusionStep({ name: id, fallback: 'part', stepFile });
  const { data, error } = await supabase
    .from('fusion_parts')
    .update({ step_file_name: stepFileName })
    .eq('id', id)
    .select('*, fusion_part_categories(thickness, cam_materials(name, category)), parts(id, name, project_id, workflow)')
    .single();
  if (error) await removeFailedFusionUpload(stepFileName, error);
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

/** Delete every selected part in one request, not one row at a time. */
export async function deleteParts(ids) {
  if (!ids?.length) return 0;
  const { data, error } = await supabase.from('fusion_parts').delete().in('id', ids).select('id');
  if (error) throw error;
  return data?.length || 0;
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
export async function createBoxTube({ name, epic, ticket, quantity, stepFile, createdBy, partId, projectId, stockAssignment }) {
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
      part_id: partId || null,
      project_id: projectId || null,
      stock_assignment: stockAssignment || null
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

/** Delete every selected tube-stock entry in one request, not one row at a time. */
export async function deleteBoxTubes(ids) {
  if (!ids?.length) return 0;
  const { data, error } = await supabase.from('fusion_box_tubes').delete().in('id', ids).select('id');
  if (error) throw error;
  return data?.length || 0;
}

export async function renameBoxTube(id, name) {
  const cleanedName = name?.trim();
  if (!cleanedName) throw new Error('Tube stock name is required');
  const { data, error } = await supabase
    .from('fusion_box_tubes')
    .update({ name: cleanedName })
    .eq('id', id)
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) throw error;
  return data;
}

/** Attaches or replaces a box tube's STEP file - see updatePartStepFile's own docstring. */
export async function updateBoxTubeStepFile(id, stepFile) {
  const stepFileName = await uploadFusionStep({ name: id, fallback: 'boxtube', stepFile });
  const { data, error } = await supabase
    .from('fusion_box_tubes')
    .update({ step_file_name: stepFileName })
    .eq('id', id)
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) await removeFailedFusionUpload(stepFileName, error);
  return data;
}

export async function updateBoxTubeQuantity(id, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('Quantity must be a whole number, zero or more');
  }
  const { data: existing, error: existingError } = await supabase
    .from('fusion_box_tubes')
    .select('part_id')
    .eq('id', id)
    .single();
  if (existingError) throw existingError;
  const { data, error } = await supabase
    .from('fusion_box_tubes')
    .update({ quantity })
    .eq('id', id)
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) throw error;
  if (existing.part_id) {
    const { error: linkedPartError } = await supabase
      .from('parts')
      .update({ quantity, updated_at: new Date().toISOString() })
      .eq('id', existing.part_id);
    if (linkedPartError) throw linkedPartError;
  }
  return data;
}

/* ── Turning stock (spacers/hex shafts - autocam/fusion/runner's lathe pipeline) ── */

export async function fetchTurningParts() {
  const { data, error } = await supabase
    .from('fusion_turning_parts')
    .select('*, parts(id, name, project_id, workflow)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// partId (optional) links this turning part to a real manufacturing request -
// see createPart's own doc comment, same reasoning. tailstockLengthIn is
// optional - both HandleSpacer.py and HandleHexShaft.py default it to the
// part's own measured length when not set, so leaving it blank is the normal
// case, not a missing input.
export async function createTurningPart({ name, epic, ticket, quantity, camType, tailstockLengthIn, stepFile, createdBy, partId, projectId, stockAssignment }) {
  if (!TURNING_CAM_TYPES.some((t) => t.value === camType)) {
    throw new Error(`Invalid turning CAM type: ${camType}`);
  }
  const stepFileName = await uploadFusionStep({ name, fallback: 'turning', stepFile });

  const { data, error } = await supabase
    .from('fusion_turning_parts')
    .insert({
      name,
      epic: epic || null,
      ticket: ticket || null,
      quantity: quantity ?? 1,
      cam_type: camType,
      tailstock_length_in: tailstockLengthIn === '' || tailstockLengthIn == null ? null : Number(tailstockLengthIn),
      step_file_name: stepFileName,
      created_by: createdBy || null,
      part_id: partId || null,
      project_id: projectId || null,
      stock_assignment: stockAssignment || null
    })
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) await removeFailedFusionUpload(stepFileName, error);
  return data;
}

export async function deleteTurningPart(id) {
  const { error } = await supabase.from('fusion_turning_parts').delete().eq('id', id);
  if (error) throw error;
}

/** Delete every selected turning part in one request, not one row at a time. */
export async function deleteTurningParts(ids) {
  if (!ids?.length) return 0;
  const { data, error } = await supabase.from('fusion_turning_parts').delete().in('id', ids).select('id');
  if (error) throw error;
  return data?.length || 0;
}

export async function renameTurningPart(id, name) {
  const cleanedName = name?.trim();
  if (!cleanedName) throw new Error('Turning part name is required');
  const { data, error } = await supabase
    .from('fusion_turning_parts')
    .update({ name: cleanedName })
    .eq('id', id)
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) throw error;
  return data;
}

/** Attaches or replaces a turning part's STEP file - see updatePartStepFile's own docstring. */
export async function updateTurningPartStepFile(id, stepFile) {
  const stepFileName = await uploadFusionStep({ name: id, fallback: 'turning', stepFile });
  const { data, error } = await supabase
    .from('fusion_turning_parts')
    .update({ step_file_name: stepFileName })
    .eq('id', id)
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) await removeFailedFusionUpload(stepFileName, error);
  return data;
}

export async function updateTurningPartQuantity(id, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('Quantity must be a whole number, zero or more');
  }
  const { data: existing, error: existingError } = await supabase
    .from('fusion_turning_parts')
    .select('part_id')
    .eq('id', id)
    .single();
  if (existingError) throw existingError;
  const { data, error } = await supabase
    .from('fusion_turning_parts')
    .update({ quantity })
    .eq('id', id)
    .select('*, parts(id, name, project_id, workflow)')
    .single();
  if (error) throw error;
  if (existing.part_id) {
    const { error: linkedPartError } = await supabase
      .from('parts')
      .update({ quantity, updated_at: new Date().toISOString() })
      .eq('id', existing.part_id);
    if (linkedPartError) throw linkedPartError;
  }
  return data;
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
 * Project ids for a set of fusion_parts ids, as { partId: projectId }. Same
 * batched-by-page, resolved-client-side pattern as fetchFusionPartStepFiles
 * right above (and for the same reason: a plate job's own cam_jobs row only
 * ever carries params.selectedPartId, not the part's project_id, so the Job
 * Queue tab's Project filter has to look it up separately). Kept as its own
 * function rather than widening fetchFusionPartStepFiles - that one's
 * return shape ({ partId: stepFileName }) is a public contract other code
 * already destructures directly.
 */
export async function fetchFusionPartProjectIds(partIds) {
  const ids = [...new Set((partIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from('fusion_parts')
    .select('id, project_id')
    .in('id', ids)
    .not('project_id', 'is', null);
  if (error) throw error;
  return Object.fromEntries((data || []).map((part) => [part.id, part.project_id]));
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
 * milling job that actually covers them. Plate history comes from each job's
 * immutable queue snapshot; tube history follows the tube row's direct part
 * link. Used by /manufacture to show real Fusion
 * CAM status next to a request instead of the old per-part legacy AutoCAM
 * job (which queued directly against the part - Fusion CAM's nest-many-
 * parts-onto-one-plate model means the job a request cares about is one
 * step removed, so this does that lookup once for a whole list of requests
 * rather than each caller re-deriving it).
 *
 * A request with no linked Fusion stock, or no snapshotted/output CAM job,
 * simply has no entry in the returned map.
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
  const fusionPartToManufacturingPart = new Map((fParts || []).map((fp) => [fp.id, fp.part_id]));
  const jobToFusionParts = new Map();
  if (fusionPartIds.length) {
    const { data, error } = await supabase.rpc('fusion_plate_job_links', { p_part_ids: fusionPartIds });
    if (error) throw error;
    for (const link of data || []) {
      if (!jobToFusionParts.has(link.job_id)) jobToFusionParts.set(link.job_id, new Set());
      jobToFusionParts.get(link.job_id).add(link.fusion_part_id);
    }
  }

  // boxTubeId -> manufacturing part id (1:1 - see createBoxTube's own doc comment)
  const boxTubeToManufacturingPart = new Map((fTubes || []).filter((t) => t.part_id).map((t) => [t.id, t.part_id]));

  if (!jobToFusionParts.size && !boxTubeToManufacturingPart.size) return {};

  const targetQueries = [];
  const plateJobIds = [...jobToFusionParts.keys()];
  const boxTubeIds = [...boxTubeToManufacturingPart.keys()];
  if (plateJobIds.length) {
    targetQueries.push(supabase.from('cam_jobs').select(FUSION_JOB_SELECT)
      .eq('operation_type', 'milling').in('id', plateJobIds));
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
    const boxTubeId = job.params?.boxTubeId;
    const mpIds = new Set();
    if (jobToFusionParts.has(job.id)) {
      for (const fusionPartId of jobToFusionParts.get(job.id)) {
        const manufacturingPartId = fusionPartToManufacturingPart.get(fusionPartId);
        if (manufacturingPartId) mpIds.add(manufacturingPartId);
      }
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
 * Snapshotted part ids, plate ids, and box tube ids with at least one completed CAM output job
 * (plate:cam / box_tube - never plate:arrange, see isFusionOutputJob).
 * Powers the "Completed" badge on the Parts and Tube Stock tabs. A part is
 * complete only when it appears in that completed job's immutable snapshot;
 * later changes to the reusable plate do not rewrite history.
 */
export async function fetchCompletedFusionStockIds() {
  const { data, error } = await supabase
    .from('cam_jobs')
    .select('params')
    .eq('operation_type', 'milling')
    .eq('status', 'completed');
  if (error) throw error;
  const plateIds = new Set();
  const fusionPartIds = new Set();
  const boxTubeIds = new Set();
  for (const job of data || []) {
    if (!isFusionOutputJob(job)) continue;
    if (job.params?.plateId) plateIds.add(job.params.plateId);
    for (const assignment of job.params?.fusionPlateSnapshot?.assignments || []) {
      if (assignment?.part_id) fusionPartIds.add(assignment.part_id);
    }
    if (job.params?.boxTubeId) boxTubeIds.add(job.params.boxTubeId);
  }
  return { fusionPartIds, plateIds, boxTubeIds };
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
  // A stale Runner once uploaded the active "AutoCAM" project tree while
  // labeling it "2026 Season CAM". Never show a cache row whose actual root
  // disagrees with the project the picker requested.
  if (data && String(data.tree?.name || '').trim() !== projectName) return null;
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
async function requireLoadedTool(machineId, toolId, { requireEndmill = false } = {}) {
  if (!machineId || !toolId) return;
  const { data: loadedRows, error: loadedError } = await supabase
    .from('cam_machine_tools')
    .select('tool_id, cam_tools(tool_type)')
    .eq('machine_id', machineId);
  if (loadedError) throw loadedError;
  const selected = (loadedRows || []).find((row) => String(row.tool_id) === String(toolId));
  if (!selected) {
    throw new Error('Selected tool is no longer loaded on this machine - pick another or update ATC Slots.');
  }
  if (requireEndmill && !/end\s*mill/i.test(String(selected.cam_tools?.tool_type || ''))) {
    throw new Error('Single-tool Fusion CAM requires an endmill selected on the job');
  }
}

// Direct helper for arrange and tube jobs. Plate CAM must use the atomic
// assignment-and-queue function below.
export async function queueFusionJob({ fusionJobKind, plateId, boxTubeId, turningPartId, machineId, materialId, toolId, requestedBy, name, partId, groupingMode, selectedPartId, selectedPartIds, fusionFileName, fusionFolderPath, tabCount, singleToolMode = false, multiToolMode = false, orientation = 'vertical' }) {
  if (!FUSION_JOB_KINDS.includes(fusionJobKind)) {
    throw new Error(`Invalid fusionJobKind: ${fusionJobKind}`);
  }
  if (fusionJobKind === 'box_tube' && !boxTubeId) {
    throw new Error('A box tube is required for a tube-stock CAM job');
  }
  if (fusionJobKind === 'turning' && !turningPartId) {
    throw new Error('A turning part is required for a lathe CAM job');
  }
  if (fusionJobKind === 'plate:cam') {
    throw new Error('Plate CAM must be queued atomically with queueFusionPlateJob');
  }
  if (fusionJobKind === 'box_tube' && (!machineId || !toolId || !materialId)) {
    throw new Error('Tube CAM requires a machine, an installed endmill, and an aluminum material');
  }
  // Turning has no equivalent of Tube CAM's endmill/material requirement:
  // HandleSpacer.py/HandleHexShaft.py pick their own generic turning tools
  // straight from Fusion's own bundled sample library (direct instruction:
  // "use generic tools for now, then we can configure them later" - the
  // existing cam_tools catalog describes mill/router bits, not lathe
  // inserts, so there is nothing meaningful to pick from it yet). A machine
  // is still required, to route the job to a specific lathe.
  if (fusionJobKind === 'turning' && !machineId) {
    throw new Error('Choose a lathe before queueing turning CAM');
  }
  // A fresh, real-time check, not a re-check of whatever the queue picker's
  // own cached tool list already showed - that list is only as current as
  // its last load(), and picking a tool it once offered doesn't guarantee
  // it's still loaded on the machine right now (someone could have changed
  // the ATC slots in another tab, or since the page was opened). Confirmed
  // live: a job with a tool no longer actually loaded queued successfully
  // and only failed later, once a Runner tried to claim it - direct
  // instruction: this must fail at queue time instead, before a bad job
  // ever reaches cam_jobs at all.
  await requireLoadedTool(machineId, toolId, { requireEndmill: singleToolMode });
  const normalizedOrientation = String(orientation || 'vertical').trim().toLowerCase();
  if (fusionJobKind === 'box_tube' && !['horizontal', 'vertical'].includes(normalizedOrientation)) {
    throw new Error('Tube orientation must be horizontal or vertical');
  }
  const params = {
    fusionJobKind,
    ...(fusionJobKind.startsWith('plate:') ? {
      plateId: plateId || null,
      fusionGroupingMode: groupingMode,
      selectedPartId: selectedPartId || null,
      selectedPartIds: Array.isArray(selectedPartIds) ? selectedPartIds : null,
      // Optional operator override for TabPlacement's tab count - stays
      // automatic (this job's existing default) when not set. Plate jobs
      // only, same as the fields above; box-tube CAM never runs
      // TabPlacement at all. Re-clamped server-side (buildJobPayload) and
      // again in the Runner itself (camPlate.py) - never trust a single
      // layer for "cannot be too much".
      tabCount: tabCount === '' || tabCount == null ? null : Number(tabCount),
      // Plate CAM only. Tube jobs have their own operation planner and must
      // retain their stable, minimal queue payload.
      multiToolMode: Boolean(multiToolMode)
    } : fusionJobKind === 'turning' ? { turningPartId } : { boxTubeId, orientation: normalizedOrientation }),
    // Where the saved Fusion document goes and what it's named - chosen at
    // queue time (Plates tab). Optional; camPlate.py falls back to its
    // existing defaults when these aren't set.
    fusionFileName: fusionFileName || null,
    fusionFolderPath: fusionFolderPath || null,
    // Runner safety contract, not merely a UI preference.
    singleToolMode: Boolean(singleToolMode),
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
      // Only ever set for a box-tube or turning job (a clean 1:1) - a plate
      // job leaves this null, since a plate nests many parts that may be for
      // several (or no) requests at once; see the migration this shipped with.
      part_id: partId || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Replace a hidden plate's nest and queue its immutable CAM snapshot atomically. */
export async function queueFusionPlateJob({ plateId, assignments, machineId, toolId, requestedBy, name, fusionFileName, fusionFolderPath, tabCount, groupingMode, singleToolMode = false, multiToolMode = false }) {
  if (!plateId) throw new Error('A plate is required for plate CAM');
  if (!machineId) throw new Error('Choose a machine before queueing plate CAM');
  if (!multiToolMode && !toolId) throw new Error('Choose an installed tool before queueing plate CAM');
  if (!Array.isArray(assignments) || !assignments.length) throw new Error('Choose at least one part to queue');
  if (!['single', 'grouped'].includes(groupingMode)) throw new Error('Choose single-part or grouped Fusion CAM explicitly');
  if ((groupingMode === 'single' && assignments.length !== 1) || (groupingMode === 'grouped' && assignments.length < 2)) {
    throw new Error(groupingMode === 'single' ? 'Single-part CAM requires exactly one part' : 'Grouped CAM requires at least two parts');
  }
  if (singleToolMode && multiToolMode) throw new Error('Single-tool and multi-tool mode cannot both be enabled');
  await requireLoadedTool(machineId, toolId, { requireEndmill: singleToolMode });
  const rawTabCount = tabCount === '' || tabCount == null ? null : Number(tabCount);
  if (rawTabCount !== null && !Number.isFinite(rawTabCount)) throw new Error('Tab count must be a number');
  const normalizedTabCount = rawTabCount === null
    ? null
    : Math.max(4, Math.min(20, Math.round(rawTabCount)));
  const normalizedAssignments = assignments.map((assignment) => ({
    partId: assignment.partId,
    quantity: Number(assignment.quantity)
  }));
  if (normalizedAssignments.some((assignment) => !assignment.partId || !Number.isInteger(assignment.quantity) || assignment.quantity <= 0)) {
    throw new Error('Every queued part needs a positive whole-number quantity');
  }

  const { data, error } = await supabase.rpc('queue_fusion_plate_job', {
    p_plate_id: plateId,
    p_assignments: normalizedAssignments,
    p_machine_id: machineId || null,
    p_tool_id: multiToolMode ? null : toolId || null,
    p_name: name || null,
    p_requested_by: requestedBy || null,
    p_fusion_file_name: fusionFileName || null,
    p_fusion_folder_path: fusionFolderPath || null,
    p_tab_count: normalizedTabCount,
    p_grouping_mode: groupingMode,
    p_single_tool_mode: Boolean(singleToolMode),
    p_multi_tool_mode: Boolean(multiToolMode)
  }).single();
  if (error) throw error;
  return data;
}

export function fusionNcDestinationName(baseName, index, total, sourceName) {
  const extension = String(sourceName || '').match(/(\.[a-z0-9]+)$/i)?.[1] || '.nc';
  const suffix = total > 1 ? `-${index + 1}` : '';
  return `${baseName}${suffix}${extension}`;
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

/**
 * Changes which material a job runs against. Restricted to status='queued',
 * same reasoning as cancelFusionJob's own status guard: once a Runner has
 * claimed a job it has already read (or is about to read) params/material_id
 * to build the CAM setup, so a change after that point would not actually
 * reach Fusion - only "queued, waiting for a Runner" is a real edit window.
 * A material change wrong for the actual stock (wrong thickness) has always
 * required deleting and requeuing; this is the same "retry with prefilled
 * settings" gap the STEP-attach/replace fix closed, but for the one field
 * that's wrong most often before a job has even been picked up.
 */
export async function updateFusionJobMaterial(id, materialId) {
  if (!materialId) throw new Error('Choose a material');
  // Array select + length check, not .single() - a status that changed out
  // from under this edit (a Runner claimed it a moment ago) must surface as
  // the ordinary "no longer editable" error below, not a PostgREST "no rows
  // returned" exception from .single() on a legitimately empty match.
  const { data, error } = await supabase
    .from('cam_jobs')
    .update({ material_id: materialId })
    .eq('id', id)
    .eq('operation_type', 'milling')
    .eq('status', 'queued')
    .select(FUSION_JOB_SELECT);
  if (error) throw error;
  if (!data?.length) throw new Error('Fusion job is no longer queued - it can no longer be edited');
  return data[0];
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

/**
 * Delete every selected Fusion job in one request - same safety scope as
 * deleteFusionJob: only queued/completed/failed/rejected rows can go, a
 * claimed/processing job the Runner might still be working never matches
 * this filter regardless of which ids were selected.
 */
export async function deleteFusionJobs(ids) {
  if (!ids?.length) return 0;
  const { data, error } = await supabase
    .from('cam_jobs')
    .delete()
    .in('id', ids)
    .eq('operation_type', 'milling')
    .in('status', ['queued', 'completed', 'failed', 'rejected'])
    .select('id');
  if (error) throw error;
  return data?.length || 0;
}
