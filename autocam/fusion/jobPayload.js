/** Resolve every queued input or reject the entire job; never CAM a partial plate. */
export async function buildJobPayload(supabase, job) {
  const params = job.params || {};
  const machine_id = job.machine_id || null;
  const tool_id = job.tool_id || null;
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
    const assignments = [];
    for (const part of snapshot.assignments) {
      if (!part.part_id || seen.has(part.part_id) || !Number.isSafeInteger(part.quantity) || part.quantity <= 0) {
        throw new Error('Plate job contains an invalid or duplicate assignment');
      }
      seen.add(part.part_id);
      assignments.push({ part_id: part.part_id, quantity: part.quantity,
        step_file_url: await signedUrl(part.step_file_name, part.part_id), fusion_file_name: part.fusion_file_name || null });
    }
    return { plate_id: snapshot.plate_id, grouping_mode: snapshot.grouping_mode || null, machine_id, tool_id, length: Number(snapshot.length),
      width: Number(snapshot.width), true_depth: Number(snapshot.true_depth), thickness: Number(snapshot.thickness),
      material: snapshot.material, assignments,
      // Set at queue time on the Plates tab (folder-tree picker + filename
      // field) - takes priority over any per-part fusion_file_name above.
      // Both optional: camPlate.py falls back to its existing defaults
      // (per-part name, then Plate<id>Job<id>; the configured drop folder)
      // when a job was queued before this existed.
      fusion_file_name: typeof params.fusionFileName === 'string' && params.fusionFileName.trim() ? params.fusionFileName.trim() : null,
      fusion_folder_path: typeof params.fusionFolderPath === 'string' && params.fusionFolderPath.trim() ? params.fusionFolderPath.trim() : null };
  }
  if (params.fusionJobKind === 'box_tube') {
    const { data, error } = await supabase.from('fusion_box_tubes').select('*').eq('id', params.boxTubeId).single();
    if (error || !data) throw new Error('Box tube not found');
    return { box_tube_id: data.id, machine_id, tool_id, step_file_url: await signedUrl(data.step_file_name, data.id) };
  }
  throw new Error('Unsupported Fusion job kind');
}
