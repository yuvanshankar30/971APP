import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { planJobNesting } from '$autocam/nesting.js';
import { generateGroupedRoutingGcode } from '$autocam/groupedGcode.js';
import { gcodeFileNameFor } from '$autocam/camJobs.js';

function client(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

export async function GET({ request, url }) {
  const supabase = client(request);
  let query = supabase.from('cam_job_groups').select('*, cam_materials(name), cam_tools(name, diameter), cam_machines(name), cam_job_group_items(cam_job_id, offset_x, offset_y, bounds, sort_order, cam_jobs(name, part_id, parts(name)))').order('created_at', { ascending: false });
  const projectId = url.searchParams.get('projectId');
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  return error ? json({ error: error.message }, { status: 400 }) : json({ groups: data || [] });
}

export async function POST({ request }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const jobIds = [...new Set((body.jobIds || []).filter(Boolean))];
  if (jobIds.length < 2) return json({ error: 'Choose at least two completed router jobs to group' }, { status: 400 });
  const supabase = client(request);
  const { data: jobs, error: jobsError } = await supabase
    .from('cam_jobs').select('*, parts(name, project_id), cam_tools(diameter), cam_machines(name, controller)')
    .in('id', jobIds);
  if (jobsError || jobs?.length !== jobIds.length) return json({ error: jobsError?.message || 'One or more jobs could not be loaded' }, { status: 400 });
  if (jobs.some((job) => job.operation_type !== 'routing' || job.status !== 'completed' || !job.gcode)) return json({ error: 'Only completed router jobs with G-code can be grouped' }, { status: 400 });
  const first = jobs[0];
  if (jobs.some((job) => String(job.machine_id || '') !== String(first.machine_id || '') || String(job.tool_id || '') !== String(first.tool_id || '') || String(job.material_id || '') !== String(first.material_id || ''))) {
    return json({ error: 'Grouped jobs must use the same machine, tool, and material' }, { status: 400 });
  }
  // Same material is NOT the same stock. cam_materials says what the stock
  // is, never how thick it is - "Aluminum 6061" covers 1/16" through 3/8"
  // sheet in this team's own catalog - so two jobs can match on all three
  // fields above and still have been generated for different thicknesses.
  // Combined onto one sheet, either the deeper job cuts past the material
  // into the spoilboard, or the shallower one never cuts through and its
  // part stays attached. generateRoutingGcode enforces depth against stock
  // per job, but a group is assembled from already-generated G-code and
  // never revisits it.
  const depthOf = (job) => Number(job.params?.stockThickness ?? job.params?.targetDepth ?? job.stats?.targetDepth ?? NaN);
  const firstDepth = depthOf(first);
  if (Number.isFinite(firstDepth) && jobs.some((job) => {
    const depth = depthOf(job);
    return !Number.isFinite(depth) || Math.abs(depth - firstDepth) > 1e-6;
  })) {
    return json({ error: 'Grouped jobs must be cut to the same depth on the same stock thickness - one sheet cannot serve two different thicknesses' }, { status: 400 });
  }
  // Units are stripped from each part's body (programBody drops G20/G21) and
  // the group header hardcodes inches, so a millimetre job silently becomes
  // an inch job. Nothing in the UI exposes units today, which is exactly why
  // this needs a guard rather than an assumption.
  const unitsOf = (job) => String(job.params?.units || 'in').toLowerCase();
  if (jobs.some((job) => unitsOf(job) !== unitsOf(first))) {
    return json({ error: 'Grouped jobs must all use the same units' }, { status: 400 });
  }
  const toolDiameter = Number(body.toolDiameter || first.cam_tools?.diameter || first.params?.toolDiameter);
  const edgeMargin = Number(body.edgeMargin ?? 0.5);
  const params = { ...(first.params || {}), toolDiameter, edgeMargin, safeZ: body.safeZ ?? first.params?.safeZ, controller: first.cam_machines?.controller || first.params?.controller };
  try {
    const plan = planJobNesting(jobs, { stockWidth: body.stockWidth, stockHeight: body.stockHeight, edgeMargin, tolerance: body.tolerance ?? 0.01, clearance: body.clearance, toolDiameter });
    const placements = plan.placements.map((placement) => ({ ...placement, gcode: jobs.find((job) => job.id === placement.id).gcode }));
    const name = String(body.name || `Grouped router sheet ${new Date().toLocaleDateString('en-CA')}`).trim();
    const gcode = generateGroupedRoutingGcode({ name, placements, params });
    const { data: auth } = await supabase.auth.getUser();
    const { data: group, error: groupError } = await supabase.from('cam_job_groups').insert({
      name, project_id: body.projectId || first.parts?.project_id || null, material_id: first.material_id, tool_id: first.tool_id, machine_id: first.machine_id,
      stock_width: Number(body.stockWidth), stock_height: Number(body.stockHeight), edge_margin: edgeMargin, tolerance: Number(body.tolerance ?? 0.01), clearance: plan.clearance,
      params, gcode, gcode_file_name: gcodeFileNameFor(name), created_by: auth.user?.id || null
    }).select().single();
    if (groupError) throw new Error(groupError.message);
    const { error: itemsError } = await supabase.from('cam_job_group_items').insert(plan.placements.map((placement, index) => ({ group_id: group.id, cam_job_id: placement.id, offset_x: placement.offsetX, offset_y: placement.offsetY, bounds: placement.bounds, sort_order: index })));
    if (itemsError) throw new Error(itemsError.message);
    return json({ group: { ...group, cam_job_group_items: plan.placements.map((placement, index) => ({ ...placement, sort_order: index })) }, plan });
  } catch (error) {
    return json({ error: error.message || 'Could not create grouped G-code' }, { status: 400 });
  }
}
