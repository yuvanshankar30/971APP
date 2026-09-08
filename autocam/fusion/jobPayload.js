// Same range TabPlacement.py's own DEFAULT_MIN_TABS/DEFAULT_MAX_TABS
// already treat as reasonable for the automatic target - kept in sync by
// hand (no shared config between the two languages), not derived.
// Direct instruction: an operator-set tab count "cannot be too much" - a
// real ceiling, not just a UI hint the Runner is trusted to also enforce
// (see camPlate.py's own _resolve_tab_count_override, which re-clamps
// this independently).
const TAB_COUNT_MIN = 4;
const TAB_COUNT_MAX = 20;
const APPROVED_COUNTERSINKS = new Map([
  ['61a8645a-9015-4aba-958b-70297d26b19e', 0.372],
  ['8789b786-8e50-48c5-b4f9-21296fcaf34a', 0.5]
]);
const SHOP_SABRE_TOOL_LIBRARY = 'Normal router tools (use this).tools';

async function resolveCountersinkTool(supabase, machineId, countersinkToolId) {
  if (!countersinkToolId) return null;
  if (!machineId) throw new Error('Countersinking requires a selected machine');
  const { data, error } = await supabase
    .from('cam_machine_tools')
    .select('cam_tools(id, tool_type, diameter, tool_number, tip_angle, tool_library_guid, source_tool_library_file)')
    .eq('machine_id', machineId)
    .eq('tool_id', countersinkToolId)
    .maybeSingle();
  const tool = data?.cam_tools;
  if (error || !tool) throw new Error('Selected countersink is not loaded on this machine');
  const expectedDiameter = APPROVED_COUNTERSINKS.get(tool.tool_library_guid);
  if (
    !/counter\s*sink/i.test(String(tool.tool_type || '')) ||
    expectedDiameter == null ||
    Math.abs(Number(tool.diameter) - expectedDiameter) >= 0.0001 ||
    Number(tool.tip_angle) !== 82 ||
    tool.source_tool_library_file !== SHOP_SABRE_TOOL_LIBRARY
  ) {
    throw new Error('Selected countersink is not an approved 82 degree ShopSabre countersink');
  }
  return { guid: tool.tool_library_guid, diameter: expectedDiameter, tool_number: tool.tool_number };
}

