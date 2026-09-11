// Same range TabPlacement.py's own DEFAULT_MIN_TABS/DEFAULT_MAX_TABS
// already treat as reasonable for the automatic target - kept in sync by
// hand (no shared config between the two languages), not derived.
// Direct instruction: an operator-set tab count "cannot be too much" - a
// real ceiling, not just a UI hint the Runner is trusted to also enforce
// (see camPlate.py's own _resolve_tab_count_override, which re-clamps
// this independently).
const TAB_COUNT_MIN = 4;
const TAB_COUNT_MAX = 20;
async function resolveLoadedToolItems(supabase, machineId, toolId) {
  if (!machineId) return [];
  const { data, error } = await supabase.from('cam_machine_tools')
    .select('tool_id, cam_tools(tool_library_guid, tool_type)')
    .eq('machine_id', machineId);
  if (error) throw new Error(`Could not resolve loaded machine tools: ${error.message}`);
  const rows = data || [];
  // "Is this tool actually loaded" is a plain machine/tool membership
  // fact, independent of whether its cam_tools row happens to carry a
  // tool_library_guid - real, confirmed live regression: UNC Router's own
  // single tool ("UNC Router 0.1575 in Flat End Mill") has never needed
  // one and has always had tool_library_guid = null, and requiring one
  // here failed every UNC Router job outright with "Selected tool is not
  // loaded on this machine" even though it plainly was. The guid is only
  // needed to hand Fusion real library data for tool_items below - a
  // loaded tool that lacks one still passes this check, it just can't
  // contribute an entry to tool_items (same as before single-tool mode
  // started calling this function at all).
  if (toolId && !rows.some((row) => String(row.tool_id) === String(toolId))) {
    throw new Error('Selected tool is not loaded on this machine');
  }
  const items = rows.map((row) => ({
    tool_id: row.tool_id,
    tool_guid: row.cam_tools?.tool_library_guid,
    tool_type: row.cam_tools?.tool_type
  })).filter((item) => item.tool_guid && /(end\s*mill|drill)/i.test(String(item.tool_type || '')))
    .map(({ tool_id, tool_guid }) => ({ tool_id, tool_guid }));
  return toolId ? items.filter((item) => String(item.tool_id) === String(toolId)) : items;
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
  const hasTabCount = params.tabCount !== null && params.tabCount !== undefined
    && !(typeof params.tabCount === 'string' && params.tabCount.trim() === '');
  const rawTabCount = hasTabCount ? Number(params.tabCount) : NaN;
  const tab_count = Number.isFinite(rawTabCount)
    ? Math.max(TAB_COUNT_MIN, Math.min(TAB_COUNT_MAX, Math.round(rawTabCount)))
    : null;
  // Tube CAM has no multi-tool planner; normalize older queued rows to the
  // same one-selected-endmill contract current clients write explicitly.
  const single_tool_mode = params.fusionJobKind === 'box_tube' || params.singleToolMode === true;
  const multi_tool_mode = params.multiToolMode === true;
  if (single_tool_mode && multi_tool_mode) {
    throw new Error('Single-tool and multi-tool mode cannot both be enabled');
  }
  if (single_tool_mode && !/end\s*mill/i.test(String(job.cam_tools?.tool_type || ''))) {
    throw new Error('Single-tool Fusion CAM requires an endmill selected on the job');
  }
  // tool_id is vestigial in multi-tool mode - the planner resolves from
  // every loaded candidate, not one manual selection - so it's never
  // passed through for the loaded-tool match check below. Confirmed live:
  // a job queued in multi-tool mode still carried a stale tool_id (the
  // single Tool dropdown's last value, from before it's cleared on switching
  // to Auto multi-tool - or an older client that hadn't picked that up yet)
  // pointing at a tool with no tool_library_guid, which resolveLoadedToolItems
  // correctly excludes from its candidate set (no way to look up its real
  // cutting data from the physical .tools file) - failing the entire job
  // with "Selected tool is not loaded on this machine" over a field the
  // job's own mode says to ignore.
  // A single-tool job must carry its specific library GUID too. Otherwise
  // Fusion receives the full machine library and can silently bind another
  // installed cutter despite the operator selecting just one in the queue UI.
  const tool_items = (multi_tool_mode || tool_id)
    ? await resolveLoadedToolItems(supabase, machine_id, multi_tool_mode ? null : tool_id)
    : [];
  if (single_tool_mode && String(job.cam_machines?.name || '').trim().toLowerCase() === 'new router' && !tool_items.length) {
    throw new Error('Selected New Router tool has no bundled Fusion tool-library identity');
  }
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
      const normalizedMachine = String(job.cam_machines?.name || '').trim().toLowerCase();
      const normalizedMaterial = String(snapshot.material || '').trim().toLowerCase();
      if (multi_tool_mode && normalizedMachine !== 'new router') {
        throw new Error('Automatic tool swaps are available only on New Router');
      }
      if (multi_tool_mode && !['aluminum 6061', 'aluminium 6061', '6061 aluminum', '6061 aluminium'].includes(normalizedMaterial)) {
        throw new Error('Automatic tool swaps are available only for Aluminum 6061');
      }
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
    return { plate_id: snapshot.plate_id, grouping_mode: snapshot.grouping_mode || null, machine_id, tool_id, single_tool_mode, multi_tool_mode, tool_items, length: Number(snapshot.length),
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
      tool_items,
      orientation: ['horizontal', 'vertical'].includes(String(params.orientation || '').trim().toLowerCase())
        ? String(params.orientation).trim().toLowerCase()
        : 'vertical',
      step_file_url: await signedUrl(data.step_file_name, data.id),
      // Match plate jobs: the shared queue confirmation controls the saved
      // Fusion document and must reach the local Runner for tube jobs too.
      fusion_file_name: typeof params.fusionFileName === 'string' && params.fusionFileName.trim() ? params.fusionFileName.trim() : null,
      fusion_folder_path: typeof params.fusionFolderPath === 'string' && params.fusionFolderPath.trim() ? params.fusionFolderPath.trim() : null
    };
  }
  if (params.fusionJobKind === 'turning') {
    const { data, error } = await supabase.from('fusion_turning_parts').select('*').eq('id', params.turningPartId).single();
    if (error || !data) throw new Error('Turning part not found');
    return {
      turning_part_id: data.id,
      cam_type: data.cam_type,
      // null (the default) means "use the part's own measured length" -
      // both HandleSpacer.py and HandleHexShaft.py already fall back to
      // that when this is absent, so it is passed through as-is rather
      // than resolved here.
      tailstock_length_in: data.tailstock_length_in,
      machine_id,
      step_file_url: await signedUrl(data.step_file_name, data.id),
      fusion_file_name: typeof params.fusionFileName === 'string' && params.fusionFileName.trim() ? params.fusionFileName.trim() : null,
      fusion_folder_path: typeof params.fusionFolderPath === 'string' && params.fusionFolderPath.trim() ? params.fusionFolderPath.trim() : null
    };
  }
  throw new Error('Unsupported Fusion job kind');
}
