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
  let stepFileName = null;
  if (stepFile) {
    stepFileName = `${Date.now()}_${(name || 'part').replace(/[^a-zA-Z0-9]/g, '_')}_fusion.${(stepFile.name.split('.').pop() || 'step')}`;
    const { error: uploadError } = await supabase.storage
      .from('manufacturing-files')
      .upload(stepFileName, stepFile, { cacheControl: '3600', upsert: false });
    if (uploadError) throw new Error(uploadError.message || 'Failed to upload STEP file');
  }

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
  if (error) throw error;
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
    .select('quantity, original_quantity')
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
  let stepFileName = null;
  if (stepFile) {
    stepFileName = `${Date.now()}_${(name || 'boxtube').replace(/[^a-zA-Z0-9]/g, '_')}_fusion.${(stepFile.name.split('.').pop() || 'step')}`;
    const { error: uploadError } = await supabase.storage
      .from('manufacturing-files')
      .upload(stepFileName, stepFile, { cacheControl: '3600', upsert: false });
    if (uploadError) throw new Error(uploadError.message || 'Failed to upload STEP file');
  }

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
  if (error) throw error;
  return data;
}

export async function deleteBoxTube(id) {
  const { error } = await supabase.from('fusion_box_tubes').delete().eq('id', id);
  if (error) throw error;
}

/* ── Job queue (reuses cam_jobs - see file header) ───────────────────── */

export async function fetchFusionJobs() {
  const { data, error } = await supabase
    .from('cam_jobs')
    .select('*, cam_machines(name, controller), cam_tools(name, diameter)')
    .eq('operation_type', 'milling')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
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
 * row with operation_type='milling', status='queued', and the
 * plate/box-tube reference in params.fusionJobKind/params.plateId or
 * .boxTubeId. Left at 'queued' for a Runner to claim via
 * /api/fusion-runner - no synchronous generation happens here (unlike
 * turning/routing's cam-generate, this genuinely needs an external Fusion
 * 360 process).
 */
export async function queueFusionJob({ fusionJobKind, plateId, boxTubeId, machineId, materialId, toolId, requestedBy, name, partId, groupingMode, selectedPartId, selectedPartIds, fusionFileName, fusionFolderPath }) {
  if (!FUSION_JOB_KINDS.includes(fusionJobKind)) {
    throw new Error(`Invalid fusionJobKind: ${fusionJobKind}`);
  }
  const params = {
    fusionJobKind,
    plateId: plateId || null,
    boxTubeId: boxTubeId || null,
    ...(fusionJobKind.startsWith('plate:') ? {
      fusionGroupingMode: groupingMode,
      selectedPartId: selectedPartId || null,
      selectedPartIds: Array.isArray(selectedPartIds) ? selectedPartIds : null
    } : {}),
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
  const { error } = await supabase
    .from('cam_jobs')
    .update({ status: 'failed', errors: ['Cancelled by user'] })
    .eq('id', id)
    .in('status', ['queued', 'claimed', 'processing']);
  if (error) throw error;
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