/** Resolve every queued input or reject the entire job; never CAM a partial plate. */
export async function buildJobPayload(supabase, job) {
  const params = job.params || {};
  const machine_id = job.machine_id || null;
  const tool_id = job.tool_id || null;
  // Direct instruction: an operator can force an exact tab count instead
  // of the perimeter-based automatic target - null (the default) means
  // "stay automatic," this job's existing behavior. Clamped here so a
  // malformed or excessive value never reaches the Runner at all, not
  // just relying on its own re-check.
  const rawTabCount = Number(params.tabCount);
  const tab_count = Number.isFinite(rawTabCount)
    ? Math.max(TAB_COUNT_MIN, Math.min(TAB_COUNT_MAX, Math.round(rawTabCount)))
    : null;
  const single_tool_mode = params.singleToolMode === true;
  if (single_tool_mode && !/end\s*mill/i.test(String(job.cam_tools?.tool_type || ''))) {
    throw new Error('Single-tool Fusion CAM requires an endmill selected on the job');
  }
  const countersink_tool = await resolveCountersinkTool(supabase, machine_id, params.countersinkToolId);
  async function signedUrl(fileName, partId) {
    if (typeof fileName !== 'string' || !fileName.trim()) throw new Error(`Part ${partId} is missing its STEP file`);
    const { data, error } = await supabase.storage.from('manufacturing-files').createSignedUrl(fileName, 3600);
    if (error || !data?.signedUrl) throw new Error(`Could not resolve STEP file for part ${partId}`);
    return data.signedUrl;
  }
  if (['plate:cam', 'plate:arrange'].includes(params.fusionJobKind)) {
    const snapshot = params.fusionPlateSnapshot;
    if (!snapshot || snapshot.version !== 1 || snapshot.plate_id !== params.plateId) {
      throw new Error('This plate job has no valid input snapshot. Queue a new job.');
    }
    for (const key of ['length', 'width', 'true_depth', 'thickness']) {
      if (!Number.isFinite(Number(snapshot[key])) || Number(snapshot[key]) <= 0) throw new Error(`Invalid plate ${key}`);
    }
    if (!Array.isArray(snapshot.assignments) || !snapshot.assignments.length) throw new Error('Plate job has no nested parts');
    if (params.fusionJobKind === 'plate:cam') {
      if (!['single', 'grouped'].includes(snapshot.grouping_mode)) throw new Error('Plate CAM job has no explicit grouping mode');
      if (snapshot.grouping_mode === 'single' && snapshot.assignments.length !== 1) throw new Error('Single-part CAM must contain exactly one part type');
      if (snapshot.grouping_mode === 'grouped' && snapshot.assignments.length < 2) throw new Error('Grouped CAM must contain at least two part types');
    }
    const seen = new Set();
    const validatedAssignments = [];
    for (const part of snapshot.assignments) {
      if (!part.part_id || seen.has(part.part_id) || !Number.isSafeInteger(part.quantity) || part.quantity <= 0) {
        throw new Error('Plate job contains an invalid or duplicate assignment');
      }
      seen.add(part.part_id);
      validatedAssignments.push(part);
    }
    // Signed URL requests are independent. Resolve them concurrently so a
    // plate with many part types does not add one full storage round trip
    // per assignment to claim latency.
    const assignments = await Promise.all(validatedAssignments.map(async (part) => ({
      part_id: part.part_id,
      quantity: part.quantity,
      step_file_url: await signedUrl(part.step_file_name, part.part_id),
      fusion_file_name: part.fusion_file_name || null
    })));
    return { plate_id: snapshot.plate_id, grouping_mode: snapshot.grouping_mode || null, machine_id, tool_id, single_tool_mode, countersink_tool, length: Number(snapshot.length),
      width: Number(snapshot.width), true_depth: Number(snapshot.true_depth), thickness: Number(snapshot.thickness),
      material: snapshot.material, assignments,
      // Set at queue time on the Plates tab (folder-tree picker + filename
      // field) - takes priority over any per-part fusion_file_name above.
      // Both optional: camPlate.py falls back to its existing defaults
      // (per-part name, then Plate<id>Job<id>; the configured drop folder)
      // when a job was queued before this existed.
      fusion_file_name: typeof params.fusionFileName === 'string' && params.fusionFileName.trim() ? params.fusionFileName.trim() : null,
      fusion_folder_path: typeof params.fusionFolderPath === 'string' && params.fusionFolderPath.trim() ? params.fusionFolderPath.trim() : null,
      // Plate jobs only - box-tube CAM never runs TabPlacement at all
      // (tube stock has no release-tab step), so this is deliberately
      // absent from the box_tube payload below rather than sent as an
      // always-null field the Runner would never read.
      tab_count };
  }
  if (params.fusionJobKind === 'box_tube') {
    const { data, error } = await supabase.from('fusion_box_tubes').select('*').eq('id', params.boxTubeId).single();
    if (error || !data) throw new Error('Box tube not found');
    return {
      box_tube_id: data.id,
      machine_id,
      tool_id,
      single_tool_mode,
      step_file_url: await signedUrl(data.step_file_name, data.id),
      // Match plate jobs: the shared queue confirmation controls the saved
      // Fusion document and must reach the local Runner for tube jobs too.
      fusion_file_name: typeof params.fusionFileName === 'string' && params.fusionFileName.trim() ? params.fusionFileName.trim() : null,
      fusion_folder_path: typeof params.fusionFolderPath === 'string' && params.fusionFolderPath.trim() ? params.fusionFolderPath.trim() : null
    };
  }
  throw new Error('Unsupported Fusion job kind');
}
