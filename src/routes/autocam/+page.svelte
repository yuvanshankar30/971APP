<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { formatPacificDateTimeWithZone } from '$lib/timezone.js';
  import { getSeasonBucket, getCurrentSeasonBucket, getAllSeasonBuckets, passesSeasonFilter } from '$lib/frcSeason.js';
  import { passesTeamFilter } from '$lib/frcTeams.js';
  import TeamFilter from '$lib/components/TeamFilter.svelte';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';
  import CamParamFields from '$autocam/components/CamParamFields.svelte';
  import RoutingToolSequence from '$autocam/components/RoutingToolSequence.svelte';
  import TurningFinishTool from '$autocam/components/TurningFinishTool.svelte';
  import TurningDrilling from '$autocam/components/TurningDrilling.svelte';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import ToolpathViewer from '$autocam/components/ToolpathViewer.svelte';
  import { toastActions } from '$lib/toast.js';
  import {
    queueCamJobForPart,
    queueCamJobsForParts,
    queueCamJobFromUpload,
    retryCamJob,
    cancelStuckCamJob,
    renameCamJob,
    updateCamJobNotes,
    deleteCamJob,
    updateCamJobAndRegenerate,
    isCamJobActive,
    WORKFLOW_OPERATION_TYPE,
    camJobStatusLabel,
    jobDisplayName,
    downloadGcodeBlob,
    downloadGcodeText,
    downloadStepFile,
    partHasStepFile,
    CAM_GCODE_FORMAT
  } from '$autocam/camJobs.js';
  import { tubestockFaceFileName, tubestockFaceLabel } from '$autocam/tubestock.js';
  import { machinesForOperation } from '$autocam/machineOptions.js';
  import stockData from '$lib/stock.json';
  import { normalizeGcodeComments } from '$autocam/gcodeComments.js';

  // Anything leaving the app to be read by a controller or a G-code viewer
  // gets its comments normalised first. Jobs generated before that fix still
  // hold nested comments, and a viewer stops on them ("nested comment found")
  // exactly as a control would.
  const cleanGcodeForExport = (gcode) => normalizeGcodeComments(gcode || '', { dialect: 'preserve' });
  import { buildStockMaterialIndex, materialIdForStockAssignment as resolveMaterialIdForStockAssignment } from '$autocam/stockMaterial.js';
  import { minimumPartClearance } from '$autocam/nesting.js';
  import { Cpu, Upload, Package, Settings, Download, AlertTriangle, X, Link as LinkIcon, Plus, Wrench, Layers, CheckCircle2, Loader2, Search, Filter, Box, Route, ExternalLink, Copy } from 'lucide-svelte';

  let user = null;
  let loading = true;
  let jobs = [];
  let materials = [];
  let tools = [];
  let machines = [];
  let machineTools = [];
  let jobGroups = [];
  let showGroupModal = false;
  let showGroupsModal = false;
  let groupProjectFilter = '';
  let groupName = '';
  let groupStockWidth = 48;
  let groupStockHeight = 48;
  let groupEdgeMargin = 0.5;
  let groupTolerance = 0.01;
  let groupSelectedJobIds = [];
  let creatingGroup = false;
  let selectedGroup = null;

  // Jobs list filters - mirrors the filter bar on /manufacture (search,
  // status, project-like dropdowns, season) adapted to what a CAM job
  // actually has: operation/material/tool/machine/creator instead of
  // workflow/project.
  const JOB_STATUSES = [
    { value: 'queued', label: 'Queued' },
    { value: 'claimed', label: 'Claimed' },
    { value: 'processing', label: 'Processing' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'rejected', label: 'Rejected' }
  ];
  let jobSearchTerm = '';
  let jobFilterOperation = '';
  let jobFilterStatus = '';
  let jobFilterMaterial = '';
  let jobFilterTool = '';
  let jobFilterMachine = '';
  let jobFilterCreatedBy = '';
  let jobFilterSeason = '';
  let jobFilterProject = '';
  let showMoreFilters = false;
  $: jobSeasonOptions = getAllSeasonBuckets(jobs);
  $: moreFiltersActive = !!(jobFilterMaterial || jobFilterTool || jobFilterMachine || jobFilterCreatedBy || jobFilterSeason || jobFilterProject);
  $: jobProjectIds = Array.from(new Set(jobs.map((job) => job.parts?.project_id).filter(Boolean))).sort();
  $: completedRouterJobs = jobs.filter((job) => job.operation_type === 'routing' && job.status === 'completed' && job.gcode);
  $: groupCandidates = completedRouterJobs.filter((job) => !groupProjectFilter || job.parts?.project_id === groupProjectFilter);
  $: selectedGroupJobs = groupCandidates.filter((job) => groupSelectedJobIds.includes(job.id));
  // Mirrors the server's check (src/routes/api/cam-groups/+server.js), which
  // stays the real guard - this only spares the round trip. Depth/thickness
  // is here because same material is not same stock: cam_materials says what
  // the stock is, never how thick, so two jobs can match on machine/tool/
  // material and still be cut for different sheets.
  const groupDepthOf = (job) => Number(job.params?.stockThickness ?? job.params?.targetDepth ?? job.stats?.targetDepth ?? NaN);
  const groupUnitsOf = (job) => String(job.params?.units || 'in').toLowerCase();
  $: groupCompatibilityError = selectedGroupJobs.length > 1 && selectedGroupJobs.some((job) => {
    const first = selectedGroupJobs[0];
    if (String(job.machine_id || '') !== String(first.machine_id || '')) return true;
    if (String(job.tool_id || '') !== String(first.tool_id || '')) return true;
    if (String(job.material_id || '') !== String(first.material_id || '')) return true;
    if (groupUnitsOf(job) !== groupUnitsOf(first)) return true;
    const firstDepth = groupDepthOf(first);
    const depth = groupDepthOf(job);
    if (Number.isFinite(firstDepth) && (!Number.isFinite(depth) || Math.abs(depth - firstDepth) > 1e-6)) return true;
    return false;
  });
  $: groupToolDiameter = Number(selectedGroupJobs[0]?.cam_tools?.diameter || selectedGroupJobs[0]?.params?.toolDiameter || 0);
  $: groupClearance = groupToolDiameter > 0 ? minimumPartClearance(groupToolDiameter, Number(groupTolerance) || 0) : null;
  $: jobCreators = [...new Map(jobs.filter((j) => j.requester).map((j) => [j.requester.id, j.requester])).values()]
    .sort((a, b) => (a.full_name || a.email || '').localeCompare(b.full_name || b.email || ''));
  $: filteredJobs = jobs.filter((j) => {
    const name = jobDisplayName(j).toLowerCase();
    const matchesSearch = !jobSearchTerm || name.includes(jobSearchTerm.toLowerCase()) || (j.parts?.name || '').toLowerCase().includes(jobSearchTerm.toLowerCase());
    const matchesOperation = !jobFilterOperation || j.operation_type === jobFilterOperation;
    const matchesStatus = !jobFilterStatus || j.status === jobFilterStatus;
    const matchesMaterial = !jobFilterMaterial || j.material_id === jobFilterMaterial;
    const matchesTool = !jobFilterTool || j.tool_id === jobFilterTool;
    const matchesMachine = !jobFilterMachine || j.machine_id === jobFilterMachine;
    const matchesCreatedBy = !jobFilterCreatedBy || j.requested_by === jobFilterCreatedBy;
    const matchesSeason = passesSeasonFilter(j.created_at, jobFilterSeason);
    const matchesProject = !jobFilterProject || j.parts?.project_id === jobFilterProject;
    return matchesSearch && matchesOperation && matchesStatus && matchesMaterial && matchesTool && matchesMachine && matchesCreatedBy && matchesSeason && matchesProject;
  });

  // Same status set shown on /manufacture's filter bar (combined across all workflows).
  const PART_STATUSES = [
    { value: 'pending', label: 'Pending' },
    { value: 'in-progress', label: 'In Progress' },
    { value: 'drawing', label: 'Drawing In Progress' },
    { value: 'machining', label: 'Machining' },
    { value: 'inspection', label: 'Inspection' },
    { value: 'cammed', label: 'CAM Reviewed' },
    { value: 'cam_review', label: 'CAM Review Pending' },
    { value: 'machined', label: 'Machined' },
    { value: 'complete', label: 'Complete' }
  ];

  function emptyTurningParams() {
    return { stockDiameter: '', stockShape: 'round', stepDown: 0.05, finishAllowance: 0.02, feedRough: 0.008, feedFinish: 0.004, surfaceSpeed: 150, maxRpm: 2500, setupMode: 'single', flipAt: '', finishTool: null, automaticToolChanger: false, drilling: null };
  }
  function emptyRoutingParams() {
    // Unspecified stock must not inherit the old wood-friendly 40/15/16k
    // settings. Material presets replace these with their own published
    // starting values as soon as a stock is selected.
    return { toolDiameter: 0.25, stepDown: 0.03, targetDepth: '', tabWidth: 0.25, tabHeight: 0.06, tabSpacing: 6, tabCount: '', feedRate: 25, plungeRate: 8, spindleSpeed: 14000, edgeMargin: 0.5, toolSequence: [] };
  }
  function emptyTubestockParams() {
    return { holeDepth: '', safeZ: 0.25, feedRate: 8, spindleSpeed: 8000 };
  }
  function emptyParamsFor(operationType) {
    if (operationType === 'turning') return emptyTurningParams();
    if (operationType === 'tubestock') return emptyTubestockParams();
    return emptyRoutingParams();
  }

  let showNewJobModal = false;
  let newJobName = '';
  let newJobNotes = '';
  let newJobOperation = 'routing'; // 'turning' | 'routing' | 'tubestock' - milling has no generator yet
  let newJobSource = 'upload';
  let newJobFile = null;
  let partSearchTerm = '';
  let eligibleParts = [];
  let partsLoading = false;
  let selectedPartId = '';
  let batchMode = false;
  let selectedPartIds = []; // batchMode only - queue one job per checked part, same material/tool/machine/params
  let batchProgress = null; // { index, total, partName } while a batch is running
  let selectedMaterialId = '';
  // Set once the user picks a material by hand, so the part-linked
  // carry-over below never overwrites a deliberate choice.
  let materialChosenByHand = false;
  let selectedToolId = '';
  let selectedMachineId = '';
  let submitting = false;
  let retryingJobId = null;
  let cancellingJobId = null;

  let showJobDetailModal = false;
  let editingJob = null;
  let editJobName = '';
  let editJobNotes = '';
  let editMaterialId = '';
  let editToolId = '';
  let editMachineId = '';
  let editParams = {};
  let editRenaming = false;
  let editSavingNotes = false;
  let editSubmitting = false;
  let editDeleting = false;
  let showJobCadModal = false;
  let showJobToolpathModal = false;
  let toolpathView = '3d';
  let toolpathPreviewParams = null;
  let ToolpathSimulator = null;
  let toolpathSimulatorLoading = false;
  let showNcviewerModal = false;
  let ncviewerCopyOk = null; // null = not attempted yet, true/false = result

  // Part-picker filters - mirrors the filter bar on /manufacture so parts are
  // easy to find the same way they are there.
  let partFilterStatus = '';
  let partFilterProject = '';
  let partFilterSeason = getCurrentSeasonBucket()?.value || '';
  let partShow971 = true;
  let partShow9584 = true;

  // Parameter form fields - only the fields relevant to newJobOperation get sent.
  let turningParams = emptyTurningParams();
  let routingParams = emptyRoutingParams();
  let tubestockParams = emptyTubestockParams();

  let showProfilesPanel = false;
  let showToolsModal = false;
  let toolMachineId = '';
  let newMaterialName = '';
  let newToolName = '';
  let newToolDiameter = '';
  let newToolNoseRadius = '';
  let newToolNumber = '';

  // Machine profile editor
  let showMachineModal = false;
  let editingMachineId = null;
  let machineForm = { name: '', description: '', operation_type: 'routing', default_material_id: '', default_tool_id: '', tool_ids: [], gcode_extension: 'ngc', controller: 'linuxcnc', rapid_rate: '', drive_folder_id: '', drive_output_folder_id: '', params: emptyRoutingParams() };
  let savingMachine = false;

  $: canManageProfiles = canManageCamProfiles(user);
  $: partProjectIds = Array.from(new Set(eligibleParts.filter((p) => p.project_id).map((p) => p.project_id))).sort();
  $: partSeasonOptions = getAllSeasonBuckets(eligibleParts);
  $: filteredEligibleParts = eligibleParts
    .filter((p) => WORKFLOW_OPERATION_TYPE[p.workflow] === newJobOperation)
    .filter(partHasStepFile) // only parts with an attached STEP can actually be CAM'd
    .filter((p) => !partSearchTerm || (p.name || '').toLowerCase().includes(partSearchTerm.toLowerCase()))
    .filter((p) => !partFilterStatus || p.status === partFilterStatus)
    .filter((p) => !partFilterProject || p.project_id === partFilterProject)
    .filter((p) => passesSeasonFilter(p.created_at, partFilterSeason))
    .filter((p) => passesTeamFilter(p.frc_team, partShow971, partShow9584));
  $: newJobMachines = machinesForOperation(machines, newJobOperation);
  // Hole depth comes from the tube's wall thickness now, so a tube stock job
  // without a stock has no depth and would fail in the generator rather than
  // here. Block it at the button instead.
  $: missingTubeStock = newJobOperation === 'tubestock' && !tubestockParams.stockCatalogId;
  $: selectedMachineTools = toolsForMachine(selectedMachineId);
  $: editMachineTools = toolsForMachine(editMachineId);
  $: jobStats = {
    total: jobs.length,
    generating: jobs.filter((j) => ['queued', 'claimed', 'processing'].includes(j.status)).length,
    completed: jobs.filter((j) => j.status === 'completed').length,
    failed: jobs.filter((j) => j.status === 'failed').length
  };

  onMount(() => {
    const unsub = userStore.subscribe((v) => { user = v; });
    (async () => {
      await loadUserFromUUID(supabase);
      await Promise.all([loadJobs(), loadReferenceData(), loadGroups()]);
      loading = false;
    })();
    return unsub;
  });

  // Live-patches one job's changing fields (status/progress/gcode/etc) into
  // the jobs list in place, preserving the joined display fields (part/
  // material/tool/machine/requester names) that a bare progress-poll row
  // doesn't carry - used so a job's row animates live while generating,
  // without needing a full loadJobs() round-trip on every poll tick.
  function patchJobInList(update) {
    jobs = jobs.map((j) => (j.id === update.id
      ? { ...j, status: update.status, progress: update.progress, progress_message: update.progress_message, gcode: update.gcode, errors: update.errors, stats: update.stats, gcode_file_name: update.gcode_file_name }
      : j));
  }

  async function loadJobs() {
    const { data, error } = await supabase
      .from('cam_jobs')
      .select('*, parts(name, project_id), cam_materials(name), cam_tools(name), cam_machines(name, rapid_rate)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return;

    // requested_by is a FK to auth.users, not public.user_profiles, so
    // PostgREST can't embed a join for it directly - resolve display names
    // with a separate batch lookup instead.
    const requesterIds = [...new Set((data || []).map((j) => j.requested_by).filter(Boolean))];
    let requesterById = new Map();
    if (requesterIds.length) {
      const { data: profiles } = await supabase.from('user_profiles').select('id, full_name, email').in('id', requesterIds);
      requesterById = new Map((profiles || []).map((p) => [p.id, p]));
    }
    jobs = (data || []).map((j) => ({ ...j, requester: j.requested_by ? requesterById.get(j.requested_by) || null : null }));
    const requestedJobId = $page.url.searchParams.get('job');
    const requestedJob = requestedJobId && jobs.find((job) => String(job.id) === requestedJobId);
    if (requestedJob && !showJobDetailModal) openJobDetail(requestedJob);
  }

  async function loadGroups() {
    const { data: sessionData } = await supabase.auth.getSession();
    const response = await fetch('/api/cam-groups', { headers: sessionData?.session?.access_token ? { authorization: `Bearer ${sessionData.session.access_token}` } : {} });
    if (!response.ok) return;
    const payload = await response.json();
    jobGroups = payload.groups || [];
    const requestedGroupId = $page.url.searchParams.get('group');
    const requestedGroup = requestedGroupId && jobGroups.find((group) => String(group.id) === requestedGroupId);
    if (requestedGroup) {
      selectedGroup = requestedGroup;
      showGroupsModal = true;
    }
  }

  function openGroupModal() {
    groupName = '';
    groupProjectFilter = '';
    groupSelectedJobIds = [];
    groupStockWidth = 48;
    groupStockHeight = 48;
    groupEdgeMargin = 0.5;
    groupTolerance = 0.01;
    showGroupModal = true;
  }

  function toggleGroupJob(jobId, checked) {
    groupSelectedJobIds = checked ? [...groupSelectedJobIds, jobId] : groupSelectedJobIds.filter((id) => id !== jobId);
  }

  async function createGroup() {
    if (selectedGroupJobs.length < 2) { toastActions.show('Select at least two completed router jobs'); return; }
    if (groupCompatibilityError) { toastActions.show('Selected jobs must share a machine, tool, material, units, and cut depth'); return; }
    creatingGroup = true;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const response = await fetch('/api/cam-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sessionData?.session?.access_token ? { authorization: `Bearer ${sessionData.session.access_token}` } : {}) },
        body: JSON.stringify({ name: groupName, projectId: groupProjectFilter || selectedGroupJobs[0]?.parts?.project_id || null, jobIds: groupSelectedJobIds, stockWidth: Number(groupStockWidth), stockHeight: Number(groupStockHeight), edgeMargin: Number(groupEdgeMargin), tolerance: Number(groupTolerance) })
      });
      const payload = await response.json();
      if (!response.ok) { toastActions.show(payload.error || 'Could not create grouped program'); return; }
      toastActions.show('Grouped router program created');
      showGroupModal = false;
      await Promise.all([loadGroups(), loadJobs()]);
      selectedGroup = payload.group;
      showGroupsModal = true;
    } finally { creatingGroup = false; }
  }

  function groupForJob(jobId) {
    return jobGroups.find((group) => group.cam_job_group_items?.some((item) => String(item.cam_job_id) === String(jobId)));
  }

  async function openGroupToolpath(group) {
    editingJob = { ...group, operation_type: 'routing', params: group.params || {}, stats: {} };
    await openToolpathPreview(editingJob, editingJob.params);
  }

  async function loadReferenceData() {
    const [m, t, mc, mt] = await Promise.all([
      supabase.from('cam_materials').select('*').order('name'),
      supabase.from('cam_tools').select('*').order('name'),
      supabase.from('cam_machines').select('*').order('name'),
      supabase.from('cam_machine_tools').select('machine_id, tool_id')
    ]);
    materials = m.data || [];
    tools = t.data || [];
    machines = mc.data || [];
    machineTools = mt.data || [];
  }

  function toolsForMachine(machineId) {
    const enabledTools = tools.filter((tool) => tool.enabled);
    if (!machineId) return enabledTools;
    const installedToolIds = new Set(machineTools
      .filter((link) => String(link.machine_id) === String(machineId))
      .map((link) => String(link.tool_id)));
    return enabledTools.filter((tool) => installedToolIds.has(String(tool.id)));
  }

  function applyToolDiameter(toolId, operationType, params) {
    const tool = tools.find((candidate) => String(candidate.id) === String(toolId));
    if (operationType !== 'routing' || !tool?.diameter) return params;
    return { ...params, toolDiameter: Number(tool.diameter) };
  }

  function selectNewJobTool(toolId) {
    selectedToolId = toolId;
    routingParams = applyToolDiameter(toolId, newJobOperation, routingParams);
  }

  function selectEditJobTool(toolId) {
    editToolId = toolId;
    editParams = applyToolDiameter(toolId, editingJob?.operation_type, editParams);
  }

  function selectEditMachine(machineId) {
    editMachineId = machineId;
    const machine = machines.find((candidate) => String(candidate.id) === String(machineId));
    const availableTools = toolsForMachine(machineId);
    const defaultTool = availableTools.find((tool) => String(tool.id) === String(machine?.default_tool_id));
    if (defaultTool) selectEditJobTool(defaultTool.id);
    else if (!availableTools.some((tool) => String(tool.id) === String(editToolId))) selectEditJobTool('');
  }

  async function loadEligibleParts() {
    partsLoading = true;
    try {
      const { data, error } = await supabase
        .from('parts')
        // stock_assignment is what the request recorded the part as being
        // made of - it's what carries the material into the job below.
        .select('id, name, project_id, workflow, status, created_at, frc_team, file_name, file_url, stock_assignment')
        .order('created_at', { ascending: false })
        .limit(500);
      eligibleParts = error ? [] : (data || []);
    } finally {
      partsLoading = false;
    }
  }

  // Pass a machine to jump straight into a new job pre-loaded with that
  // profile's defaults - the "use this profile" shortcut on each profile card.
  function openNewJobModal(machine = null) {
    newJobName = '';
    newJobNotes = '';
    newJobOperation = machine?.operation_type || 'routing';
    newJobSource = 'upload';
    newJobFile = null;
    selectedPartId = '';
    batchMode = false;
    selectedPartIds = [];
    batchProgress = null;
    selectedMaterialId = '';
    materialChosenByHand = false;
    selectedToolId = '';
    selectedMachineId = '';
    turningParams = emptyTurningParams();
    routingParams = emptyRoutingParams();
    tubestockParams = emptyTubestockParams();
    partSearchTerm = '';
    partFilterStatus = '';
    partFilterProject = '';
    partFilterSeason = getCurrentSeasonBucket()?.value || '';
    partShow971 = true;
    partShow9584 = true;
    showNewJobModal = true;
    if (eligibleParts.length === 0) loadEligibleParts();
    if (machine) {
      selectedMachineId = machine.id;
      applyMachineDefaults(machine.id);
    }
  }

  function closeNewJobModal() {
    showNewJobModal = false;
  }

  // Selecting a material pulls in its conservative starting feeds/speeds
  // (cam_materials.default_params, namespaced {turning: {...}, routing:
  // {...}} since one material can apply to either operation and the two
  // generators happen to share the param name `stepDown` for physically
  // different quantities - see migrations/20260821_cam_material_defaults.sql).
  // A material with nothing set for the current operation (e.g. plywood in
  // turning mode - nobody turns plywood) is a silent no-op, same as picking
  // a machine profile with an empty default_params already is.
  function applyMaterialDefaults(materialId) {
    const material = materials.find((m) => String(m.id) === String(materialId));
    const defaults = material?.default_params?.[newJobOperation];
    if (!defaults) return;
    if (newJobOperation === 'turning') {
      turningParams = { ...turningParams, ...defaults };
    } else if (newJobOperation === 'tubestock') {
      tubestockParams = { ...tubestockParams, ...defaults };
    } else {
      routingParams = { ...routingParams, ...defaults };
    }
  }

  // Same as applyMaterialDefaults, for the separate edit-job modal's own
  // params/operation-type state (editParams/editingJob.operation_type
  // instead of turningParams|routingParams/newJobOperation).
  function applyMaterialDefaultsToEdit(materialId) {
    const material = materials.find((m) => String(m.id) === String(materialId));
    const defaults = material?.default_params?.[editingJob?.operation_type];
    if (!defaults) return;
    editParams = { ...editParams, ...defaults };
  }

  // A manufacturing request already records the real stock the part gets
  // cut from - parts.stock_assignment holds stock.json's own `description`
  // string ('1/8" Aluminum Sheet', '1/4" SRPP'). AutoCAM stores material
  // as a cam_materials row instead, so a job created from a linked part
  // used to start with no material at all - and none of that material's
  // feeds/speeds defaults - even though the request that spawned it
  // already recorded what the part is made of. See autocam/stockMaterial.js
  // for how the two naming conventions are bridged.
  const stockMaterialIndex = buildStockMaterialIndex(stockData);
  const materialIdForStockAssignment = (stockAssignment) =>
    resolveMaterialIdForStockAssignment(stockMaterialIndex, materials, stockAssignment, stockData);

  // Carry the picked part's own recorded stock material into the job -
  // but never over a material the user set by hand.
  $: if (newJobSource === 'part' && !batchMode && selectedPartId && materials.length && !materialChosenByHand) {
    const pickedPart = eligibleParts.find((p) => String(p.id) === String(selectedPartId));
    const carried = pickedPart ? materialIdForStockAssignment(pickedPart.stock_assignment) : '';
    if (carried && String(carried) !== String(selectedMaterialId)) {
      selectedMaterialId = carried;
      applyMaterialDefaults(carried);
    }
  }

  // A material with no default_params for the operation being run is not a
  // neutral choice: applyMaterialDefaults is a silent no-op, so the job
  // keeps the generator's own generic fallback (routing.js
  // TOOL_STEP_DEFAULTS - feed 25 in/min, stepDown 0.03, spindle 14000,
  // which are aluminum's numbers). Running plywood or soft plastic on those
  // is slow and burns; running a harder material on them is how a bit
  // breaks. Say so rather than letting it pass unnoticed.
  function materialWithoutFeeds(materialId, operation) {
    if (!materialId || !operation) return null;
    const material = materials.find((m) => String(m.id) === String(materialId));
    if (!material) return null;
    const defaults = material.default_params?.[operation];
    return defaults && Object.keys(defaults).length > 0 ? null : material;
  }
  $: newJobMaterialWithoutFeeds = materialWithoutFeeds(selectedMaterialId, newJobOperation);
  $: editMaterialWithoutFeeds = materialWithoutFeeds(editMaterialId, editingJob?.operation_type);

  // Selecting a machine profile pulls in its saved defaults so settings
  // don't have to be re-entered every time - the whole point of profiles.
  function applyMachineDefaults(machineId) {
    const machine = machines.find((m) => String(m.id) === String(machineId));
    if (!machine) return;
    newJobOperation = machine.operation_type;
    if (machine.default_material_id) selectedMaterialId = machine.default_material_id;
    // Material's generic starting point first, then the machine profile's
    // own saved defaults layered on top - a machine profile is a more
    // specific, human-tuned setting than a generic material default, so it
    // wins on any overlapping key.
    applyMaterialDefaults(selectedMaterialId);
    if (machine.operation_type === 'turning') {
      turningParams = { ...turningParams, ...(machine.default_params || {}) };
    } else if (machine.operation_type === 'tubestock') {
      tubestockParams = { ...tubestockParams, ...(machine.default_params || {}) };
    } else {
      routingParams = { ...routingParams, ...(machine.default_params || {}) };
    }
    const availableTools = toolsForMachine(machineId);
    const defaultTool = availableTools.find((tool) => String(tool.id) === String(machine.default_tool_id));
    if (defaultTool) selectNewJobTool(defaultTool.id);
    else if (!availableTools.some((tool) => String(tool.id) === String(selectedToolId))) selectNewJobTool('');
  }

  function buildParams() {
    const raw = newJobOperation === 'turning' ? turningParams : (newJobOperation === 'tubestock' ? tubestockParams : routingParams);
    return serializeParams(raw);
  }

  // Numeric fields get coerced to Number(); toolSequence (routing multi-tool,
  // see autocam/docs/toolchange-gcode-plan.md) is an array of {toolId, toolDiameter,
  // toolNumber, label} objects, finishTool (turning multi-tool) is one
  // {toolId, toolNumber, label, noseRadius} object, and drilling (turning
  // centerline drilling) is one {toolNumber, label, diameter, depth,
  // peckDepth, feedRate, rpm} object - all three must pass through untouched.
  const NON_NUMERIC_PARAM_KEYS = new Set(['toolSequence', 'setupMode', 'finishTool', 'automaticToolChanger', 'stockShape', 'drilling', 'stockCatalogId']);

  function serializeParams(raw) {
    const params = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'toolSequence') {
        if (Array.isArray(value) && value.length > 0) params.toolSequence = value;
        continue;
      }
      if (key === 'finishTool' || key === 'drilling') {
        if (value && typeof value === 'object') params[key] = value;
        continue;
      }
      if (NON_NUMERIC_PARAM_KEYS.has(key)) {
        if (value !== '' && value !== null && value !== undefined) params[key] = value;
        continue;
      }
      if (value !== '' && value !== null && value !== undefined) params[key] = Number(value);
    }
    return params;
  }

  async function submitNewJob() {
    submitting = true;
    try {
      const baseOptions = {
        operationType: newJobOperation,
        materialId: selectedMaterialId || null,
        toolId: selectedToolId || null,
        machineId: selectedMachineId || null,
        params: buildParams(),
        userId: user?.id || null,
        notes: newJobNotes.trim() || null,
        gcodeExtension: machines.find((m) => m.id === selectedMachineId)?.gcode_extension
      };

      if (newJobSource === 'part' && batchMode) {
        const parts = eligibleParts.filter((p) => selectedPartIds.includes(p.id));
        if (parts.length === 0) { toastActions.show('Choose at least one part'); return; }

        // Deliberately keeps the modal open, showing progress, until the
        // whole sequential batch finishes - see queueCamJobsForParts for why
        // these run one at a time instead of in parallel.
        batchProgress = { index: 0, total: parts.length, partName: parts[0].name };
        const results = await queueCamJobsForParts(parts, {
          ...baseOptions,
          // Each part carries its own recorded stock material where it has
          // one; the form's choice is the fallback for the rest.
          materialIdForPart: materialChosenByHand
            ? null
            : (part) => materialIdForStockAssignment(part.stock_assignment),
          onPartStart: (part, i, total) => { batchProgress = { index: i, total, partName: part.name }; },
          onProgress: patchJobInList,
          onQueued: () => loadJobs() // live-refresh the list as each part lands, same as the single-job path
        });
        batchProgress = null;

        const succeeded = results.filter((r) => r.success).length;
        toastActions.show(
          succeeded === results.length
            ? `${succeeded} CAM job${succeeded === 1 ? '' : 's'} generated`
            : `${succeeded}/${results.length} jobs generated - check the jobs list for failures`
        );
        closeNewJobModal();
        await loadJobs();
        return;
      }

      const options = {
        ...baseOptions,
        name: newJobName.trim() || null,
        // As soon as the job is queued (not once generation finishes) - move
        // out of the New Job form and let the jobs list show progress instead.
        onQueued: async () => {
          closeNewJobModal();
          await loadJobs();
        },
        onProgress: patchJobInList
      };

      let result;
      if (newJobSource === 'upload') {
        if (!newJobFile) { toastActions.show('Choose a STEP file first'); return; }
        result = await queueCamJobFromUpload(newJobFile, options);
      } else {
        const part = eligibleParts.find((p) => String(p.id) === String(selectedPartId));
        if (!part) { toastActions.show('Choose a part first'); return; }
        result = await queueCamJobForPart(part, options); // reuses the part's existing STEP file
      }

      toastActions.show(result.success ? 'CAM generated' : (result.error || 'AutoCAM generation failed'));
      await loadJobs(); // final refresh - picks up joined material/tool/machine/requester names the live patch above doesn't carry
    } finally {
      submitting = false;
    }
  }

  async function handleRetryJob(job) {
    retryingJobId = job.id;
    try {
      const result = await retryCamJob(job, { userId: user?.id || null, onProgress: patchJobInList });
      toastActions.show(result.success ? 'CAM generated' : (result.error || 'AutoCAM generation failed'));
      await loadJobs();
    } finally {
      retryingJobId = null;
    }
  }

  async function handleCancelStuckJob(job) {
    cancellingJobId = job.id;
    try {
      await cancelStuckCamJob(job.id);
      await loadJobs();
    } finally {
      cancellingJobId = null;
    }
  }

  function openJobDetail(job) {
    editingJob = job;
    editJobName = job.name || '';
    editJobNotes = job.notes || '';
    editMaterialId = job.material_id || '';
    editToolId = job.tool_id || '';
    editMachineId = job.machine_id || '';
    editParams = {
      ...emptyParamsFor(job.operation_type),
      ...(job.params || {})
    };
    showJobDetailModal = true;
  }

  // Row-level "View CAD" / "View Toolpath" - open the same preview modals
  // used inside Edit Job, without opening the full edit form.
  function openCadPreview(job) {
    editingJob = job;
    showJobCadModal = true;
  }
  async function openToolpathPreview(job, previewParams = job.params) {
    editingJob = job;
    toolpathPreviewParams = previewParams;
    // Tube stock moves in X/Y/Z plus a rotary A axis the 2D preview can't
    // represent at all - it only ever has a 3D view, so go straight there.
    toolpathView = ['routing', 'turning', 'tubestock'].includes(job.operation_type) ? '3d' : '2d';
    showJobToolpathModal = true;
    if (toolpathView === '3d') await loadToolpathSimulator();
  }
  async function loadToolpathSimulator() {
    if (ToolpathSimulator || toolpathSimulatorLoading) return;
    toolpathSimulatorLoading = true;
    try {
      // Keep Three.js out of AutoCAM's normal startup path. The simulator is
      // an optional completed-job tool, so it only needs to load on demand.
      ToolpathSimulator = (await import('$autocam/components/ToolpathSimulator.svelte')).default;
    } catch (error) {
      console.error('Could not load the 3D toolpath simulator:', error);
      toastActions.show('Could not load the 3D toolpath simulator.');
      toolpathView = '2d';
    } finally {
      toolpathSimulatorLoading = false;
    }
  }
  async function open3DToolpathPreview(job, previewParams = job.params) {
    editingJob = job;
    toolpathPreviewParams = previewParams;
    toolpathView = '3d';
    showJobToolpathModal = true;
    await loadToolpathSimulator();
  }
  // Embeds ncviewer.com directly in the app (iframe) instead of a plain
  // external-tab link. ncviewer.com has no documented way to load a file by
  // URL (checked directly, twice), but it does accept pasted G-code text in
  // its editor pane - copying to the clipboard on open gets a real user to
  // "paste and it's loaded" in one step instead of download-then-drag.
  // Whether the iframe itself is even allowed to render depends on
  // ncviewer.com's own X-Frame-Options/CSP headers, which aren't something
  // this app controls or can detect - the modal always shows a plain "open
  // in a new tab" fallback link for that case.
  async function openNcviewer(job) {
    editingJob = job;
    ncviewerCopyOk = null;
    try {
      await navigator.clipboard.writeText(cleanGcodeForExport(job.gcode));
      ncviewerCopyOk = true;
    } catch {
      ncviewerCopyOk = false;
    }
    showNcviewerModal = true;
  }
  async function recopyNcviewerGcode() {
    if (!editingJob?.gcode) return;
    try {
      await navigator.clipboard.writeText(cleanGcodeForExport(editingJob.gcode));
      ncviewerCopyOk = true;
      toastActions.show('G-code copied');
    } catch {
      ncviewerCopyOk = false;
      toastActions.show('Could not copy - your browser may be blocking clipboard access');
    }
  }
  async function handleInstallCad(job) {
    const result = await downloadStepFile(job.step_file_name);
    if (!result.success) toastActions.show(result.error || 'Could not download STEP file');
  }

  function closeJobDetailModal() {
    showJobDetailModal = false;
    editingJob = null;
    showJobCadModal = false;
    showJobToolpathModal = false;
    showNcviewerModal = false;
  }

  async function saveJobName() {
    if (!editingJob) return;
    editRenaming = true;
    try {
      const result = await renameCamJob(editingJob.id, editJobName.trim());
      if (result.success) {
        toastActions.show('Renamed');
        await loadJobs();
        editingJob = jobs.find((j) => j.id === editingJob.id) || editingJob;
      } else {
        toastActions.show(result.error || 'Rename failed');
      }
    } finally {
      editRenaming = false;
    }
  }

  async function saveJobNotes() {
    if (!editingJob) return;
    editSavingNotes = true;
    try {
      const result = await updateCamJobNotes(editingJob.id, editJobNotes.trim());
      if (result.success) {
        toastActions.show('Notes saved');
        await loadJobs();
        editingJob = jobs.find((j) => j.id === editingJob.id) || editingJob;
      } else {
        toastActions.show(result.error || 'Could not save notes');
      }
    } finally {
      editSavingNotes = false;
    }
  }

  async function saveJobAndRegenerate() {
    if (!editingJob) return;
    editSubmitting = true;
    try {
      const result = await updateCamJobAndRegenerate(editingJob, {
        name: editJobName.trim() || null,
        notes: editJobNotes.trim() || null,
        materialId: editMaterialId,
        toolId: editToolId,
        machineId: editMachineId,
        params: serializeParams(editParams),
        gcodeExtension: machines.find((m) => m.id === editMachineId)?.gcode_extension,
        // As soon as it's queued (not once generation finishes) - move out of
        // the edit form and let the jobs list show progress instead.
        onQueued: async () => {
          closeJobDetailModal();
          await loadJobs();
        },
        onProgress: patchJobInList
      });
      toastActions.show(result.success ? 'CAM regenerated' : (result.error || 'AutoCAM generation failed'));
      await loadJobs();
    } finally {
      editSubmitting = false;
    }
  }

  async function deleteEditingJob() {
    if (!editingJob) return;
    if (!await requestConfirmation({ title: 'Delete AutoCAM job', message: `Delete job "${jobDisplayName(editingJob)}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true })) return;
    editDeleting = true;
    try {
      const result = await deleteCamJob(editingJob.id);
      if (result.success) {
        toastActions.show('Job deleted');
        closeJobDetailModal();
        await loadJobs();
      } else {
        toastActions.show(result.error || 'Delete failed');
      }
    } finally {
      editDeleting = false;
    }
  }

  function jobStatusClass(job) {
    if (job.status === 'completed') return 'status-complete';
    if (job.status === 'failed' || job.status === 'rejected') return 'status-error';
    return 'status-running';
  }

  const MACHINE_TYPE_LABEL = { turning: 'Lathe', routing: 'Router', milling: 'Mill', tubestock: 'Router' };
  function machineTypeLabel(operationType) {
    return MACHINE_TYPE_LABEL[operationType] || operationType || '—';
  }

  // Milling jobs are Fusion CAM jobs (autocam/fusion/) - they land in this
  // same cam_jobs table/list (loadJobs() has no operation_type filter) but
  // get their own label/color here rather than the raw "milling" string, so
  // it's clear at a glance which ones went through the external Fusion 360
  // Runner instead of this app's own in-process turning/routing math.
  const OPERATION_LABEL = { turning: 'Turning', routing: 'Routering', milling: 'Fusion', tubestock: 'Tube Stock' };
  function operationLabel(operationType) {
    return OPERATION_LABEL[operationType] || operationType || '—';
  }
  // Derived from the angle rather than trusting the stored label/name.
  // Jobs generated before tube faces were numbered by clock position carry
  // the old "Top"/"Right side" text, and showing two schemes side by side is
  // exactly the confusion the numbering is meant to remove - the operator
  // writes these numbers on the tube. The stored value is still the fallback
  // for a record with no angle on it.
  function tubeFaceFileName(job, faceProgram) {
    if (Number.isFinite(faceProgram?.angleDeg)) return tubestockFaceFileName(job.gcode_file_name, faceProgram.angleDeg);
    return faceProgram.fileName || tubestockFaceFileName(job.gcode_file_name, faceProgram.angleDeg);
  }

  function tubeFaceLabel(faceProgram) {
    if (Number.isFinite(faceProgram?.angleDeg)) return tubestockFaceLabel(faceProgram.angleDeg);
    return faceProgram.label || tubestockFaceLabel(faceProgram.angleDeg);
  }

  function downloadTubeFaceProgram(job, faceProgram) {
    downloadGcodeText(faceProgram.gcode, tubeFaceFileName(job, faceProgram));
  }

  const OPERATION_TAG_CLASS = { turning: 'tag-season', milling: 'tag-mentor', tubestock: 'tag-9584' };
  function operationTagClass(operationType) {
    return OPERATION_TAG_CLASS[operationType] || 'tag-971';
  }

  async function addMaterial() {
    if (!newMaterialName.trim()) return;
    const { error } = await supabase.from('cam_materials').insert({ name: newMaterialName.trim() });
    if (error) { toastActions.show('Failed to add material'); return; }
    newMaterialName = '';
    await loadReferenceData();
  }

  function openToolsModal(machineId = '') {
    toolMachineId = machineId;
    showToolsModal = true;
  }

  async function addTool() {
    if (!newToolName.trim()) return;
    const diameter = newToolDiameter ? Number(newToolDiameter) : null;
    if (newToolDiameter && (!Number.isFinite(diameter) || diameter <= 0)) {
      toastActions.show('Tool diameter must be greater than zero');
      return;
    }
    const { data, error } = await supabase.from('cam_tools').insert({
      name: newToolName.trim(),
      tool_type: 'endmill',
      diameter,
      nose_radius: newToolNoseRadius ? Number(newToolNoseRadius) : null,
      tool_number: newToolNumber ? Number(newToolNumber) : null
    }).select().single();
    if (error) { toastActions.show('Failed to add tool'); return; }
    if (toolMachineId && data?.id) {
      const { error: associationError } = await supabase
        .from('cam_machine_tools')
        .insert({ machine_id: toolMachineId, tool_id: data.id, created_by: user?.id || null });
      if (associationError) {
        toastActions.show('Tool added, but could not attach it to this machine');
        await loadReferenceData();
        return;
      }
    }
    newToolName = '';
    newToolDiameter = '';
    newToolNoseRadius = '';
    newToolNumber = '';
    await loadReferenceData();
    if (toolMachineId && data?.id) selectNewJobTool(data.id);
  }

  async function toggleEnabled(table, row) {
    const { error } = await supabase.from(table).update({ enabled: !row.enabled }).eq('id', row.id);
    if (!error) await loadReferenceData();
  }

  function openMachineModal(machine = null) {
    if (machine) {
      editingMachineId = machine.id;
      machineForm = {
        name: machine.name,
        description: machine.description || '',
        operation_type: machine.operation_type,
        default_material_id: machine.default_material_id || '',
        default_tool_id: machine.default_tool_id || '',
        tool_ids: machineTools.filter((link) => String(link.machine_id) === String(machine.id)).map((link) => link.tool_id),
        gcode_extension: machine.gcode_extension || 'ngc',
        controller: machine.controller || 'linuxcnc',
        rapid_rate: machine.rapid_rate ?? '',
        drive_folder_id: machine.drive_folder_id || '',
        drive_output_folder_id: machine.drive_output_folder_id || '',
        params: {
          ...emptyParamsFor(machine.operation_type),
          ...(machine.default_params || {})
        }
      };
    } else {
      editingMachineId = null;
      machineForm = { name: '', description: '', operation_type: 'routing', default_material_id: '', default_tool_id: '', tool_ids: [], gcode_extension: 'ngc', controller: 'linuxcnc', rapid_rate: '', drive_folder_id: '', drive_output_folder_id: '', params: emptyRoutingParams() };
    }
    showMachineModal = true;
  }

  function closeMachineModal() {
    showMachineModal = false;
    editingMachineId = null;
  }

  function setMachineFormOperation(op) {
    machineForm.operation_type = op;
    machineForm.params = emptyParamsFor(op);
  }

  async function saveMachine() {
    if (!machineForm.name.trim()) { toastActions.show('Machine profile needs a name'); return; }
    savingMachine = true;
    try {
      const row = {
        name: machineForm.name.trim(),
        description: machineForm.description.trim() || null,
        operation_type: machineForm.operation_type,
        default_material_id: machineForm.default_material_id || null,
        default_tool_id: machineForm.default_tool_id || null,
        gcode_extension: machineForm.gcode_extension || 'ngc',
        // Tube stock reuses routing.js's linuxcnc/wincnc dialect conventions
        // (see tubestock.js file header) - same controller choice as routing.
        controller: (machineForm.operation_type === 'routing' || machineForm.operation_type === 'tubestock') ? (machineForm.controller || 'linuxcnc') : 'linuxcnc',
        // Blank stays NULL rather than becoming 0 - "not measured yet" is a
        // real state the estimate reports differently from a real figure.
        rapid_rate: machineForm.rapid_rate === '' || machineForm.rapid_rate == null ? null : Number(machineForm.rapid_rate),
        drive_folder_id: machineForm.drive_folder_id?.trim() || null,
        drive_output_folder_id: machineForm.drive_output_folder_id?.trim() || null,
        default_params: serializeParams(machineForm.params)
      };
      const { data: savedMachine, error } = editingMachineId
        ? await supabase.from('cam_machines').update(row).eq('id', editingMachineId)
          .select('id').single()
        : await supabase.from('cam_machines').insert({ ...row, created_by: user?.id || null })
          .select('id').single();
      if (error) { toastActions.show('Failed to save machine profile'); return; }
      const toolIds = [...new Set([...(machineForm.tool_ids || []), machineForm.default_tool_id].filter(Boolean))];
      const { error: removeError } = await supabase.from('cam_machine_tools').delete().eq('machine_id', savedMachine.id);
      if (removeError) { toastActions.show('Machine profile saved, but its tool list could not be updated'); return; }
      if (toolIds.length) {
        const { error: toolError } = await supabase.from('cam_machine_tools').insert(toolIds.map((tool_id) => ({ machine_id: savedMachine.id, tool_id, created_by: user?.id || null })));
        if (toolError) { toastActions.show('Machine profile saved, but its tool list could not be updated'); return; }
      }
      toastActions.show('Machine profile saved');
      closeMachineModal();
      await loadReferenceData();
    } finally {
      savingMachine = false;
    }
  }
</script>

<svelte:head><title>AutoCAM | Spartans Hub</title></svelte:head>

<div class="page-header autocam-page-header">
  <h1><Cpu size={28} /> AutoCAM</h1>
  <div class="page-actions">
    <a class="btn btn-secondary" href="/autocam/fusion">
      <Layers size={16} /> Fusion CAM
    </a>
    <button class="btn btn-secondary" on:click={openGroupModal} title="Create one router program for multiple compatible completed jobs">
      <Layers size={16} /> Group Jobs
    </button>
    <button class="btn btn-secondary" on:click={() => (showGroupsModal = true)} title="View grouped router programs">
      <Route size={16} /> View Groups
    </button>
    {#if canManageProfiles}
      <button class="btn btn-secondary" on:click={() => (showProfilesPanel = !showProfilesPanel)}>
        <Settings size={16} /> {showProfilesPanel ? 'Hide' : 'Manage'} Profiles
      </button>
    {/if}
    <button class="btn btn-secondary" on:click={() => openToolsModal()}>
      <Wrench size={16} /> Manage Tools
    </button>
    <button class="btn btn-primary" on:click={openNewJobModal}>
      <Upload size={16} /> New Job
    </button>
  </div>
</div>
<p class="page-subtitle">Upload a STEP file — or link an existing part that already has one — and get {CAM_GCODE_FORMAT.toUpperCase()} G-code back immediately for turning (lathe) or routering.</p>

{#if !loading && materials.length === 0 && tools.length === 0 && machines.length === 0}
  <div class="card setup-warning">
    <AlertTriangle size={20} />
    <div>
      <strong>No materials, tools, or machine profiles found.</strong>
      <p>
        This usually means <code>migrations/20260817_cam_studio_system.sql</code> hasn't been run against the
        database yet (or was run before Machine Profiles existed). Re-running that file is safe even if it partially
        ran before - every statement in it checks for existing tables/columns/policies first. Material and Tool are
        optional either way, but Machine Profiles won't show up until this runs.
      </p>
    </div>
  </div>
{/if}

{#if !loading}
  <div class="stats-grid">
    <div class="stat-card">
      <Layers size={20} />
      <div class="stat-info"><h3>{jobStats.total}</h3><p>Total Jobs</p></div>
    </div>
    <div class="stat-card">
      <Loader2 size={20} />
      <div class="stat-info"><h3>{jobStats.generating}</h3><p>Generating</p></div>
    </div>
    <div class="stat-card">
      <CheckCircle2 size={20} />
      <div class="stat-info"><h3>{jobStats.completed}</h3><p>Completed</p></div>
    </div>
    <div class="stat-card">
      <AlertTriangle size={20} />
      <div class="stat-info"><h3>{jobStats.failed}</h3><p>Failed</p></div>
    </div>
  </div>
{/if}

{#if showProfilesPanel && canManageProfiles}
  <div class="card">
    <h2>Machine Profiles</h2>
    <p class="cam-form-hint">Saved settings bundles per physical machine, so parameters don't have to be re-entered for every job.</p>
    <div class="machine-profiles-grid">
      {#each machines as mc}
        <div class="machine-profile-card" class:disabled={!mc.enabled}>
          <div class="machine-profile-header">
            <div>
              <strong>{mc.name}</strong>
              <span class="tag {operationTagClass(mc.operation_type)}">{mc.operation_type}</span>
            </div>
            <button class="btn btn-ghost btn-sm" on:click={() => toggleEnabled('cam_machines', mc)}>{mc.enabled ? 'Disable' : 'Enable'}</button>
          </div>
          {#if mc.description}<p class="machine-profile-desc">{mc.description}</p>{/if}
          <div class="machine-profile-meta">
            {#if mc.default_material_id}<span class="part-picker-tag">{materials.find((m) => m.id === mc.default_material_id)?.name || 'Material set'}</span>{/if}
            {#if mc.default_tool_id}<span class="part-picker-tag">{tools.find((t) => t.id === mc.default_tool_id)?.name || 'Tool set'}</span>{/if}
          </div>
          <div class="machine-profile-actions">
            <button class="btn btn-primary btn-sm" disabled={!mc.enabled} on:click={() => openNewJobModal(mc)}>
              <Upload size={14} /> New Job
            </button>
            <button class="btn btn-secondary btn-sm" on:click={() => openMachineModal(mc)}>
              <Settings size={14} /> Edit
            </button>
          </div>
        </div>
      {/each}
      <button class="machine-profile-add" on:click={() => openMachineModal()}>
        <Plus size={20} /> Add Machine Profile
      </button>
    </div>
  </div>
{/if}

{#if showToolsModal}
  <div class="modal-backdrop" on:click|self={() => (showToolsModal = false)} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') (showToolsModal = false); }}>
    <div class="modal tools-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>{toolMachineId ? `Tools for ${machines.find((machine) => String(machine.id) === String(toolMachineId))?.name || 'Machine'}` : 'Materials & Tools'}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={() => (showToolsModal = false)}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <div class="profiles-grid">
          {#if !toolMachineId}
          <div class="profile-col">
            <h3>Materials</h3>
            {#each materials as m}
              <div class="profile-row" class:disabled={!m.enabled}>
                <span>{m.name}</span>
                <button class="btn btn-ghost btn-sm" on:click={() => toggleEnabled('cam_materials', m)}>{m.enabled ? 'Disable' : 'Enable'}</button>
              </div>
            {/each}
            <div class="input-group">
              <input class="form-input" placeholder="New material name" bind:value={newMaterialName} />
              <button class="btn btn-sm btn-nowrap" on:click={addMaterial}>Add</button>
            </div>
          </div>
          {/if}

          <div class="profile-col">
            <h3>{toolMachineId ? 'Installed tools' : 'Tools'}</h3>
            {#each (toolMachineId ? toolsForMachine(toolMachineId) : tools) as t}
              <div class="profile-row" class:disabled={!t.enabled}>
                <span>{t.name}{t.diameter ? ` (${t.diameter}" dia)` : ''}{t.nose_radius ? ` R${t.nose_radius}` : ''}{t.tool_number ? ` - T${t.tool_number}` : ''}</span>
                <button class="btn btn-ghost btn-sm" on:click={() => toggleEnabled('cam_tools', t)}>{t.enabled ? 'Disable' : 'Enable'}</button>
              </div>
            {/each}
            <div class="input-group">
              <input class="form-input" placeholder="Tool name" bind:value={newToolName} />
              <input class="form-input" placeholder="Diameter (in)" type="number" step="0.0625" bind:value={newToolDiameter} />
              <input class="form-input" placeholder="Nose radius (in, lathe only)" type="number" step="0.001" bind:value={newToolNoseRadius} />
              <input class="form-input" placeholder="Tool # (T-word)" type="number" step="1" min="1" bind:value={newToolNumber} title="Tool number for the T-word in tool-change G-code (e.g. 2 for T0202)" />
              <button class="btn btn-sm btn-nowrap" on:click={addTool}>Add</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if !loading && jobs.length > 0}
  <div class="card">
    <div class="filters" style="--filters-columns: 2fr 1fr 1fr;">
      <div class="form-group">
        <label class="form-label"><Search size={16} /> Search</label>
        <input type="text" class="form-input" placeholder="Search by job or part name..." bind:value={jobSearchTerm} />
      </div>
      <div class="form-group">
        <label class="form-label"><Filter size={16} /> Operation</label>
        <select class="form-select" bind:value={jobFilterOperation}>
          <option value="">All Operations</option>
          <option value="turning">Turning</option>
          <option value="routing">Routering</option>
          <option value="milling">Fusion</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label"><Filter size={16} /> Status</label>
        <select class="form-select" bind:value={jobFilterStatus}>
          <option value="">All Statuses</option>
          {#each JOB_STATUSES as s}
            <option value={s.value}>{s.label}</option>
          {/each}
        </select>
      </div>
    </div>

    <button type="button" class="more-filters-toggle" on:click={() => (showMoreFilters = !showMoreFilters)}>
      {showMoreFilters ? '− Fewer filters' : '+ More filters'}
      {#if moreFiltersActive && !showMoreFilters}<span class="more-filters-dot" title="A hidden filter is active"></span>{/if}
    </button>

    {#if showMoreFilters}
      <div class="filters" style="--filters-columns: 1fr 1fr 1fr 1fr;">
        <div class="form-group">
          <label class="form-label"><Filter size={16} /> Material</label>
          <select class="form-select" bind:value={jobFilterMaterial}>
            <option value="">All Materials</option>
            {#each materials as m}
              <option value={m.id}>{m.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label"><Filter size={16} /> Project ID</label>
          <select class="form-select" bind:value={jobFilterProject}>
            <option value="">All Projects</option>
            {#each jobProjectIds as projectId}<option value={projectId}>{projectId}</option>{/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label"><Filter size={16} /> Tool</label>
          <select class="form-select" bind:value={jobFilterTool}>
            <option value="">All Tools</option>
            {#each tools as t}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label"><Filter size={16} /> Machine</label>
          <select class="form-select" bind:value={jobFilterMachine}>
            <option value="">All Machines</option>
            {#each machines as mc}
              <option value={mc.id}>{mc.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label"><Filter size={16} /> Created By</label>
          <select class="form-select" bind:value={jobFilterCreatedBy}>
            <option value="">Everyone</option>
            {#each jobCreators as c}
              <option value={c.id}>{c.full_name || c.email}</option>
            {/each}
          </select>
        </div>
        <SeasonFilter options={jobSeasonOptions} bind:value={jobFilterSeason} />
      </div>
    {/if}
  </div>
{/if}

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else if jobs.length === 0}
  <div class="card empty-state">
    <Cpu size={48} />
    <h3>No AutoCAM jobs yet</h3>
    <p>Click "New Job" to generate your first G-code file.</p>
  </div>
{:else if filteredJobs.length === 0}
  <div class="card empty-state">
    <Filter size={48} />
    <h3>No jobs match these filters</h3>
  </div>
{:else}
  <div class="table-container autocam-jobs-container">
    <table class="table autocam-jobs-table">
      <thead>
        <tr>
          <th>Job</th>
          <th>Operation</th>
          <th>Material</th>
          <th>Tool</th>
          <th>Machine</th>
          <th>Machine Type</th>
          <th>Status</th>
          <th>Created</th>
          <th>Created By</th>
          <th>Output</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredJobs as job (job.id)}
          {@const bucket = getSeasonBucket(job.created_at)}
          <tr class="job-row" on:click={() => openJobDetail(job)} tabindex="0" role="button" on:keydown={(e) => { if (e.key === 'Enter') openJobDetail(job); }}>
            <td data-label="Job">
              <div class="name-line">
                {#if job.source_type === 'part'}<Package size={14} />{:else}<Upload size={14} />{/if}
                <strong title={jobDisplayName(job)}>{jobDisplayName(job)}</strong>
              </div>
              {#if job.source_type === 'part' && job.part_id}
                <a class="job-part-link" href="/manufacture?part={job.part_id}" on:click|stopPropagation>
                  <LinkIcon size={12} /> {job.parts?.name || `Part #${job.part_id}`}
                </a>
              {/if}
              {#if groupForJob(job.id)}
                <button class="grouped-link" type="button" on:click|stopPropagation={() => { selectedGroup = groupForJob(job.id); showGroupsModal = true; }}>
                  <CheckCircle2 size={12} /> Grouped: {groupForJob(job.id).name}
                </button>
              {/if}
            </td>
            <td data-label="Operation">
              <span class="tag {operationTagClass(job.operation_type)}">{operationLabel(job.operation_type)}</span>
            </td>
            <td data-label="Material">{job.cam_materials?.name || '—'}</td>
            <td data-label="Tool">{job.cam_tools?.name || '—'}</td>
            <td data-label="Machine">{job.cam_machines?.name || '—'}</td>
            <td data-label="Machine Type">
              <span class="tag {operationTagClass(job.operation_type)}">{machineTypeLabel(job.operation_type)}</span>
            </td>
            <td data-label="Status">
              <span class="status-badge {jobStatusClass(job)}">{camJobStatusLabel(job.status)}</span>
              {#if isCamJobActive(job)}
                <div class="job-row-progress">
                  <div class="job-row-progress-bar"><div class="job-row-progress-fill" style="width: {job.progress || 0}%"></div></div>
                  {#if job.progress_message}<span class="job-row-progress-label">{job.progress_message}</span>{/if}
                </div>
              {/if}
            </td>
            <td data-label="Created">
              <span class="job-created-date">{formatPacificDateTimeWithZone(job.created_at)}</span>
              {#if bucket}
                <span class="tag season-tag {bucket.isOffseason ? 'tag-offseason' : 'tag-season'}">{bucket.label}</span>
              {/if}
            </td>
            <td data-label="Created By">{job.requester?.full_name || job.requester?.email || '—'}</td>
            <td data-label="Output" on:click|stopPropagation class="output-cell">
              <div class="output-actions">
                {#if job.step_file_name}
                  <span class="output-action-group">
                    <button class="btn btn-icon" data-tooltip="View CAD" aria-label="View CAD" on:click={() => openCadPreview(job)}><Box size={15} /></button>
                    <button class="btn btn-icon" data-tooltip="Install STEP" aria-label="Install STEP file" on:click={() => handleInstallCad(job)}><Download size={15} /></button>
                  </span>
                {/if}
                {#if job.status === 'completed' && job.gcode}
                  <span class="output-action-group">
                    <button class="btn btn-secondary btn-sm" on:click={() => openToolpathPreview(job)}>
                      <Route size={14} /> Show Toolpath
                    </button>
                    <button class="btn btn-secondary btn-sm" title={job.gcode_file_name || 'output.ngc'} on:click={() => downloadGcodeBlob(job)}>
                      <Download size={14} /> Install NGC
                    </button>
                    {#if job.operation_type === 'tubestock' && job.stats?.facePrograms?.length}
                      <details class="tube-face-files">
                        <summary class="btn btn-secondary btn-sm"><Download size={14} /> Face files ({job.stats.facePrograms.length})</summary>
                        <div class="tube-face-files-list">
                          {#each job.stats.facePrograms as faceProgram}
                            <button class="btn btn-secondary btn-sm" title={tubeFaceFileName(job, faceProgram)} on:click={() => downloadTubeFaceProgram(job, faceProgram)}>
                              <Download size={14} /> {tubeFaceLabel(faceProgram)}
                            </button>
                          {/each}
                        </div>
                      </details>
                    {/if}
                    <button class="btn btn-icon" data-tooltip="Open ncviewer.com" aria-label="Open ncviewer.com with the G-code copied to your clipboard" on:click={() => openNcviewer(job)}><ExternalLink size={15} /></button>
                  </span>
                {/if}
              </div>
              {#if job.status === 'failed' && job.errors?.length}
                <div class="job-output-failed">
                  <span class="job-error" title={job.errors.join('; ')}><AlertTriangle size={14} /> {job.errors[0]}</span>
                  {#if job.step_file_name}
                    <button class="btn btn-secondary btn-sm" on:click={() => handleRetryJob(job)} disabled={retryingJobId === job.id}>
                      {retryingJobId === job.id ? 'Retrying…' : 'Retry'}
                    </button>
                  {/if}
                </div>
              {:else if isCamJobActive(job)}
                <button class="btn btn-secondary btn-sm" on:click={() => handleCancelStuckJob(job)} disabled={cancellingJobId === job.id} title="Stuck? Mark this job as failed so you can retry.">
                  {cancellingJobId === job.id ? 'Cancelling…' : 'Cancel'}
                </button>
              {:else if !job.step_file_name}
                <span class="text-muted">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if showGroupModal}
  <div class="modal-backdrop" on:click|self={() => (showGroupModal = false)} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') showGroupModal = false; }}>
    <div class="modal group-modal" role="dialog" aria-modal="true">
      <div class="modal-header"><h3>Group Router Jobs</h3><button type="button" class="modal-close-button" aria-label="Close" on:click={() => (showGroupModal = false)}><X size={18} /></button></div>
      <div class="modal-body group-modal-body">
        <div class="group-intro">
          <Layers size={20} />
          <div><strong>Shared-sheet router program</strong><span>Completed router jobs only. Machine, end mill, and material must match.</span></div>
          <span class="tag tag-success">Router only</span>
        </div>
        <div class="group-setup-grid">
          <div class="form-group"><label class="form-label" for="group-name">Group name</label><input id="group-name" class="form-input" bind:value={groupName} placeholder="e.g. P006950 router sheet" /></div>
          <div class="form-group"><label class="form-label" for="group-project">Project ID</label><select id="group-project" class="form-select" bind:value={groupProjectFilter}><option value="">All projects</option>{#each jobProjectIds as projectId}<option value={projectId}>{projectId}</option>{/each}</select></div>
          <div class="form-group"><label class="form-label" for="group-stock-width">Usable stock width (in)</label><input id="group-stock-width" class="form-input" type="number" min="0.1" step="0.125" bind:value={groupStockWidth} /></div>
          <div class="form-group"><label class="form-label" for="group-stock-height">Usable stock height (in)</label><input id="group-stock-height" class="form-input" type="number" min="0.1" step="0.125" bind:value={groupStockHeight} /></div>
          <div class="form-group"><label class="form-label" for="group-edge-margin">Edge margin (in)</label><input id="group-edge-margin" class="form-input" type="number" min="0" step="0.01" bind:value={groupEdgeMargin} /></div>
          <div class="form-group"><label class="form-label" for="group-tolerance">Tolerance allowance (in)</label><input id="group-tolerance" class="form-input" type="number" min="0" step="0.001" bind:value={groupTolerance} /></div>
        </div>
        <div class="group-selection-heading"><strong>Select completed jobs</strong><span>{selectedGroupJobs.length} selected</span></div>
        <div class="part-picker group-picker" aria-label="Completed router jobs available for grouping">
          {#if groupCandidates.length === 0}<p class="text-muted">No completed router jobs match this project filter.</p>{/if}
          {#each groupCandidates as job (job.id)}
            <label class="part-picker-row">
              <input type="checkbox" checked={groupSelectedJobIds.includes(job.id)} on:change={(event) => toggleGroupJob(job.id, event.currentTarget.checked)} />
              <span class="part-picker-name"><strong>{jobDisplayName(job)}</strong>{#if job.parts?.project_id}<small>{job.parts.project_id}</small>{/if}</span>
              <span class="group-job-setup">{job.cam_machines?.name || 'No machine'}<small>{job.cam_tools?.name || 'No tool'}</small></span>
            </label>
          {/each}
        </div>
        {#if groupCompatibilityError}<p class="cam-form-warning"><AlertTriangle size={14} /> Select jobs that use the same machine, tool, and material.</p>{/if}
        <div class="group-clearance-summary">
          <span>Required path clearance</span>
          <strong>{groupClearance ? `${groupClearance.toFixed(4)} in` : 'Select a job'}</strong>
          <small>{groupClearance ? `${groupToolDiameter.toFixed(4)} in end mill + twice tolerance` : 'Calculated from the selected router tool and tolerance.'}</small>
        </div>
      </div>
      <div class="modal-footer-actions group-modal-footer"><span class="text-muted">Review the 3D toolpath before cutting.</span><button class="btn btn-primary" disabled={creatingGroup || selectedGroupJobs.length < 2 || groupCompatibilityError} on:click={createGroup}><Layers size={15} /> {creatingGroup ? 'Creating…' : 'Create grouped G-code'}</button></div>
    </div>
  </div>
{/if}

{#if showGroupsModal}
  <div class="modal-backdrop" on:click|self={() => { showGroupsModal = false; selectedGroup = null; }} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') { showGroupsModal = false; selectedGroup = null; } }}>
    <div class="modal groups-modal" role="dialog" aria-modal="true">
      <div class="modal-header"><h3>{selectedGroup ? selectedGroup.name : 'Grouped Router Programs'}</h3><button type="button" class="modal-close-button" aria-label="Close" on:click={() => { showGroupsModal = false; selectedGroup = null; }}><X size={18} /></button></div>
      <div class="modal-body">
        {#if selectedGroup}
          <div class="group-summary"><span class="tag tag-success">Grouped</span><span>{selectedGroup.stock_width}" x {selectedGroup.stock_height}" stock</span><span>{selectedGroup.clearance}" path clearance</span></div>
          <div class="group-item-list">
            {#each selectedGroup.cam_job_group_items || [] as item}<div><strong>{item.cam_jobs?.parts?.name || item.cam_jobs?.name || 'Router job'}</strong><span> X{Number(item.offset_x).toFixed(3)} Y{Number(item.offset_y).toFixed(3)}</span></div>{/each}
          </div>
          <div class="modal-footer-actions"><button class="btn btn-secondary" on:click={() => openGroupToolpath(selectedGroup)}><Route size={15} /> Show Toolpath</button><button class="btn btn-primary" on:click={() => downloadGcodeText(selectedGroup.gcode, selectedGroup.gcode_file_name)}><Download size={15} /> Install NGC</button></div>
        {:else}
          <div class="form-group"><label class="form-label" for="view-group-project">Project ID</label><select id="view-group-project" class="form-select" bind:value={groupProjectFilter} on:change={loadGroups}><option value="">All projects</option>{#each jobProjectIds as projectId}<option value={projectId}>{projectId}</option>{/each}</select></div>
          {#if jobGroups.length === 0}<p class="text-muted">No grouped router programs yet.</p>{/if}
          <div class="group-item-list">{#each jobGroups.filter((group) => !groupProjectFilter || group.project_id === groupProjectFilter) as group}<button type="button" class="group-list-row" on:click={() => (selectedGroup = group)}><span><strong>{group.name}</strong><small>{group.project_id || 'No project'} · {group.cam_job_group_items?.length || 0} parts</small></span><span class="tag tag-success">Grouped</span></button>{/each}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showNewJobModal}
  <div class="modal-backdrop" on:click|self={closeNewJobModal} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') closeNewJobModal(); }}>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>New AutoCAM Job</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={closeNewJobModal}><X size={18} /></button>
      </div>
      <div class="modal-body">
        {#if !(newJobSource === 'part' && batchMode)}
          <div class="form-group">
            <label class="form-label" for="job-name">Job Name <span class="text-muted">(optional)</span></label>
            <input id="job-name" class="form-input" placeholder="e.g. Gearbox side plate" bind:value={newJobName} />
          </div>
          <div class="form-group">
            <label class="form-label" for="job-notes">Notes <span class="text-muted">(optional)</span></label>
            <textarea id="job-notes" class="form-input" rows="2" placeholder="e.g. verify stock height before running, customer wants 2 of these" bind:value={newJobNotes}></textarea>
          </div>
        {/if}

        <div class="job-choice-groups">
          <fieldset class="job-choice-group">
            <legend class="form-label">Operation</legend>
            <div class="job-choice-options job-choice-options--operation">
              <button type="button" class="btn" class:btn-primary={newJobOperation === 'routing'} class:btn-secondary={newJobOperation !== 'routing'} aria-pressed={newJobOperation === 'routing'} on:click={() => (newJobOperation = 'routing')}>Routering</button>
              <button type="button" class="btn" class:btn-primary={newJobOperation === 'turning'} class:btn-secondary={newJobOperation !== 'turning'} aria-pressed={newJobOperation === 'turning'} on:click={() => (newJobOperation = 'turning')}>Turning</button>
              <button type="button" class="btn" class:btn-primary={newJobOperation === 'tubestock'} class:btn-secondary={newJobOperation !== 'tubestock'} aria-pressed={newJobOperation === 'tubestock'} on:click={() => { newJobOperation = 'tubestock'; newJobSource = 'upload'; }}>Tube Stock</button>
            </div>
          </fieldset>
          <fieldset class="job-choice-group">
            <legend class="form-label">Source</legend>
            <div class="job-choice-options job-choice-options--source">
              <button type="button" class="btn" class:btn-primary={newJobSource === 'upload'} class:btn-secondary={newJobSource !== 'upload'} aria-pressed={newJobSource === 'upload'} on:click={() => (newJobSource = 'upload')}>Upload STEP file</button>
              <button type="button" class="btn" class:btn-primary={newJobSource === 'part'} class:btn-secondary={newJobSource !== 'part'} aria-pressed={newJobSource === 'part'} disabled={newJobOperation === 'tubestock'} title={newJobOperation === 'tubestock' ? 'Tube stock jobs are standalone-upload only - no manufacturing-request workflow maps to it yet' : ''} on:click={() => (newJobSource = 'part')}>Use existing part</button>
            </div>
          </fieldset>
        </div>

        {#if newJobSource === 'part'}
          <div class="form-group">
            <label class="form-label" for="job-batch-toggle">Parts</label>
            <div class="source-toggle" id="job-batch-toggle">
              <button class="btn btn-sm" class:btn-primary={!batchMode} class:btn-secondary={batchMode} on:click={() => { batchMode = false; selectedPartIds = []; }}>Single Part</button>
              <button class="btn btn-sm" class:btn-primary={batchMode} class:btn-secondary={!batchMode} on:click={() => { batchMode = true; selectedPartId = ''; }}>Batch (Multiple Parts)</button>
            </div>
            {#if batchMode}
              <p class="cam-form-hint">Queues one job per checked part, all sharing the material/tool/machine/settings below - run one at a time so generation doesn't pile up.</p>
            {/if}
          </div>
          <div class="part-picker-filters">
            <div class="filters">
              <div class="form-group">
                <label class="form-label" for="part-search">Search ({newJobOperation === 'turning' ? 'lathe' : 'router'} workflow)</label>
                <input id="part-search" class="form-input" placeholder="Part name..." bind:value={partSearchTerm} />
              </div>
              <div class="form-group">
                <label class="form-label" for="part-status">Status</label>
                <select id="part-status" class="form-select" bind:value={partFilterStatus}>
                  <option value="">All Statuses</option>
                  {#each PART_STATUSES as s}
                    <option value={s.value}>{s.label}</option>
                  {/each}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="part-project">Project</label>
                <select id="part-project" class="form-select" bind:value={partFilterProject}>
                  <option value="">All Projects</option>
                  {#each partProjectIds as pid}
                    <option value={pid}>{pid}</option>
                  {/each}
                </select>
              </div>
              <SeasonFilter options={partSeasonOptions} bind:value={partFilterSeason} />
            </div>
            <div class="team-filter-row">
              <TeamFilter bind:show971={partShow971} bind:show9584={partShow9584} />
            </div>
          </div>
          {#if batchMode && filteredEligibleParts.length > 0}
            <div class="batch-select-all">
              <button type="button" class="btn btn-ghost btn-sm" on:click={() => (selectedPartIds = filteredEligibleParts.map((p) => p.id))}>Select All ({filteredEligibleParts.length})</button>
              <button type="button" class="btn btn-ghost btn-sm" on:click={() => (selectedPartIds = [])} disabled={selectedPartIds.length === 0}>Clear</button>
              <span class="text-muted">{selectedPartIds.length} selected</span>
            </div>
          {/if}
          <div class="part-picker">
            {#if partsLoading}
              <p class="text-muted">Loading parts…</p>
            {:else if filteredEligibleParts.length === 0}
              <p class="text-muted">No {newJobOperation === 'turning' ? 'lathe' : 'router'} parts with a STEP file match these filters.</p>
            {:else}
              {#each filteredEligibleParts as p (p.id)}
                <label class="part-picker-row">
                  {#if batchMode}
                    <input type="checkbox" value={p.id} checked={selectedPartIds.includes(p.id)} on:change={(e) => {
                      selectedPartIds = e.target.checked ? [...selectedPartIds, p.id] : selectedPartIds.filter((id) => id !== p.id);
                    }} />
                  {:else}
                    <input type="radio" name="part-pick" value={p.id} bind:group={selectedPartId} />
                  {/if}
                  <span class="part-picker-name">{p.name}</span>
                  {#if p.project_id}<span class="part-picker-tag mono">{p.project_id}</span>{/if}
                  <span class="part-picker-tag">{PART_STATUSES.find((s) => s.value === p.status)?.label || p.status || 'Pending'}</span>
                </label>
              {/each}
            {/if}
          </div>
        {/if}

        {#if newJobSource === 'upload'}
          <div class="form-group">
            <label class="form-label" for="step-upload">STEP File</label>
            <input id="step-upload" class="form-input" type="file" accept=".step,.stp" on:change={(e) => (newJobFile = e.target.files?.[0] || null)} />
            <p class="cam-form-hint">
              {#if newJobOperation === 'turning'}
                Modeled with the spindle axis along the STEP file's Z axis, centered at X=0, Y=0 (lathe parts are
                physically solids of revolution, so the profile is read straight off the geometry).
              {:else if newJobOperation === 'tubestock'}
                Axis-aligned rectangular/square tube - the long axis is auto-detected (whichever bounding-box
                dimension is largest), and round holes through any of its 4 side walls are read straight off the
                model. Non-round features (slots, keyways) and already-bent/formed tube are rejected, not guessed at.
              {:else}
                Modeled as a flat profile extruded along the STEP file's Z axis - the flat top/bottom face becomes
                the outline, holes included, and material thickness is read straight off the model.
              {/if}
            </p>
          </div>
        {:else}
          <p class="cam-form-hint">Uses the STEP file already attached to this part - nothing else to upload.</p>
        {/if}

        {#if newJobOperation === 'turning'}
          <CamParamFields operation="turning" bind:params={turningParams} mode="job" />
          <TurningFinishTool {tools} bind:finishTool={turningParams.finishTool} />
          <TurningDrilling {tools} bind:drilling={turningParams.drilling} disabled={turningParams.setupMode === 'flip'} />
        {:else if newJobOperation === 'tubestock'}
          <CamParamFields operation="tubestock" bind:params={tubestockParams} mode="job" />
        {:else}
          <CamParamFields operation="routing" bind:params={routingParams} mode="job" />
          <RoutingToolSequence tools={selectedMachineTools} bind:sequence={routingParams.toolSequence} />
        {/if}

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="job-material">Material</label>
            <select id="job-material" class="form-select" bind:value={selectedMaterialId} on:change={() => { materialChosenByHand = true; applyMaterialDefaults(selectedMaterialId); }}>
              <option value="">Unspecified</option>
              <!-- Marked, not hidden. A material with no feeds for this
                   operation is still a legitimate pick for someone entering
                   numbers by hand; what is not legitimate is picking it
                   without knowing that nothing will be filled in. -->
              {#each materials.filter((m) => m.enabled) as m}
                <option value={m.id}>{m.name}{materialWithoutFeeds(m.id, newJobOperation) ? ' - no feeds on record' : ''}</option>
              {/each}
            </select>
            {#if newJobMaterialWithoutFeeds}
              <p class="cam-form-warning">
                <AlertTriangle size={14} />
                No verified feeds/speeds for {newJobMaterialWithoutFeeds.name} in {operationLabel(newJobOperation).toLowerCase()} - the generic defaults below were kept, and they are tuned for aluminum. Check feed rate, step-down and spindle speed before running this on material.
              </p>
            {:else}
              <p class="text-muted">Fills in conservative starting feeds/speeds for this material below - still yours to tune.</p>
            {/if}
          </div>
          <div class="form-group">
            <label class="form-label" for="job-machine">Machine Profile</label>
            <select id="job-machine" class="form-select" bind:value={selectedMachineId} on:change={() => applyMachineDefaults(selectedMachineId)}>
              <option value="">Unspecified</option>
              {#each newJobMachines as mc}
                <option value={mc.id}>{mc.name}</option>
              {/each}
            </select>
            <p class="cam-form-hint">Loads the machine defaults and its installed tools.</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="job-tool">Tool / End Mill</label>
            <div class="input-group tool-picker-row">
              <select id="job-tool" class="form-select" value={selectedToolId} on:change={(event) => selectNewJobTool(event.currentTarget.value)} disabled={!!selectedMachineId && selectedMachineTools.length === 0}>
                <option value="">Unspecified</option>
                {#each selectedMachineTools as t}
                  <option value={t.id}>{t.name}{t.diameter ? ` (${t.diameter}\" dia)` : ''}</option>
                {/each}
              </select>
              {#if selectedMachineId}
                <button type="button" class="btn btn-secondary btn-sm btn-nowrap" on:click={() => openToolsModal(selectedMachineId)} title="Create an end mill for this machine"><Plus size={15} /> Add tool</button>
              {/if}
            </div>
            {#if selectedMachineId && selectedMachineTools.length === 0}
              <p class="cam-form-hint">No tools are installed on this machine yet. Add the first one here.</p>
            {:else if selectedMachineId}
              <p class="cam-form-hint">Only tools installed on this machine are available.</p>
            {/if}
          </div>
        </div>

        <button
          class="btn btn-primary"
          on:click={submitNewJob}
          disabled={submitting || missingTubeStock || (newJobSource === 'part' && batchMode && selectedPartIds.length === 0)}
        >
          {#if batchProgress}
            Generating {batchProgress.index + 1}/{batchProgress.total}: {batchProgress.partName}…
          {:else if submitting}
            Queuing…
          {:else if newJobSource === 'part' && batchMode}
            Queue {selectedPartIds.length} Job{selectedPartIds.length === 1 ? '' : 's'}
          {:else}
            Generate G-code
          {/if}
        </button>
        <p class="cam-form-hint">
          {#if missingTubeStock}
            Pick the tube stock above - it sets the hole depth.
          {:else if newJobSource === 'part' && batchMode}
            Runs one part at a time - stays open until the whole batch finishes.
          {:else}
            Closes automatically once queued - track progress in the jobs list below.
          {/if}
        </p>
      </div>
    </div>
  </div>
{/if}

{#if showJobDetailModal && editingJob}
  <div class="modal-backdrop" on:click|self={closeJobDetailModal} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') closeJobDetailModal(); }}>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>Edit Job</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={closeJobDetailModal}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label" for="edit-job-name">Job Name</label>
          <div class="input-group">
            <input id="edit-job-name" class="form-input" placeholder="e.g. Gearbox side plate" bind:value={editJobName} />
            <button class="btn btn-secondary btn-sm btn-nowrap" on:click={saveJobName} disabled={editRenaming || editJobName.trim() === (editingJob.name || '')}>
              {editRenaming ? 'Saving…' : 'Save Name'}
            </button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="edit-job-notes">Notes</label>
          <div class="input-group">
            <textarea id="edit-job-notes" class="form-input" rows="2" placeholder="e.g. verify stock height before running, customer wants 2 of these" bind:value={editJobNotes}></textarea>
            <button class="btn btn-secondary btn-sm btn-nowrap" on:click={saveJobNotes} disabled={editSavingNotes || editJobNotes.trim() === (editingJob.notes || '')}>
              {editSavingNotes ? 'Saving…' : 'Save Notes'}
            </button>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <span class="form-label">Operation</span>
            <p class="cam-form-hint">{editingJob.operation_type} (fixed - create a new job to change this)</p>
          </div>
          <div class="form-group">
            <span class="form-label">Status</span>
            <p class="cam-form-hint"><span class="status-badge {jobStatusClass(editingJob)}">{camJobStatusLabel(editingJob.status)}</span></p>
          </div>
        </div>

        <div class="view-buttons-row">
          <button class="btn btn-secondary btn-sm" on:click={() => (showJobCadModal = true)} disabled={!editingJob.step_file_name}>
            <Box size={14} /> View CAD
          </button>
          <button class="btn btn-secondary btn-sm" on:click={() => openToolpathPreview(editingJob, editParams)} disabled={editingJob.status !== 'completed' || !editingJob.gcode} title={editingJob.status !== 'completed' ? 'Only available once the job has completed' : ''}>
            <Route size={14} /> Show Toolpath
          </button>
          {#if editingJob.status === 'completed' && editingJob.gcode}
            <button class="btn btn-secondary btn-sm" on:click={() => openNcviewer(editingJob)}>
              <ExternalLink size={14} /> Open ncviewer.com
            </button>
          {/if}
          {#if editingJob.operation_type === 'tubestock' && editingJob.stats?.facePrograms?.length}
            {#each editingJob.stats.facePrograms as faceProgram}
              <button class="btn btn-secondary btn-sm" title={tubeFaceFileName(editingJob, faceProgram)} on:click={() => downloadTubeFaceProgram(editingJob, faceProgram)}>
                <Download size={14} /> Download {tubeFaceLabel(faceProgram)}
              </button>
            {/each}
          {/if}
        </div>

        {#if editingJob.operation_type === 'turning'}
          <CamParamFields operation="turning" bind:params={editParams} mode="job" />
          <TurningFinishTool {tools} bind:finishTool={editParams.finishTool} />
          <TurningDrilling {tools} bind:drilling={editParams.drilling} disabled={editParams.setupMode === 'flip'} />
        {:else if editingJob.operation_type === 'tubestock'}
          <CamParamFields operation="tubestock" bind:params={editParams} mode="job" />
        {:else}
          <CamParamFields operation="routing" bind:params={editParams} mode="job" />
          <RoutingToolSequence tools={editMachineTools} bind:sequence={editParams.toolSequence} />
        {/if}

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="edit-job-material">Material</label>
            <select id="edit-job-material" class="form-select" bind:value={editMaterialId} on:change={() => applyMaterialDefaultsToEdit(editMaterialId)}>
              <option value="">Unspecified</option>
              {#each materials.filter((m) => m.enabled) as m}
                <option value={m.id}>{m.name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="edit-job-machine">Machine Profile</label>
            <select id="edit-job-machine" class="form-select" value={editMachineId} on:change={(event) => selectEditMachine(event.currentTarget.value)}>
              <option value="">Unspecified</option>
              {#each machinesForOperation(machines, editingJob.operation_type) as mc}
                <option value={mc.id}>{mc.name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="edit-job-tool">Tool / End Mill</label>
            <select id="edit-job-tool" class="form-select" value={editToolId} on:change={(event) => selectEditJobTool(event.currentTarget.value)} disabled={!!editMachineId && editMachineTools.length === 0}>
              <option value="">Unspecified</option>
              {#each editMachineTools as t}
                <option value={t.id}>{t.name}{t.diameter ? ` (${t.diameter}\" dia)` : ''}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="modal-footer-actions">
          <button class="btn btn-danger" on:click={deleteEditingJob} disabled={editDeleting}>
            {editDeleting ? 'Deleting…' : 'Delete Job'}
          </button>
          <button class="btn btn-primary" on:click={saveJobAndRegenerate} disabled={editSubmitting || !editingJob.step_file_name} title={!editingJob.step_file_name ? 'No stored STEP file to regenerate from' : ''}>
            {editSubmitting ? 'Queuing…' : 'Save & Regenerate'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if showJobCadModal && editingJob}
  <div class="modal-backdrop" on:click|self={() => (showJobCadModal = false)} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') (showJobCadModal = false); }}>
    <div class="modal cad-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>CAD Preview - {jobDisplayName(editingJob)}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={() => (showJobCadModal = false)}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <CadViewer part={null} stepFileName={editingJob.step_file_name} />
        <p class="cam-form-hint">Drag to rotate · scroll to zoom · right-drag to pan</p>
      </div>
    </div>
  </div>
{/if}

{#if showJobToolpathModal && editingJob}
  <div class="modal-backdrop" on:click|self={() => (showJobToolpathModal = false)} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') (showJobToolpathModal = false); }}>
    <div class="modal toolpath-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>{operationLabel(editingJob.operation_type)} Toolpath - {jobDisplayName(editingJob)}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={() => (showJobToolpathModal = false)}><X size={18} /></button>
      </div>
      <div class="modal-body">
        {#if editingJob.operation_type === 'routing' || editingJob.operation_type === 'turning'}
          <div class="toolpath-view-tabs" role="tablist" aria-label="Toolpath view">
            <!-- 3D first: it's the default view and the one people actually
                 read a toolpath in, so it leads the tab strip here the same
                 way it already does on the manufacture page's own dialog. -->
            <button type="button" role="tab" aria-selected={toolpathView === '3d'} class:active={toolpathView === '3d'} on:click={() => open3DToolpathPreview(editingJob, toolpathPreviewParams || editingJob.params)}>3D Toolpath</button>
            <button type="button" role="tab" aria-selected={toolpathView === '2d'} class:active={toolpathView === '2d'} on:click={() => (toolpathView = '2d')}>2D Preview</button>
          </div>
        {/if}
        {#if toolpathView === '3d' && (editingJob.operation_type === 'routing' || editingJob.operation_type === 'turning' || editingJob.operation_type === 'tubestock')}
          {#if ToolpathSimulator}
            <svelte:component
              this={ToolpathSimulator}
              gcode={editingJob.gcode}
              operationType={editingJob.operation_type}
              toolDiameter={Number((toolpathPreviewParams || editingJob.params)?.toolDiameter) || null}
              rapidRate={editingJob.cam_machines?.rapid_rate ?? null}
              toolSequence={(toolpathPreviewParams || editingJob.params)?.toolSequence || []}
              stockDiameter={Number((toolpathPreviewParams || editingJob.params)?.stockDiameter) || null}
              stockShape={(toolpathPreviewParams || editingJob.params)?.stockShape || 'round'}
              noseRadius={Number((toolpathPreviewParams || editingJob.params)?.finishTool?.noseRadius ?? (toolpathPreviewParams || editingJob.params)?.noseRadius) || null}
              drillDiameter={Number((toolpathPreviewParams || editingJob.params)?.drilling?.diameter) || null}
              stepFileName={editingJob.step_file_name || null}
              edgeShiftX={Number(editingJob.stats?.edgeShiftX) || 0}
              edgeShiftY={Number(editingJob.stats?.edgeShiftY) || 0}
              crossSection={editingJob.stats?.crossSection || null}
              walls={editingJob.stats?.walls || []}
            />
          {:else}
            <div class="toolpath-simulator-loading" aria-busy="true"><span class="loading-spinner"></span> Loading 3D toolpath...</div>
          {/if}
        {:else}
          <ToolpathViewer gcode={editingJob.gcode} operationType={editingJob.operation_type} />
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showNcviewerModal && editingJob}
  <div class="modal-backdrop" on:click|self={() => (showNcviewerModal = false)} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') (showNcviewerModal = false); }}>
    <div class="modal ncviewer-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>ncviewer.com - {jobDisplayName(editingJob)}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={() => (showNcviewerModal = false)}><X size={18} /></button>
      </div>
      <div class="modal-body ncviewer-modal-body">
        {#if ncviewerCopyOk === true}
          <div class="ncviewer-banner ncviewer-banner-success">
            <Copy size={20} />
            <div>
              <strong>G-code copied to your clipboard.</strong>
              <p>Click into the editor pane below, then paste (Cmd/Ctrl+V) to load it.</p>
            </div>
            <a class="btn btn-secondary btn-sm ncviewer-fallback-link" href="https://ncviewer.com" target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} /> Open in a new tab instead
            </a>
          </div>
        {:else if ncviewerCopyOk === false}
          <div class="ncviewer-banner ncviewer-banner-warning">
            <AlertTriangle size={20} />
            <div>
              <strong>Couldn't auto-copy the G-code.</strong>
              <p>Your browser may be blocking clipboard access - click "Copy G-code" below, then paste it into the editor pane.</p>
            </div>
            <button class="btn btn-secondary btn-sm" on:click={recopyNcviewerGcode}><Copy size={14} /> Copy G-code</button>
            <a class="btn btn-secondary btn-sm ncviewer-fallback-link" href="https://ncviewer.com" target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} /> Open in a new tab instead
            </a>
          </div>
        {/if}
        <p class="cam-form-hint">
          If the embedded view below doesn't load, ncviewer.com's own server is blocking embedding (not something this app controls) - use "Open in a new tab" above, the clipboard copy still works the same way.
        </p>
        <iframe
          src="https://ncviewer.com"
          title="ncviewer.com G-code viewer"
          class="ncviewer-iframe"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        ></iframe>
      </div>
    </div>
  </div>
{/if}

{#if showMachineModal}
  <div class="modal-backdrop" on:click|self={closeMachineModal} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') closeMachineModal(); }}>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>{editingMachineId ? 'Edit' : 'New'} Machine Profile</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={closeMachineModal}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="mp-name">Name</label>
            <input id="mp-name" class="form-input" placeholder="e.g. 971 Lathe" bind:value={machineForm.name} />
          </div>
          <div class="form-group">
            <label class="form-label" for="mp-desc">Description</label>
            <input id="mp-desc" class="form-input" placeholder="e.g. Haas TL-1" bind:value={machineForm.description} />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="mp-operation">Operation Type</label>
          <div class="source-toggle" id="mp-operation">
            <button class="btn btn-sm" class:btn-primary={machineForm.operation_type === 'turning'} class:btn-secondary={machineForm.operation_type !== 'turning'} on:click={() => setMachineFormOperation('turning')}>Turning (Lathe)</button>
            <button class="btn btn-sm" class:btn-primary={machineForm.operation_type === 'routing'} class:btn-secondary={machineForm.operation_type !== 'routing'} on:click={() => setMachineFormOperation('routing')}>Routering (Router)</button>
            <button class="btn btn-sm" class:btn-primary={machineForm.operation_type === 'tubestock'} class:btn-secondary={machineForm.operation_type !== 'tubestock'} on:click={() => setMachineFormOperation('tubestock')}>Tube Stock (Router)</button>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="mp-material">Default Material</label>
            <select id="mp-material" class="form-select" bind:value={machineForm.default_material_id}>
              <option value="">None</option>
              {#each materials as m}
                <option value={m.id}>{m.name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="mp-tool">Default Tool</label>
            <select id="mp-tool" class="form-select" bind:value={machineForm.default_tool_id}>
              <option value="">None</option>
              {#each tools as t}
                <option value={t.id}>{t.name}</option>
              {/each}
            </select>
          </div>
          {#if machineForm.operation_type === 'routing' || machineForm.operation_type === 'tubestock'}
            <div class="form-group">
              <label class="form-label" for="mp-gcode-ext">Output File Type</label>
              <select id="mp-gcode-ext" class="form-select" bind:value={machineForm.gcode_extension}>
                <option value="ngc">.ngc (default)</option>
                <option value="tap">.tap (Mach3/Mach4)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="mp-controller">Controller</label>
              <select id="mp-controller" class="form-select" bind:value={machineForm.controller}>
                <option value="linuxcnc">LinuxCNC</option>
                <option value="wincnc">WinCNC (ShopSabre)</option>
              </select>
              <p class="cam-form-hint">WinCNC uses a genuinely different G-code dialect (comments, units, tool-change pause) - see routing.js. Pick wrong and the file may not run on the real machine.</p>
            </div>
          {/if}
          <div class="form-group">
            <label class="form-label" for="mp-rapid-rate">Rapid traverse (in/min) <span class="text-muted">(optional)</span></label>
            <input id="mp-rapid-rate" class="form-input" type="number" min="1" step="10" bind:value={machineForm.rapid_rate} placeholder="Not measured" />
            <p class="cam-form-hint">Used only to time G00 moves in the run-time estimate, never to generate G-code. Left blank, the estimate falls back to a conservative 200 in/min and says so on hover.</p>
          </div>
        </div>

        <fieldset class="form-group machine-tools-fieldset">
          <legend class="form-label">Installed Tools</legend>
          <div class="machine-tool-options">
            {#each tools.filter((tool) => tool.enabled) as tool}
              <label class="machine-tool-option">
                <input type="checkbox" bind:group={machineForm.tool_ids} value={tool.id} />
                <span>{tool.name}{tool.diameter ? ` (${tool.diameter}\" dia)` : ''}</span>
              </label>
            {/each}
          </div>
          <p class="cam-form-hint">Only these tools appear after this machine is selected for an AutoCAM job. The default tool is always included when saved.</p>
        </fieldset>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="mp-drive-folder">Drive Auto-Trigger Folder ID (input) <span class="text-muted">(optional)</span></label>
            <input id="mp-drive-folder" class="form-input" placeholder="e.g. 1a2B3cD4eFGhijKLmnoPQRstuVWxyz" bind:value={machineForm.drive_folder_id} />
            <p class="cam-form-hint">
              A STEP file dropped here auto-queues a job on this machine, using the defaults above.
              {#if machineForm.operation_type === 'turning'}Turning jobs land as a draft (stock diameter needs a human).{/if}
            </p>
          </div>
          <div class="form-group">
            <label class="form-label" for="mp-drive-output-folder">Drive Delivery Folder ID (output) <span class="text-muted">(optional)</span></label>
            <input id="mp-drive-output-folder" class="form-input" placeholder="e.g. 9zY8xW7vUtSrqPonMLkjihGF" bind:value={machineForm.drive_output_folder_id} />
            <p class="cam-form-hint">
              Any completed job's G-code on this machine gets written here - pair with a Drive desktop sync client on the machine's control PC for zero-download delivery. Deliberately a separate folder from the one above. See autocam/docs/direct-machine-file-transfer-plan.md.
            </p>
          </div>
        </div>
        <p class="cam-form-hint">Both require GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY configured server-side and the folder shared with that service account - not yet set up for this shop.</p>

        <CamParamFields operation={machineForm.operation_type} bind:params={machineForm.params} mode="profile" />
        {#if machineForm.operation_type === 'routing'}
          <RoutingToolSequence {tools} bind:sequence={machineForm.params.toolSequence} />
        {:else if machineForm.operation_type === 'turning'}
          <TurningFinishTool {tools} bind:finishTool={machineForm.params.finishTool} />
        {/if}

        <button class="btn btn-primary" on:click={saveMachine} disabled={savingMachine}>
          {savingMachine ? 'Saving…' : 'Save Machine Profile'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-subtitle {
    color: var(--text-muted);
    margin: -0.5rem 0 1rem;
    font-size: var(--font-sm, 0.9rem);
  }

  .setup-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    background: var(--yellow-soft, #fef9c3);
    color: var(--yellow-strong, #854d0e);
    border: 1px solid var(--yellow-base, #ca8a04);
  }
  .setup-warning p { margin: 0.35rem 0 0; font-size: var(--font-sm, 0.9rem); }
  .setup-warning code {
    background: rgba(0, 0, 0, 0.08);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-size: 0.85em;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--gap-3, 0.75rem);
    margin-bottom: 1rem;
  }
  .stat-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: var(--surface-1, var(--primary));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 8px);
    padding: 1rem;
  }
  .stat-info h3 { margin: 0; font-size: 1.4rem; line-height: 1.1; }
  .stat-info p { margin: 0.15rem 0 0; font-size: var(--font-xs, 0.75rem); color: var(--text-muted); }

  .machine-profiles-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem;
    margin-top: 0.75rem;
  }
  .machine-profile-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .machine-profile-card.disabled { opacity: 0.5; }
  .machine-profile-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
  .machine-profile-header > div { display: flex; flex-direction: column; gap: 0.3rem; align-items: flex-start; }
  .machine-profile-desc { margin: 0; font-size: var(--font-xs, 0.75rem); color: var(--text-muted); }
  .machine-profile-meta { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .machine-profile-actions { display: flex; gap: 0.5rem; margin-top: auto; }
  .machine-profile-actions .btn { flex: 1; justify-content: center; }
  .machine-profile-add {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-height: 100px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm, 4px);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: var(--font-sm, 0.9rem);
  }
  .machine-profile-add:hover { border-color: var(--accent); color: var(--accent); }

  .profiles-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1.5rem;
  }

  .profile-col h3 { margin: 0 0 0.5rem; font-size: 1rem; }

  .profile-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--border);
  }

  .profile-row.disabled { opacity: 0.5; }

  .input-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .input-group .form-input {
    min-width: 90px;
    flex: 1 1 90px;
  }

  .tools-modal { width: min(800px, 95vw); max-width: 95vw; }
  .tool-picker-row { margin-top: 0; }
  .tool-picker-row .form-select { flex: 1 1 180px; min-width: 0; }
  .machine-tools-fieldset {
    min-width: 0;
    margin: 0 0 1rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
  }
  .machine-tools-fieldset .form-label { padding: 0 0.3rem; }
  .machine-tool-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
    gap: 0.45rem;
  }
  .machine-tool-option {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    background: var(--surface-1, var(--primary));
    font-size: var(--font-sm, 0.9rem);
  }
  .machine-tool-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .name-line {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    /* No max-width: the Job column already has a share of a proportional
       table, so capping the line here only clipped it earlier than the
       column required. min-width: 0 so the name wraps INSIDE the column
       rather than forcing the column (and the page) wider - a flex item
       will not shrink below its min-content width without it. */
    min-width: 0;
  }
  .name-line strong {
    /* Wrap rather than ellipsise. The part of these names that tells them
       apart is at the END - P006950_Rev_x60 vs P006951_Rev_x44 differ in
       exactly the characters an ellipsis eats - so truncating can render
       two different jobs as visually identical rows. overflow-wrap:
       anywhere because they are one long token with no spaces to break at,
       matching how the manufacture table handles the same strings. */
    white-space: normal;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .job-part-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.15rem;
    font-size: var(--font-xs, 0.75rem);
    color: var(--accent-strong, #1d4ed8);
    text-decoration: none;
  }
  .job-part-link:hover { text-decoration: underline; }

  .status-badge.status-running { background: var(--purple-soft); color: var(--purple-strong); border-color: var(--purple-soft); }
  /* No local override - the shared status palette in app.css already
     renders Completed, and a solid --green-soft here sat visibly brighter
     than the tinted chips beside it. */
  .status-badge.status-error { background: var(--red-soft); color: var(--red-strong); border-color: var(--red-soft); }

  .job-error {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--red-strong);
    font-size: var(--font-xs, 0.75rem);
  }

  .job-row {
    cursor: pointer;
  }
  .job-row:hover {
    background: var(--surface-2, var(--background));
  }
  .job-row:focus-visible {
    outline: 2px solid var(--accent-strong, #1d4ed8);
    outline-offset: -2px;
  }

  .view-buttons-row {
    display: flex;
    gap: 0.5rem;
    margin: -0.5rem 0 1rem;
  }

  .more-filters-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    padding: 0.4rem 0;
    margin-top: 0.25rem;
    color: var(--accent-strong, #1d4ed8);
    font-size: var(--font-sm, 0.9rem);
    cursor: pointer;
  }
  .more-filters-toggle:hover { text-decoration: underline; }
  .more-filters-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-strong, #1d4ed8);
    display: inline-block;
  }

  .cad-modal { width: min(900px, 95vw); max-width: 95vw; }
  .toolpath-modal {
    width: min(1500px, 98vw);
    max-width: 98vw;
    height: min(94vh, 1100px);
    max-height: 94vh;
    overflow: hidden;
  }
  .toolpath-modal .modal-body { min-height: 0; overflow: auto; }
  .toolpath-simulator-loading { min-height: 320px; display: flex; align-items: center; justify-content: center; gap: 0.65rem; color: var(--text-muted); }
  .toolpath-simulator-loading .loading-spinner { width: 1.25rem; height: 1.25rem; border-width: 2px; }
  .toolpath-view-tabs { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border); }
  .toolpath-view-tabs button { padding: 0.5rem 0.75rem; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-muted); font: inherit; cursor: pointer; }
  .toolpath-view-tabs button.active { border-bottom-color: var(--accent-strong); color: var(--text); font-weight: 700; }
  .ncviewer-modal { width: min(1500px, 98vw); max-width: 98vw; height: min(94vh, 1100px); }
  .ncviewer-modal-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .ncviewer-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.65rem 0.85rem;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid;
  }
  .ncviewer-banner strong { font-size: 1.05rem; }
  .ncviewer-banner p { margin: 0.25rem 0 0; font-size: var(--font-sm, 0.9rem); }
  .ncviewer-banner-success {
    background: var(--green-soft, #dcfce7);
    color: var(--green-strong, #15803d);
    border-color: var(--green-base, #22c55e);
  }
  .ncviewer-banner-warning {
    background: var(--yellow-soft, #fef9c3);
    color: var(--yellow-strong, #854d0e);
    border-color: var(--yellow-base, #ca8a04);
  }
  .ncviewer-fallback-link { margin-left: auto; flex-shrink: 0; }
  .ncviewer-iframe {
    flex: 1;
    min-height: 500px;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    margin-top: 0.75rem;
  }

  .modal-footer-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border, #e5e5e5);
  }

  .job-output-failed {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.4rem;
  }

  .cam-form-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    line-height: 1.35;
    color: var(--status-risk-text, #92400e);
  }

  .autocam-jobs-container {
    overflow: visible;
  }
  .autocam-jobs-table {
    table-layout: fixed;
  }
  /* Output was 34% - far wider than its own button row needs, which left a
     big empty gap on the right while every content column was squeezed
     hard enough to wrap. Rebalanced so Tool ("UNC Router 0.1575 in Flat
     End Mill") and Created ("Aug 31, 2026, 11:36 PM PT") lay out across
     the row instead of stacking into a tall vertical column.
     Operation, Machine Type and Status hold fixed-height pills that cannot
     wrap, so their columns have to fit the widest label outright. They did
     not: at 1600px "TUBE STOCK" overflowed its 7% column by 12px and
     "AUTOCAM FAILED" its 8% column by 20px, and because the container is
     deliberately overflow: visible the overflow was drawn on top of the
     next column instead of being clipped. Measured at every width from
     1600px down, not eyeballed. */
  .autocam-jobs-table th:nth-child(1) { width: 12%; }
  .autocam-jobs-table th:nth-child(2) { width: 10%; }
  .autocam-jobs-table th:nth-child(3) { width: 6%; }
  .autocam-jobs-table th:nth-child(4) { width: 10%; }
  .autocam-jobs-table th:nth-child(5) { width: 6%; }
  .autocam-jobs-table th:nth-child(6) { width: 8%; }
  .autocam-jobs-table th:nth-child(7) { width: 12%; }
  .autocam-jobs-table th:nth-child(8) { width: 13%; }
  .autocam-jobs-table th:nth-child(9) { width: 7%; }
  .autocam-jobs-table th:nth-child(10) { width: 16%; }
  .autocam-jobs-table td {
    vertical-align: top;
  }
  /* Only the job-name column holds long unbroken tokens
     ("P006946_Rev_SLAPDIH") that genuinely have to break mid-word.
     Applying overflow-wrap: anywhere to every cell broke short,
     known-vocabulary labels too - "ROUTERING" came out as "ROUTER / ING"
     and "TURNING" as "TURNIN / G". */
  .autocam-jobs-table td:first-child {
    overflow-wrap: anywhere;
  }
  /* Tags are fixed-height pills (--control-height): a wrapped second line
     just gets clipped against that height. Same reasoning as
     .status-badge's own white-space: nowrap in app.css. */
  .autocam-jobs-table .tag {
    white-space: nowrap;
  }
  .job-created-date {
    display: inline-block;
    white-space: nowrap;
  }
  .output-cell { min-width: 0; white-space: normal; }
  .output-actions {
    display: flex;
    /* Wraps onto a second line rather than forcing the cell wider than its
       column. The container above is deliberately overflow: visible (so the
       Face-files dropdown isn't clipped), which meant a nowrap row here
       pushed the whole PAGE into a horizontal scroll on anything narrower
       than a very wide monitor - the table scrolling would have been bad
       enough; the page scrolling took the nav with it. */
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    row-gap: 0.35rem;
    white-space: nowrap;
  }
  .output-action-group {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    min-width: 0;
    gap: 0.4rem;
  }
  .tube-face-files { position: relative; }
  .tube-face-files summary { list-style: none; }
  .tube-face-files summary::-webkit-details-marker { display: none; }
  .tube-face-files-list {
    position: absolute;
    top: calc(100% + 0.35rem);
    right: 0;
    z-index: 25;
    display: grid;
    gap: 0.3rem;
    min-width: max-content;
    padding: 0.4rem;
    background: var(--surface-1, #fff);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    box-shadow: var(--shadow-md);
  }

  /* Small hover tooltip for icon-only buttons - the native title attribute
     has an inconsistent, sluggish browser delay, easy to miss on a row of
     plain icons with no visible label at all.
     Anchored to the button's RIGHT edge (not centered) and growing leftward:
     every one of these buttons lives in the Output column at the right edge
     of a wide table, so a centered tooltip on the rightmost button(s) would
     overflow past the edge of the screen. Right-anchoring means the tooltip
     only ever grows toward the center of the table, where there's always
     room, regardless of which button in the row it's on. */
  [data-tooltip] {
    position: relative;
  }
  [data-tooltip]:hover::after,
  [data-tooltip]:focus-visible::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    left: auto;
    max-width: min(240px, 90vw);
    background: var(--text, #1a1a1a);
    color: var(--background, #fff);
    padding: 0.25rem 0.55rem;
    border-radius: var(--radius-sm, 4px);
    font-size: var(--font-xs, 0.75rem);
    white-space: nowrap;
    pointer-events: none;
    z-index: 20;
  }
  /* Small arrow pointing from the tooltip down to the button - offset to
     sit near the button (the tooltip's right edge), not centered on the
     now off-center tooltip bubble. */
  [data-tooltip]:hover::before,
  [data-tooltip]:focus-visible::before {
    content: '';
    position: absolute;
    bottom: calc(100% + 1px);
    right: 6px;
    left: auto;
    border: 5px solid transparent;
    border-top-color: var(--text, #1a1a1a);
    z-index: 20;
  }

  .job-row-progress {
    margin-top: 0.3rem;
    min-width: 120px;
  }
  .job-row-progress-bar {
    height: 4px;
    border-radius: 2px;
    background: var(--surface-2, var(--background));
    overflow: hidden;
  }
  .job-row-progress-fill {
    height: 100%;
    background: var(--purple-strong, #7c3aed);
    transition: width 0.3s ease;
  }
  .job-row-progress-label {
    display: block;
    margin-top: 0.2rem;
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-muted);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 3rem 1rem;
    color: var(--text-muted);
    text-align: center;
  }
  .empty-state h3 { margin: 0; color: var(--text); }
  .empty-state p { margin: 0; }

  .source-toggle {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .job-choice-groups { display: grid; gap: var(--space-4, 1rem); }
  .job-choice-group { min-width: 0; margin: 0; padding: 0; border: 0; }
  .job-choice-group legend { margin-bottom: var(--space-2, 0.5rem); }
  .job-choice-options { display: grid; gap: var(--space-2, 0.5rem); }
  .job-choice-options--operation { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .job-choice-options--source { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .job-choice-options .btn { width: 100%; min-width: 0; min-height: 2.6rem; white-space: normal; }

  .cam-form-hint {
    font-size: var(--font-xs, 0.75rem);
    color: var(--text-muted);
    margin: 0.35rem 0 0;
  }

  .part-picker-filters {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .part-picker {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 0.25rem 0.5rem;
    margin-bottom: 1rem;
  }
  .autocam-page-header .page-actions {
    align-items: center;
    justify-content: flex-end;
  }
  .group-picker {
    max-height: 260px;
    margin: 0;
    padding: 0.2rem 0.65rem;
    background: var(--surface-2, #fafafa);
  }
  .grouped-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.35rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--green-strong, #15803d);
    font: inherit;
    font-size: var(--font-xs, 0.75rem);
    cursor: pointer;
  }
  .groups-modal { width: min(720px, calc(100vw - 2rem)); }
  .group-modal { width: min(820px, calc(100vw - 2rem)); }
  .group-modal-body { display: grid; gap: var(--space-4, 1rem); }
  .group-intro {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.65rem;
    padding: 0.75rem;
    border-left: 3px solid var(--green-base, #22c55e);
    background: var(--green-soft, #dcfce7);
    color: var(--green-strong, #15803d);
  }
  .group-intro > div { display: grid; gap: 0.15rem; }
  .group-intro span:not(.tag) { font-size: var(--font-sm, 0.875rem); color: var(--text-muted); }
  .group-setup-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) repeat(4, minmax(108px, 0.7fr));
    gap: var(--space-3, 0.75rem);
    align-items: end;
  }
  .group-setup-grid .form-group { margin: 0; min-width: 0; }
  .group-selection-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; margin-bottom: -0.45rem; }
  .group-selection-heading span { color: var(--text-muted); font-size: var(--font-sm, 0.875rem); }
  .group-picker .part-picker-row { min-height: 3.25rem; padding: 0.4rem 0.2rem; }
  .group-picker .part-picker-name { display: grid; gap: 0.1rem; white-space: normal; }
  .group-picker .part-picker-name small, .group-job-setup small { color: var(--text-muted); font-size: var(--font-xs, 0.75rem); }
  .group-job-setup { display: grid; justify-items: end; gap: 0.1rem; text-align: right; font-size: var(--font-sm, 0.875rem); color: var(--text); }
  .group-clearance-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.1rem 1rem;
    align-items: baseline;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    background: var(--surface-2, #fafafa);
  }
  .group-clearance-summary span, .group-clearance-summary small { color: var(--text-muted); font-size: var(--font-sm, 0.875rem); }
  .group-clearance-summary small { grid-column: 1 / -1; font-size: var(--font-xs, 0.75rem); }
  .group-clearance-summary strong { color: var(--green-strong, #15803d); font-variant-numeric: tabular-nums; }
  .group-modal-footer { gap: 1rem; }
  .groups-modal .modal-body { display: grid; gap: 1rem; }
  .group-summary { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0; color: var(--text-muted); }
  .group-summary > span:not(.tag) { padding-left: 0.5rem; border-left: 1px solid var(--border); font-size: var(--font-sm, 0.875rem); }
  .group-item-list { display: grid; gap: 0.5rem; }
  .group-item-list > div, .group-list-row { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 0.65rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius-sm, 4px); }
  .group-item-list > div span { color: var(--text-muted); font-size: var(--font-sm, 0.875rem); }
  .group-list-row { width: 100%; background: var(--surface-1, #fff); text-align: left; cursor: pointer; font: inherit; }
  .group-list-row:hover, .group-list-row:focus-visible { border-color: var(--green-base, #22c55e); outline: none; }
  .group-list-row small { display: block; margin-top: 0.15rem; color: var(--text-muted); }

  .part-picker-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.15rem;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }

  .part-picker-row:last-child { border-bottom: none; }

  /* Global .modal input styling (width:100%, fixed height/border/background)
     otherwise stretches these bare radio/checkbox inputs into full-width
     boxes and wrecks the row layout - reset back to a normal small control. */
  .part-picker-row input[type='radio'],
  .part-picker-row input[type='checkbox'] {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    min-width: 16px;
    padding: 0;
    margin: 0;
    border: none;
    background: none;
  }

  .batch-select-all {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .part-picker-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .part-picker-tag {
    flex: 0 0 auto;
    white-space: nowrap;
    font-size: var(--font-xs, 0.75rem);
    color: var(--text-muted);
  }

  .team-filter-row {
    margin-top: var(--space-3, 0.75rem);
    padding-top: var(--space-3, 0.75rem);
    border-top: 1px solid var(--border);
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .form-row.two-col {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  @media (max-width: 900px) {
    .group-setup-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 600px) {
    .group-modal, .groups-modal { width: min(100vw - 1rem, 720px); }
    .group-intro { grid-template-columns: auto minmax(0, 1fr); }
    .group-intro .tag { grid-column: 2; justify-self: start; }
    .group-setup-grid { grid-template-columns: 1fr; }
    .group-picker .part-picker-row { align-items: flex-start; }
    .group-job-setup { display: none; }
    .group-modal-footer { align-items: stretch; flex-direction: column; }
    .group-modal-footer .btn { width: 100%; justify-content: center; }
  }
  /* Raised from 1260px: the pill columns above stop fitting before that,
     so the card layout has to take over while they still fit. */
  @media (max-width: 1400px) {
    .autocam-jobs-container {
      overflow: visible;
      border: none;
      border-radius: 0;
      box-shadow: none;
      background: transparent;
    }
    .autocam-jobs-table,
    .autocam-jobs-table tbody,
    .autocam-jobs-table tr,
    .autocam-jobs-table td {
      display: block;
      width: 100%;
    }
    .autocam-jobs-table thead { display: none; }
    .autocam-jobs-table tbody {
      display: grid;
      gap: 0.75rem;
    }
    .autocam-jobs-table tr {
      padding: 0.85rem 1rem;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 8px);
      background: var(--surface-1);
      box-shadow: var(--shadow-sm);
    }
    .autocam-jobs-table td {
      display: grid;
      grid-template-columns: minmax(8.5rem, 0.8fr) minmax(0, 1.5fr);
      gap: 0.75rem;
      padding: 0.45rem 0;
      border: 0;
      min-width: 0;
    }
    .autocam-jobs-table td + td { border-top: 1px solid var(--border); }
    .autocam-jobs-table td::before {
      content: attr(data-label);
      color: var(--text-muted);
      font-family: var(--font-mono-stack);
      font-size: 0.66rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .autocam-jobs-table .name-line { max-width: none; }
    .autocam-jobs-table .output-actions { justify-content: flex-start; }
  }
  @media (max-width: 560px) {
    .autocam-jobs-table tr { padding: 0.75rem; }
    .autocam-jobs-table td {
      grid-template-columns: 1fr;
      gap: 0.3rem;
    }
    .autocam-jobs-table td::before { font-size: 0.62rem; }
  }
  @media (max-width: 560px) {
    .job-choice-options--operation,
    .job-choice-options--source { grid-template-columns: 1fr; }
  }
</style>
