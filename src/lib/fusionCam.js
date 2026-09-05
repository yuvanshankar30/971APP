/**
 * Data layer for Fusion CAM - the Fusion-360-backed milling pipeline
 * (autocam/fusion/, ported from Team Valor 6800's open-source AutoCAM).
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
export async function createPart({ name, epic, ticket, quantity, categoryId, stepFile, createdBy, partId }) {
  let stepFileName = null;
  if (stepFile) {
    stepFileName = `${Date.now()}_${(name || 'part').replace(/[^a-zA-Z0-9]/g, '_')}_fusion.${(stepFile.name.split('.').pop() || 'step')}`;
    const { error: uploadError } = await supabase.storage
      .from('manufacturing-files')
      .upload(stepFileName, stepFile, { cacheControl: '3600', upsert: false });
    if (uploadError) throw new Error(uploadError.message || 'Failed to upload STEP file');
  }

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
      part_id: partId || null
    })
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
    .select('*, fusion_part_categories(thickness, cam_materials(name, category)), fusion_part_category_assignments(quantity, fusion_parts(id, name))')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createPlate({ name, width, length, trueDepth, categoryId }) {
  const { data, error } = await supabase
    .from('fusion_plates')
    .insert({ name, width, length, true_depth: trueDepth, category_id: categoryId })
    .select('*, fusion_part_categories(thickness, cam_materials(name, category))')
    .single();
  if (error) throw error;
  return data;
}

export async function deletePlate(id) {
  const { error } = await supabase.from('fusion_plates').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Assigns (or updates) how many of a part are nested onto a plate.
 *
 * fusion_parts.quantity is meant to be "how many are still unassigned to
 * any plate" (see original_quantity, the fixed total) - PlatesTab.svelte's
 * own nesting UI already computes its per-plate max as
 * `part.quantity + (already nested on this plate)`, on the assumption
 * that quantity excludes this plate's own assignment but nothing else.
 * That assumption only holds if assigning actually consumes it here -
 * without this, the same physical part could be over-committed across
 * several plates at once, since nothing else in this file ever touched
 * fusion_parts.quantity after createPart set the initial value.
 *
 * Read-then-write, not atomic (same pattern already used for quantity
 * fields elsewhere in this app, e.g. cots-stocking/+page.svelte) - fine
 * for this team's actual concurrency (one or two people editing a plate
 * at a time), not fine for a race between simultaneous edits to the same
 * part, which this app doesn't guard against anywhere else either.
 */
export async function assignPartToPlate({ categoryId, plateId, partId, quantity }) {
  const [{ data: existingAssignment, error: existingError }, { data: part, error: partError }] = await Promise.all([
    supabase.from('fusion_part_category_assignments').select('quantity').eq('plate_id', plateId).eq('part_id', partId).maybeSingle(),
    supabase.from('fusion_parts').select('quantity').eq('id', partId).single()
  ]);
  if (existingError) throw existingError;
  if (partError) throw partError;

  const previousQuantity = existingAssignment?.quantity || 0;
  const delta = quantity - previousQuantity; // positive = consuming more of the part's remaining stock
  if (delta > part.quantity) {
    throw new Error(`Only ${part.quantity} of this part remain unassigned - remove it from another plate first or lower the quantity`);
  }

  const { data, error } = await supabase
    .from('fusion_part_category_assignments')
    .upsert({ category_id: categoryId, plate_id: plateId, part_id: partId, quantity }, { onConflict: 'plate_id,part_id' })
    .select()
    .single();
  if (error) throw error;

  if (delta !== 0) {
    const { error: quantityError } = await supabase
      .from('fusion_parts')
      .update({ quantity: Math.max(0, part.quantity - delta) })
      .eq('id', partId);
    if (quantityError) throw quantityError;
  }

  return data;
}

/** Removes a part's assignment from a plate and returns its quantity to fusion_parts.quantity - see assignPartToPlate's own doc comment. */
export async function removePartFromPlate({ plateId, partId }) {
  const { data: existingAssignment, error: existingError } = await supabase
    .from('fusion_part_category_assignments')
    .select('quantity')
    .eq('plate_id', plateId)
    .eq('part_id', partId)
    .maybeSingle();
  if (existingError) throw existingError;

  const { error } = await supabase
    .from('fusion_part_category_assignments')
    .delete()
    .eq('plate_id', plateId)
    .eq('part_id', partId);
  if (error) throw error;

  if (existingAssignment?.quantity) {
    const { data: part, error: partError } = await supabase.from('fusion_parts').select('quantity').eq('id', partId).single();
    if (partError) throw partError;
    const { error: quantityError } = await supabase
      .from('fusion_parts')
      .update({ quantity: (part.quantity || 0) + existingAssignment.quantity })
      .eq('id', partId);
    if (quantityError) throw quantityError;
  }
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
    .select('*, cam_machines(name, controller)')
    .eq('operation_type', 'milling')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
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
export async function queueFusionJob({ fusionJobKind, plateId, boxTubeId, machineId, materialId, toolId, requestedBy, name, partId }) {
  if (!FUSION_JOB_KINDS.includes(fusionJobKind)) {
    throw new Error(`Invalid fusionJobKind: ${fusionJobKind}`);
  }
  const params = { fusionJobKind, plateId: plateId || null, boxTubeId: boxTubeId || null };
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
