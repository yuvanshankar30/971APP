<script>
  import { browser } from '$app/environment';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount, tick } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { page } from '$app/stores';
  import { userStore, loadUserFromUUID, upsertProfileIfMissing, setUserUUID } from '$lib/stores/user.js';
  import { isTeam9584, passesTeamFilter } from '$lib/frcTeams.js';
  import TeamFilter from '$lib/components/TeamFilter.svelte';
  import { getSeasonBucket, getCurrentSeasonBucket, getAllSeasonBuckets, passesSeasonFilter } from '$lib/frcSeason.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';
  import { goto } from '$app/navigation';
  import { PUBLIC_ONSHAPE_BASE_URL } from '$env/static/public';
  import { Search, Filter, Clock, Truck, Package, Download, Zap, Wrench, FileText, Upload, ExternalLink, Pencil, Trash2, X, Users, Box, Route, CircleCheck, Layers } from 'lucide-svelte';
  import ROUTER_FLOW from '$lib/router_flow.json';
  import { getDisplayStatus, BUTTONS, getBadgeClass, getWorkflowStatuses } from '$lib/statuses.js';
  import { summarizeRouterStages, isFullyKitted, buildRouterProgressUpdate, canAdvanceRouterToCamReview } from '$lib/router_progress.js';
  import { isManufacturingLead, canCamReview as camReviewAllowed, canDeleteParts } from '$lib/permissions.js';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import stockData from '$lib/stock.json';
  import { formatPacificDate, formatPacificDateTimeWithZone } from '$lib/timezone.js';
  import PartDueDate from '$lib/components/PartDueDate.svelte';
  import PartNotes from '$lib/components/PartNotes.svelte';
  import FolderTreeNode from '../autocam/fusion/FolderTreeNode.svelte';
  import { fetchFusionJobsByManufacturingPartIds, fetchFusionJobNcFiles, fetchPartCategories, fetchPlates, createPart, createPlate, assignPartToPlate, createBoxTube, queueFusionJob, fetchFusionFolderTree } from '$lib/fusionCam.js';
  import { buildStockMaterialIndex, materialIdForStockAssignment, stockCatalogIdForStockAssignment } from '$autocam/stockMaterial.js';

  const LAST_SUBSYSTEM_STORAGE_KEY = '971hub:lastSubsystem';
  // Same labels JobQueueTab.svelte's own STATUS_LABELS uses, for the
  // in-progress states this page's own status badge shows.
  const FUSION_JOB_STATUS_LABELS = {
    queued: 'Queued - waiting for a Runner',
    claimed: 'Claimed by a Runner',
    processing: 'Processing in Fusion 360'
  };
  const QUICK_PRINT_STOCK_OPTIONS = stockData['3d-print'] || [];
  const DEFAULT_PETG_STOCK = QUICK_PRINT_STOCK_OPTIONS.find((stock) => stock.material === 'PETG')?.description || 'PETG 3D Printing Filament';
  const manufacturingStockMaterialIndex = buildStockMaterialIndex(stockData);
  
  let parts = [];
  let filteredParts = [];
  let loading = true;
  let user = null;
  let searchTerm = '';
  let filterWorkflow = '';
  let filterStatus = '';
  let filterProject = '';
  let filterSeason = getCurrentSeasonBucket()?.value || '';
  let show971 = true;
  let show9584 = true;
  let toastMessage = '';
  let toastTone = 'neutral';
  let showToast = false;
  // Fusion CAM job status per manufacturing request, keyed by part id -
  // traced through fusion_parts/fusion_box_tubes to whichever plate/tube
  // they're nested on (see fetchFusionJobsByManufacturingPartIds). Replaces
  // the old direct-per-part legacy AutoCAM job lookup - Fusion CAM only
  // covers router-workflow parts today.
  let fusionJobsByPart = {};
  let queuingCamJobForPartId = null;
  let fusionQueuePart = null;
  let fusionQueueKind = 'plate';
  let fusionQueueCategories = [];
  let fusionQueueMachines = [];
  let fusionQueueMaterials = [];
  let fusionQueueMachineTools = {};
  let fusionQueueFolderTree = null;
  let fusionQueueCategoryId = '';
  let fusionQueueMachineId = '';
  let fusionQueueToolId = '';
  let fusionQueueMaterialId = '';
  let fusionQueueQuantity = 1;
  let fusionQueueFileName = '';
  let fusionQueueFolderPath = '';
  let fusionQueueLoading = false;
  let subsystemOptions = [];
  let showQuickPrintModal = false;
  let quickPrintPartName = '';
  let quickPrintRequester = '';
  let quickPrintSubsystemId = '';
  let quickPrintMaterial = DEFAULT_PETG_STOCK;
  let quickPrintCustomMaterial = '';
  let quickPrintQuantity = 1;
  let quickPrintFile = null;
  let quickPrintSubmitting = false;
  // Kitting bins
  let bins = [];
  let selectedBinMap = {}; // per-part selected bin_id
  let assignedUserNames = {};
  
  // Assign Mode State
  let assignMode = false;
  let rosterMembers = [];
  let draggingUser = null;
  let selectedPartIds = [];
  let batchSelectMode = false;
  $: canUseAssignMode = isManufacturingLead(user);
  $: canCamReview = camReviewAllowed(user);
  $: canDelete = canDeleteParts(user);

  // A user may delete a part they created (matched by requester name), in
  // addition to admins / manufacturing leads (canDelete).
  function isOwnPart(part) {
    if (!part || !user) return false;
    const requester = (part.requester || '').trim().toLowerCase();
    const name = (user.full_name || '').trim().toLowerCase();
    return !!requester && requester === name;
  }
  function canDeletePart(part) {
    return canDelete || isOwnPart(part);
  }
  $: if (!canUseAssignMode && assignMode) {
    assignMode = false;
  }
  
  const workflows = [
    { value: 'laser-cut', label: 'Laser Cut', icon: Zap },
    { value: 'router', label: 'Router', icon: Wrench },
    { value: 'lathe', label: 'Lathe', icon: FileText },
    { value: 'mill', label: 'Mill', icon: FileText },
    { value: '3d-print', label: '3D Print', icon: Upload }
  ];
  
  // Include all DB-allowed statuses for filtering (combined from all workflows)
  const statuses = [
    { value: 'pending', label: 'Pending' },
    { value: 'in-progress', label: 'In Progress' },
    { value: 'drawing', label: 'Drawing In Progress' },
    { value: 'print-started', label: 'Print Started' },
    { value: 'machining', label: 'Machining' },
    { value: 'inspection', label: 'Inspection' },
    { value: 'cammed', label: 'CAM Reviewed' },
    { value: 'cam_review', label: 'CAM Review Pending' },
    { value: 'machined', label: 'Machined' },
    { value: 'complete', label: 'Complete' }
  ];
  
  // Get workflow-specific statuses for edit modal
  $: editStatusOptions = filterRestrictedStatusOptions(editWorkflow ? getWorkflowStatuses(editWorkflow) : statuses);

  function isPartFullyCompleted(part) {
    if (part?.workflow === 'router') return isFullyKitted(part);
    return part?.status === 'complete';
  }

  function getQuantitySummary(part) {
    return part?.quantity || 1;
  }

  function getRouterProgressSummary(part) {
    return part?.workflow === 'router' ? summarizeRouterStages(part) : '';
  }

  function getWorkflowClass(workflow) {
    if (!workflow) return 'tag-workflow-default';
    return `tag-workflow-${workflow.toLowerCase().replace(/_/g, '-')}`;
  }

  function filterRestrictedStatusOptions(options = []) {
    if (canCamReview) return options;
    return options.filter((option) => option?.value !== 'cammed');
  }

  function assertCanCamReview() {
    if (canCamReview) return true;
    alert('Only manufacturing leads can CAM review parts.');
    return false;
  }

  let showEditModal = false;
  let editPart = null;
  let editStatus = '';
  let editWorkflow = '';
  let editStock = '';
  let editCustomStock = '';
  let editQuantity = 1;
  let editNotes = '';
  let editDueDate = '';

  // Part Preview Modal State
  let showPreviewModal = false;
  let previewPart = null;
  let previewImage = null;
  let previewLoading = false;
  let previewError = null;
  let previewStatus = '';
  let previewWorkflow = '';
  let previewStock = '';
  let previewCustomStock = '';
  let previewQuantity = 1;
  let previewNotes = '';
  let previewDueDate = '';

  function getPartKey(partOrId) {
    return String(typeof partOrId === 'object' ? partOrId?.id : partOrId);
  }

  function getNormalizedPartId(id) {
    return (typeof id === 'string' && /^\d+$/.test(id)) ? Number(id) : id;
  }

  function chunkArray(items, size = 100) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  function isPartSelected(part) {
    return selectedPartIds.includes(getPartKey(part));
  }

  function togglePartSelection(part) {
    const key = getPartKey(part);
    selectedPartIds = selectedPartIds.includes(key)
      ? selectedPartIds.filter((id) => id !== key)
      : [...selectedPartIds, key];
  }

  function toggleSelectAllFiltered() {
    const filteredKeys = filteredParts.map(getPartKey);
    const allSelected = filteredKeys.length > 0 && filteredKeys.every((key) => selectedPartIds.includes(key));
    if (allSelected) {
      selectedPartIds = selectedPartIds.filter((key) => !filteredKeys.includes(key));
      return;
    }

    selectedPartIds = Array.from(new Set([...selectedPartIds, ...filteredKeys]));
  }

  function toggleBatchSelectMode() {
    batchSelectMode = !batchSelectMode;
    if (!batchSelectMode) {
      selectedPartIds = [];
    }
  }
  
  $: editStockOptions = editWorkflow ? (stockData[editWorkflow] || []).map(s => s.description) : [];
  $: projectIds = Array.from(new Set(parts.filter(p => !isPartFullyCompleted(p) && p.project_id).map(p => p.project_id))).sort();
  $: seasonOptions = getAllSeasonBuckets(parts);

  onMount(async () => {
    // Hydrate from UUID and keep local var in sync
    const unsub = userStore.subscribe((v) => { user = v; });
    await loadUserFromUUID(supabase);

    // Check authentication
    const { data: { session } } = await supabase.auth.getSession();
    if (!session && !user) {
      loading = false;
      goto('/');
      return;
    }
    if (session?.user?.id) {
      setUserUUID(session.user.id);
      await upsertProfileIfMissing(supabase, {
        id: session.user.id,
        email: session.user.email,
        name: session.user.user_metadata?.full_name || (session.user.email ? session.user.email.split('@')[0] : '')
      });
      await loadUserFromUUID(supabase);
    }

    await Promise.all([
      loadParts(),
      loadBins(),
      loadSubsystemOptions()
    ]);

    loading = false;

    // Deep link from AutoCAM ("view linked part") - /manufacture?part={id}
    if (highlightedPartId) {
      await tick();
      const el = document.getElementById(`part-${highlightedPartId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        showToastMessage('That part is hidden by your current filters');
      }
    }
  });

  $: highlightedPartId = $page.url.searchParams.get('part');

  function sanitizeName(value) {
    return (value || 'part').replace(/[^a-zA-Z0-9]/g, '_');
  }

  function derivePartNameFromFile(file) {
    return (file?.name || '').replace(/\.[^.]+$/, '').trim();
  }

  function getStoredLastSubsystemId() {
    if (!browser) return '';
    try {
      const raw = localStorage.getItem(LAST_SUBSYSTEM_STORAGE_KEY);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return typeof parsed?.id === 'string' ? parsed.id : '';
    } catch {
      return '';
    }
  }

  function persistLastSubsystem(subsystem) {
    if (!browser || !subsystem?.id) return;
    localStorage.setItem(LAST_SUBSYSTEM_STORAGE_KEY, JSON.stringify({
      id: subsystem.id,
      name: subsystem.name || '',
      updatedAt: new Date().toISOString()
    }));
  }

  function getDefaultQuickPrintSubsystemId() {
    const storedId = getStoredLastSubsystemId();
    if (storedId && subsystemOptions.some((subsystem) => subsystem.id === storedId)) {
      return storedId;
    }
    return subsystemOptions[0]?.id || '';
  }

  async function loadSubsystemOptions() {
    if (!user?.id) {
      subsystemOptions = [];
      return;
    }

    try {
      const { data, error } = await supabase
        .from('subsystem_members')
        .select('subsystems(id, name)')
        .eq('user_id', user.id);

      if (error) throw error;

      subsystemOptions = (data || [])
        .map((row) => row.subsystems)
        .filter(Boolean)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (error) {
      console.error('Error loading subsystem options:', error);
      subsystemOptions = [];
    }
  }

  function resetQuickPrintForm() {
    quickPrintPartName = '';
    quickPrintRequester = user?.full_name || user?.email || '';
    quickPrintSubsystemId = getDefaultQuickPrintSubsystemId();
    quickPrintMaterial = DEFAULT_PETG_STOCK;
    quickPrintCustomMaterial = '';
    quickPrintQuantity = 1;
    quickPrintFile = null;
    quickPrintSubmitting = false;
  }

  function openQuickPrintModal() {
    resetQuickPrintForm();
    showQuickPrintModal = true;
  }

  function closeQuickPrintModal() {
    showQuickPrintModal = false;
    quickPrintSubmitting = false;
  }

  function handleQuickPrintFileChange(event) {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['step', 'stp'].includes(ext || '')) {
      alert('Quick Print Add currently accepts STEP (.step or .stp) files.');
      event.currentTarget.value = '';
      return;
    }
    quickPrintFile = file;
    if (!quickPrintPartName.trim()) {
      quickPrintPartName = derivePartNameFromFile(file);
    }
  }

  async function submitQuickPrint() {
    const selectedSubsystem = subsystemOptions.find((subsystem) => subsystem.id === quickPrintSubsystemId);
    const effectiveMaterial = quickPrintMaterial === '__other__' ? quickPrintCustomMaterial.trim() : quickPrintMaterial;

    if (!quickPrintFile) {
      alert('Upload a STEP file first.');
      return;
    }
    if (!quickPrintPartName.trim()) {
      alert('Part name is required.');
      return;
    }
    if (!quickPrintRequester.trim()) {
      alert('Requester is required.');
      return;
    }
    if (!selectedSubsystem) {
      alert('Choose a subsystem.');
      return;
    }
    if (!effectiveMaterial) {
      alert('Choose a material.');
      return;
    }

    quickPrintSubmitting = true;
    try {
      const fileExt = quickPrintFile.name.split('.').pop();
      const fileName = `${Date.now()}_${sanitizeName(quickPrintPartName)}.${fileExt}`;
      const matchingStock = QUICK_PRINT_STOCK_OPTIONS.find((stock) => stock.description === effectiveMaterial);

      const { error: uploadError } = await supabase.storage
        .from('manufacturing-files')
        .upload(fileName, quickPrintFile, { cacheControl: '3600', upsert: false });
      if (uploadError) throw uploadError;

      const { data: insertedPart, error: insertError } = await supabase
        .from('parts')
        .insert([{
          name: quickPrintPartName.trim(),
          requester: quickPrintRequester.trim(),
          project_id: selectedSubsystem.name,
          workflow: '3d-print',
          quantity: Math.max(1, Number(quickPrintQuantity) || 1),
          material: matchingStock?.material || effectiveMaterial,
          stock_assignment: effectiveMaterial,
          file_name: fileName,
          file_url: fileName,
          status: 'pending',
          frc_team: user?.frc_team || null
        }])
        .select('id')
        .single();
      if (insertError) throw insertError;
      if (insertedPart?.id) {
        await sendNotification('manufacturing-request', { part_id: insertedPart.id });
      }

      persistLastSubsystem(selectedSubsystem);
      await loadParts();
      closeQuickPrintModal();
      showToastMessage('Quick print part added');
    } catch (error) {
      console.error('Quick print add error:', error);
      alert(`Error adding quick print part: ${error.message || error}`);
    } finally {
      quickPrintSubmitting = false;
    }
  }

  async function loadParts() {
    try {
      // Query the parts table directly
      const { data, error } = await supabase
        .from('parts')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      // Transform the data to include source_type for compatibility
      const transformedData = data.map(part => ({
        ...part,
        source_type: part.is_onshape_part ? 'onshape_api' : 'file_upload'
      }));
      
  parts = transformedData || [];
  await loadAssignedUserNames(parts);
  // Prefill selected bin dropdowns from current values
      for (const p of parts) {
        if (p.kitting_bin) selectedBinMap[p.id] = p.kitting_bin;
      }
      loadFusionJobsForParts();
    } catch (error) {
      console.error('Error loading parts:', error);
      alert('Error loading parts. Please try again.');
    } finally {
      loading = false;
    }
  }

  // Fusion CAM job status per manufacturing request. Loaded separately (not
  // blocking) so this never delays the parts list itself.
  async function loadFusionJobsForParts() {
    try {
      fusionJobsByPart = await fetchFusionJobsByManufacturingPartIds(parts.map((p) => p.id));
    } catch (error) {
      console.error('Error loading Fusion CAM job status:', error);
    }
  }

  // "Attach STEP" modal - only needed for the retrofit case: a router/lathe
  // part created before STEP was required for that workflow, so it has no
  // STEP file yet for the 3D viewer (or, for router, Fusion CAM).
  let showCamProfileModal = false;
  let camProfileModalPart = null;
  let camProfileFile = null;

  function openCamProfileModal(part) {
    camProfileModalPart = part;
    camProfileFile = null;
    showCamProfileModal = true;
  }

  function closeCamProfileModal() {
    showCamProfileModal = false;
    camProfileModalPart = null;
    camProfileFile = null;
  }

  async function submitCamProfile() {
    if (!camProfileModalPart || !camProfileFile) return;
    const part = camProfileModalPart;
    queuingCamJobForPartId = part.id;
    try {
      // Upload the STEP and attach it to the PART itself so
      // canViewCad()/getStepFileName() pick it up - same JSON meta
      // convention router already uses, merged with whatever's there.
      const stepName = `${Date.now()}_${(part.name || 'part').replace(/[^a-zA-Z0-9]/g, '_')}_cad.${(camProfileFile.name.split('.').pop() || 'step')}`;
      const { error: uploadError } = await supabase.storage
        .from('manufacturing-files')
        .upload(stepName, camProfileFile, { cacheControl: '3600', upsert: false });
      if (uploadError) {
        showToastMessage(uploadError.message || 'Failed to upload STEP file');
        return;
      }
      let existingMeta = {};
      try { existingMeta = JSON.parse(part.file_url || '{}') || {}; } catch { existingMeta = {}; }
      const newFileUrl = JSON.stringify({ ...existingMeta, step_file: stepName, step_valid: true });
      const { error: partUpdateError } = await supabase.from('parts').update({ file_url: newFileUrl }).eq('id', part.id);
      if (partUpdateError) {
        showToastMessage(partUpdateError.message || 'Failed to attach STEP to part');
        return;
      }
      showToastMessage('STEP file attached', 'success');
      closeCamProfileModal();
      await loadParts(); // refresh so canViewCad() picks up the newly-attached STEP
    } finally {
      queuingCamJobForPartId = null;
    }
  }

  // Single dispatcher for "Install CAD" (STEP download) regardless of where
  // the part's file actually lives - mirrors the branching already used for
  // the per-workflow download buttons above.
  function installCadStepFile(part) {
    if (part.source_type === 'onshape_api') {
      if (part.workflow === 'router') return downloadStepFromOnshape(part);
      return downloadFile(part, part.status);
    }
    return downloadFromStorage(part.file_name, part.id);
  }

  // Downloads every G-code file a completed Fusion CAM job produced - same
  // base64-decode technique JobQueueTab.svelte's downloadNcFile uses, just
  // triggered from the Manufacturing page instead of the Fusion CAM Jobs tab.
  async function downloadFusionNcFiles(job) {
    try {
      const files = Array.isArray(job.fusion_nc_files) ? job.fusion_nc_files : await fetchFusionJobNcFiles(job.id);
      for (const key of Object.keys(fusionJobsByPart)) {
        if (fusionJobsByPart[key]?.id === job.id) fusionJobsByPart[key] = { ...fusionJobsByPart[key], fusion_nc_files: files };
      }
      fusionJobsByPart = { ...fusionJobsByPart };
      for (const file of files) {
        const binary = atob(file.contentBase64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name.split('/').at(-1) || 'fusion-output.nc';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      showToastMessage(error.message || 'Failed to download Fusion G-code', 'error');
    }
  }

  async function sendNotification(type, payload = {}) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      await fetch('/api/notifications', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ type, ...payload })
      });
    } catch (err) {
      console.warn('Notification request failed', err);
    }
  }

  async function loadAssignedUserNames(partList) {
    const ids = [...new Set(partList.map(part => part.assigned_to).filter(Boolean))];
    if (ids.length === 0) {
      assignedUserNames = {};
      return;
    }

    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .in('id', ids);

      if (error) throw error;

      assignedUserNames = (data || []).reduce((acc, profile) => {
        acc[profile.id] = profile.full_name || profile.email || 'Assigned';
        return acc;
      }, {});
    } catch (error) {
      console.error('Error loading assigned user names:', error);
      assignedUserNames = {};
    }
  }

  async function loadRosterMembers() {
    try {
      // Load members from "Manufacturing Roles" roster
      // First find the roster
      const { data: rosters } = await supabase
        .from('rosters')
        .select('id')
        .ilike('name', '%Manufacturing Roles%')
        .limit(1);
      
      if (!rosters || rosters.length === 0) return;
      
      const rosterId = rosters[0].id;
      
      // Get entries with user details and keys (roles)
      const { data: entries, error } = await supabase
        .from('roster_entries')
        .select('*, user:user_id(id, full_name, email), key:key_id(key_name, category)')
        .eq('roster_id', rosterId);
        
      if (error) throw error;
      
      rosterMembers = entries || [];
    } catch (err) {
      console.error('Failed to load roster members', err);
    }
  }

  function toggleAssignMode() {
    if (!canUseAssignMode) return;
    assignMode = !assignMode;
    if (assignMode && rosterMembers.length === 0) {
      loadRosterMembers();
    }
  }

  function handleDragStart(e, user) {
    draggingUser = user;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', JSON.stringify(user));
  }

  function handleDragOver(e) {
    if (!assignMode || !canUseAssignMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  // Shared by both assignment paths: drag-and-drop (handleDrop, below - the
  // only realistic path on a desktop pointer) and a tap/select picker
  // (assignPartByTap, mobile) - dragging a roster card onto a part card
  // isn't a workable touch gesture, but the assignment itself is the same
  // write either way.
  async function assignPartToUser(part, user) {
    if (!user) return;
    try {
      const { error } = await supabase
        .from('parts')
        .update({ assigned_to: user.user_id, updated_at: new Date().toISOString() })
        .eq('id', part.id);

      if (error) throw error;

      const updatedParts = parts.map(p => {
        if (p.id === part.id) {
          return { ...p, assigned_to: user.user_id };
        }
        return p;
      });
      parts = updatedParts;

      assignedUserNames = {
        ...assignedUserNames,
        [user.user_id]: user.user?.full_name || user.user?.email
      };

      showToastMessage(`Assigned to ${user.user?.full_name || user.user?.email}`);
      await sendNotification('part-assigned', { part_id: part.id });
    } catch (err) {
      console.error('Failed to assign user', err);
      showToastMessage('Failed to assign user');
    }
  }

  async function handleDrop(e, part) {
    if (!assignMode || !canUseAssignMode) return;
    e.preventDefault();
    if (!draggingUser) return;
    await assignPartToUser(part, draggingUser);
    draggingUser = null;
  }

  // Mobile assign-mode picker: a <select> per part card instead of the
  // desktop drag-and-drop, which isn't a workable touch gesture. Fires on
  // change with the roster member's user_id.
  async function assignPartByTap(part, userId) {
    if (!userId) return;
    const member = filteredRosterMembers.find((m) => m.user_id === userId);
    await assignPartToUser(part, member);
  }

  $: filteredRosterMembers = rosterMembers.filter(m => {
    // Filter by workflow tag if selected
    if (!filterWorkflow) return true;
    // Assuming key category or name matches workflow
    // Map workflow values to potential key names/categories
    const workflowMap = {
      'laser-cut': ['laser', 'laser cutter'],
      'router': ['router', 'cnc router'],
      'lathe': ['lathe'],
      'mill': ['mill', 'cnc mill'],
      '3d-print': ['3d print', 'printer']
    };
    
    const keywords = workflowMap[filterWorkflow] || [];
    if (keywords.length === 0) return true;
    
    const keyName = m.key?.key_name?.toLowerCase() || '';
    const category = m.key?.category?.toLowerCase() || '';
    
    return keywords.some(k => keyName.includes(k) || category.includes(k));
  });

  async function downloadFile(part, currentStatus) {
    try {
      // If part is still "pending", automatically mark it as "in-progress"
      if (currentStatus === 'pending') {
        await updatePartStatus(part.id, 'in-progress');
        setLocalStatus(part.id, 'in-progress');
      }
      // If this part requires a drawing (lathe/mill) we no longer generate or download PDFs.
      // Instead, open the subsystem/document for the part.
      if (part.workflow === 'lathe' || part.workflow === 'mill') {
        await openSubsystemDocument(part);
        return;
      }

      if (part.source_type === 'onshape_api') {
        // Handle Onshape API download for non-drawing exports
        await downloadFromOnshape(part);
      } else {
        // Handle storage bucket download (legacy parts created via create route)
        await downloadFromStorage(part.file_name, part.id);
      }
    } catch (error) {
      console.error('Error downloading file:', error);
      alert(`Error downloading file: ${error.message}`);
    }
  }

  async function downloadFromOnshape(part) {
    try {
      // Special handling for laser cutter - download SVG instead of STEP
      if (part.workflow === 'laser-cut') {
        await downloadSVGForLaser(part);
        return;
      }

      // Note: lathe/mill drawing PDF generation has been removed. Those parts should
      // open the subsystem/document page instead (handled earlier in downloadFile or via UI).

      // Log the Onshape IDs being used for debugging
      console.log('Downloading from Onshape:', {
        name: part.name,
        onshape_document_id: part.onshape_document_id,
        onshape_element_id: part.onshape_element_id,
        onshape_part_id: part.onshape_part_id,
        onshape_wvm: part.onshape_wvm,
        onshape_wvmid: part.onshape_wvmid
      });

      // Use the new translation workflow for both STL and STEP (prefer STEP for 3D prints)
      const action = 'translate-part';
      
      // Build the API URL
      const params = new URLSearchParams({
        action: action,
        documentId: part.onshape_document_id,
        elementId: part.onshape_element_id,
        partId: part.onshape_part_id,
        wvm: part.onshape_wvm,
        wvmId: part.onshape_wvmid,
        // Force STEP for 3D-print parts; otherwise fall back to part.file_format or STEP
        format: part.workflow === '3d-print' ? 'STEP' : (part.file_format === 'stl' ? 'STL' : 'STEP')
      });
      
      showToastMessage('Download requested...');
      
      const response = await fetch(`/api/onshape?${params}`);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.details || errorData.error || `HTTP error! status: ${response.status}`;
        console.error('Onshape download failed:', errorData);
        if (errorData.suggestion) {
          showToastMessage(`Download failed: ${errorMsg}`);
          alert(`Download failed: ${errorMsg}\n\nSuggestion: ${errorData.suggestion}`);
        } else {
          showToastMessage(`Download failed: ${errorMsg}`);
        }
        return;
      }

      // Create blob and download
      const blob = await response.blob();
      const fileExt = part.workflow === '3d-print' ? 'step' : (part.file_format === 'stl' ? 'stl' : 'step');
      const fileName = `${part.name.replace(/[^a-zA-Z0-9]/g, '_')}.${fileExt}`;
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      showToastMessage(`${fileExt.toUpperCase()} file downloaded successfully!`);
    } catch (error) {
      console.error('Error downloading from Onshape:', error);
      showToastMessage(`Error downloading file: ${error.message}`);
    }
  }

  async function downloadFromStorage(fileName, partId) {
    try {
      showToastMessage('Download requested...');
      
      // Try to create signed URL for the filename as stored
      let { data, error } = await supabase.storage
        .from('manufacturing-files')
        .createSignedUrl(fileName, 60); // URL expires in 60 seconds
      
      // If that fails, it might be URL encoded, so try decoding it
      if (error && error.message.includes('Object not found')) {
        const decodedFileName = decodeURIComponent(fileName);
        const result = await supabase.storage
          .from('manufacturing-files')
          .createSignedUrl(decodedFileName, 60);
        data = result.data;
        error = result.error;
      }
      
      if (error) throw error;
      
      // Open the signed URL in a new tab
      window.open(data.signedUrl, '_blank');
      showToastMessage('File download started!');
    } catch (error) {
      console.error('Error downloading from storage:', error);
      showToastMessage(`Error downloading file: ${error.message}`);
      throw new Error(`Error downloading file: ${error.message}. The file may have been deleted or the filename may be incorrect.`);
    }
  }

  // Manufacture Actions Helpers

  async function updatePartStatus(partId, newStatus) {
    try {
      const { error } = await supabase
        .from('parts')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', partId);
      
      if (error) throw error;
      if (newStatus === 'complete') {
        await sendNotification('part-complete', { part_id: partId });
      }
      await sendNotification('manufacturing-request-status', { part_id: partId, status: newStatus });
      await sendNotification('router-status', { part_id: partId, status: newStatus });
      // NOTE: no loadParts() here — callers use setLocalStatus for an optimistic update
      // so the hub doesn't flash/reload on every button click.
    } catch (error) {
      console.error('Error updating part status:', error);
      alert('Error updating part status. Please try again.');
    }
  }

  // Load available kitting bins from Supabase
  async function loadBins() {
    try {
      const { data, error } = await supabase
        .from('kitting_bins')
        .select('bin_id, name')
        .order('name', { ascending: true });
      if (error) throw error;
      bins = data || [];
    } catch (err) {
      console.warn('Error loading kitting bins (does table exist?):', err?.message || err);
      bins = [];
    }
  }

  async function completePart(partId, deliveryMethod, kittingBin = '') {
    try {
      const updateData = {
        status: 'complete',
        delivered: deliveryMethod === 'delivered',
        updated_at: new Date().toISOString()
      };
      
      if (deliveryMethod === 'kitting-bin' && kittingBin) {
        updateData.kitting_bin = kittingBin;
      }
      
      const { error } = await supabase
        .from('parts')
        .update(updateData)
        .eq('id', partId);

      if (error) throw error;
      // This path sets status: 'complete' directly (not via updatePartStatus
      // above), so it needs its own copies of both notification calls -
      // previously missing the subsystem one entirely, a pre-existing gap.
      await sendNotification('part-complete', { part_id: partId });
      await sendNotification('manufacturing-request-status', { part_id: partId, status: 'complete' });
      await sendNotification('router-status', { part_id: partId, status: 'complete' });
      await loadParts();
    } catch (error) {
      console.error('Error completing part:', error);
      alert('Error completing part. Please try again.');
    }
  }

  $: if (showQuickPrintModal && !quickPrintSubsystemId) {
    quickPrintSubsystemId = getDefaultQuickPrintSubsystemId();
  }

  // Helper: persist the latest bin entry (store in kitting_bin per spec "last value")
  async function updateBin(partId, bin) {
    try {
      if (!bin) return;
      const { error } = await supabase
        .from('parts')
        .update({ kitting_bin: bin, updated_at: new Date().toISOString() })
        .eq('id', partId);
      if (error) console.warn('updateBin error:', error.message);
    } catch (e) {
      console.warn('updateBin exception:', e?.message || e);
    }
  }

  // Router meta helpers: persist fine-grained router workflow without DB schema changes
  function getRouterMeta(part) {
    try {
      const root = JSON.parse(part.file_url || '{}');
      return root && root.router_meta ? root.router_meta : {};
    } catch {
      return {};
    }
  }
  async function updateRouterMeta(part, updates) {
    try {
      let root = {};
      try {
        root = JSON.parse(part.file_url || '{}') || {};
      } catch {
        root = {};
      }
      root.router_meta = { ...(root.router_meta || {}), ...updates };
      const { error } = await supabase
        .from('parts')
        .update({ file_url: JSON.stringify(root), updated_at: new Date().toISOString() })
        .eq('id', part.id);
      if (error) console.warn('updateRouterMeta error:', error.message);
      // NOTE: no loadParts() here — callers use setLocalRouterMeta for an optimistic update.
    } catch (e) {
      console.warn('updateRouterMeta exception:', e?.message || e);
    }
  }

  // Mark a router part as Machined: set the full quantity to the 'cut' stage so
  // the part is genuinely "fully cut" and flows into the Post Processing tab
  // (which is group/stage based), rather than just flipping a status label.
  async function markPartMachined(part) {
    const qty = part.quantity || 1;
    const update = buildRouterProgressUpdate(part, { cut: qty });
    try {
      const { error } = await supabase.from('parts').update(update).eq('id', part.id);
      if (error) throw error;
    } catch (e) {
      console.error('Failed to mark part machined:', e);
      alert('Failed to mark part machined. Please try again.');
      return;
    }
    // Optimistic local update (status + router_meta both live in the update).
    parts = parts.map((p) => (p.id === part.id ? { ...p, status: update.status, file_url: update.file_url } : p));
  }

  // Additional file meta helpers for router STEP/DXF handling
  function getFileMeta(part) {
    try {
      return JSON.parse(part.file_url || '{}') || {};
    } catch {
      return {};
    }
  }

  // STEP-file health for router parts. Returns:
  //   'missing' - router part with no STEP file at all
  //   'invalid' - a STEP file is present but failed validation at upload
  //   null      - fine (or not applicable: non-router / Onshape on-demand)
  function stepFileWarning(part) {
    if (part.workflow !== 'router') return null;
    // Onshape parts download their STEP on demand — not stored, never "missing".
    if (part.source_type === 'onshape_api') return null;
    const meta = getFileMeta(part);
    if (!meta.step_file && !part.file_name) return 'missing';
    if (meta.step_valid === false) return 'invalid';
    return null;
  }

  async function ensureInProgress(part) {
    try {
      if (part?.status === 'pending') {
        await updatePartStatus(part.id, 'in-progress');
        setLocalStatus(part.id, 'in-progress');
      }
    } catch {}
  }

  // CAD viewer modal state
  let showCadModal = false;
  let cadViewerPart = null;

  // The storage path of an uploaded STEP file for a router part, if any.
  function getStepFileName(part) {
    const meta = getFileMeta(part);
    if (meta.step_file) return meta.step_file;
    if (part.file_name && /\.(step|stp)$/i.test(part.file_name)) return part.file_name;
    return null;
  }

  // Show "View CAD" only when the part has an uploaded STEP file we can render
  // client-side. (Onshape parts without an uploaded STEP, and STL/other uploads,
  // do not qualify.)
  function canViewCad(part) {
    return !!getStepFileName(part);
  }

  function fusionQueueTools(machineId) {
    return machineId ? fusionQueueMachineTools[machineId] || [] : [];
  }

  function fusionQueueToolLabel(tool) {
    return `${tool.name}${tool.diameter ? ` (${tool.diameter}\")` : ''}`;
  }

  function fusionQueueCategoryLabel(category) {
    return `${category.cam_materials?.name || 'Material'} - ${Number(category.thickness).toFixed(3)}\"`;
  }

  function selectFusionQueueMachine(machineId) {
    fusionQueueMachineId = machineId;
    const machine = fusionQueueMachines.find((candidate) => String(candidate.id) === String(machineId));
    const eligible = fusionQueueTools(machineId);
    const defaultTool = eligible.find((tool) => String(tool.id) === String(machine?.default_tool_id));
    fusionQueueToolId = defaultTool?.id || eligible[0]?.id || '';
  }

  function selectFusionQueueKind(kind) {
    fusionQueueKind = kind;
    const machine = fusionQueueMachines.find((candidate) => kind === 'tube' ? candidate.can_run_box_tubes : candidate.can_run_plates);
    selectFusionQueueMachine(machine?.id || '');
    if (kind === 'tube') {
      const aluminum = fusionQueueMaterials.find((material) => /alumin(?:um|ium)/i.test(material.name || ''));
      fusionQueueMaterialId = aluminum?.id || '';
    }
  }

  async function openFusionCamModal(part) {
    fusionQueuePart = part;
    fusionQueueLoading = true;
    fusionQueueKind = 'plate';
    fusionQueueQuantity = Number.isInteger(Number(part.quantity)) && Number(part.quantity) > 0 ? Number(part.quantity) : 1;
    fusionQueueFileName = (part.name || '').replace(/\s+/g, '');
    fusionQueueFolderPath = '';
    try {
      const [categories, machines, materials, folderTree] = await Promise.all([
        fetchPartCategories(),
        supabase.from('cam_machines').select('*').eq('enabled', true).order('name'),
        supabase.from('cam_materials').select('id, name').eq('enabled', true).order('name'),
        fetchFusionFolderTree()
      ]);
      fusionQueueCategories = categories;
      fusionQueueMachines = machines.data || [];
      fusionQueueMaterials = materials.data || [];
      fusionQueueFolderTree = folderTree;
      const stockMaterialId = materialIdForStockAssignment(manufacturingStockMaterialIndex, fusionQueueMaterials, part.stock_assignment, stockData);
      const stockCatalogId = stockCatalogIdForStockAssignment(stockData, part.stock_assignment);
      const stockThickness = (stockData.router || []).find((stock) => stock.id === stockCatalogId)?.thickness;
      fusionQueueCategoryId = String(fusionQueueCategories.find((category) =>
        String(category.material_id) === String(stockMaterialId) && Number.isFinite(stockThickness) && Math.abs(Number(category.thickness) - stockThickness) < 0.002
      )?.id || '');
      selectFusionQueueKind('plate');
    } catch (error) {
      showToastMessage(error.message || 'Could not load Fusion AutoCAM options', 'error');
      fusionQueuePart = null;
    } finally {
      fusionQueueLoading = false;
    }
  }

  function closeFusionCamModal() {
    if (fusionQueueLoading || queuingCamJobForPartId) return;
    fusionQueuePart = null;
  }

  async function manufacturingStepFile(part) {
    const path = getStepFileName(part);
    if (!path) throw new Error('This manufacturing request needs a STEP file before it can be sent to Fusion');
    const { data, error } = await supabase.storage.from('manufacturing-files').download(path);
    if (error || !data) throw error || new Error('Could not download the request STEP file');
    return new File([data], path.split('/').pop() || `${part.name || 'part'}.step`, { type: data.type || 'application/step' });
  }

  async function submitFusionCamModal() {
    const part = fusionQueuePart;
    if (!part || fusionQueueLoading) return;
    const quantity = Number(fusionQueueQuantity);
    if (!Number.isInteger(quantity) || quantity < 1) return showToastMessage('Quantity must be a whole number greater than zero', 'error');
    const machine = fusionQueueMachines.find((candidate) => String(candidate.id) === String(fusionQueueMachineId));
    if (!machine || !(fusionQueueKind === 'tube' ? machine.can_run_box_tubes : machine.can_run_plates)) return showToastMessage('Choose a compatible router', 'error');
    if (!fusionQueueTools(fusionQueueMachineId).some((tool) => String(tool.id) === String(fusionQueueToolId))) return showToastMessage('Choose a tool installed on this router', 'error');
    if (fusionQueueKind === 'plate' && !fusionQueueCategoryId) return showToastMessage('Choose a material and thickness', 'error');
    if (fusionQueueKind === 'tube' && !fusionQueueMaterials.some((material) => String(material.id) === String(fusionQueueMaterialId) && /alumin(?:um|ium)/i.test(material.name || ''))) return showToastMessage('Choose an aluminum material for tube stock', 'error');
    queuingCamJobForPartId = part.id;
    try {
      const stepFile = await manufacturingStepFile(part);
      if (fusionQueueKind === 'tube') {
        const tube = await createBoxTube({ name: part.name, epic: part.epic, ticket: part.ticket, quantity, stepFile, createdBy: user?.id, partId: part.id, projectId: part.project_id, stockAssignment: part.stock_assignment });
        await queueFusionJob({ fusionJobKind: 'box_tube', boxTubeId: tube.id, machineId: fusionQueueMachineId, toolId: fusionQueueToolId, materialId: fusionQueueMaterialId, requestedBy: user?.id, partId: part.id, name: `Tube Stock CAM: ${part.name}`, fusionFileName: fusionQueueFileName.trim() || null, fusionFolderPath: fusionQueueFolderPath || null });
      } else {
        const category = fusionQueueCategories.find((candidate) => String(candidate.id) === String(fusionQueueCategoryId));
        const fusionPart = await createPart({ name: part.name, epic: part.epic, ticket: part.ticket, quantity, categoryId: category.id, stepFile, createdBy: user?.id, partId: part.id, fusionFileName: fusionQueueFileName.trim() || null, projectId: part.project_id, stockAssignment: part.stock_assignment });
        const plates = await fetchPlates();
        let plate = plates.find((candidate) => String(candidate.category_id) === String(category.id));
        if (!plate) plate = await createPlate({ name: `Auto stock - ${fusionQueueCategoryLabel(category)}`, width: 24, length: 24, trueDepth: Number(category.thickness), categoryId: category.id });
        await assignPartToPlate({ categoryId: category.id, plateId: plate.id, partId: fusionPart.id, quantity });
        await queueFusionJob({ fusionJobKind: 'plate:cam', plateId: plate.id, machineId: fusionQueueMachineId, toolId: fusionQueueToolId, materialId: category.material_id, requestedBy: user?.id, name: `Fusion CAM: ${part.name}`, groupingMode: 'single', selectedPartId: fusionPart.id, fusionFileName: fusionQueueFileName.trim() || null, fusionFolderPath: fusionQueueFolderPath || null });
      }
      showToastMessage('Queued for the Fusion Runner', 'success');
      fusionQueuePart = null;
      await loadFusionJobsForParts();
    } catch (error) {
      showToastMessage(error.message || 'Failed to queue Fusion AutoCAM job', 'error');
    } finally {
      queuingCamJobForPartId = null;
    }
  }

  // Lathe/turning parts have no working CAM entry point on this page at all
  // right now - Fusion CAM only runs plate and box-tube routing jobs, and
  // direct instruction: plain /autocam doesn't actually work for this case
  // either (contrary to what an earlier version of this comment assumed).
  // No "Open AutoCAM"/turning CAM button is shown for lathe parts as a
  // result - only View CAD/Install CAD - until issue #396's bigger question
  // (extend Fusion CAM to turning, or build a real lathe entry point) is
  // settled with the team.

  // A router request may enter human CAM review only after the real Fusion
  // pipeline has completed its job. This replaces the old manual Start ->
  // CAM Done ladder, which could claim CAM was ready without any generated
  // Fusion output behind it.
  async function advanceRouterToCamReview(part) {
    const fusionJob = fusionJobsByPart[part.id];
    if (!canAdvanceRouterToCamReview(part, fusionJob)) return;

    if (part.status === 'pending') await updatePartStatus(part.id, 'in-progress');
    await updateRouterMeta(part, { step: 'cam_review' });
    if (part.status === 'pending') setLocalStatus(part.id, 'in-progress');
    setLocalRouterMeta(part.id, { step: 'cam_review' });
  }

  function openCadViewer(part) {
    cadViewerPart = part;
    showCadModal = true;
  }

  function closeCadViewer() {
    showCadModal = false;
    cadViewerPart = null;
  }

  async function downloadStepFromOnshape(part) {
    await ensureInProgress(part);
    const params = new URLSearchParams({
      action: 'translate-part',
      documentId: part.onshape_document_id,
      elementId: part.onshape_element_id,
      partId: part.onshape_part_id,
      wvm: part.onshape_wvm,
      wvmId: part.onshape_wvmid,
      format: 'STEP'
    });
    const response = await fetch(`/api/onshape?${params}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }
    const blob = await response.blob();
    const fileName = `${(part.name || 'part').replace(/[^a-zA-Z0-9]/g, '_')}.step`;
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    window.URL.revokeObjectURL(url); document.body.removeChild(a);
  }

  // Router flow helpers (new) - definitions moved earlier in file for JSON-based flow

  // Build Onshape URL for a part (returns null if not an Onshape part)
  function getOnshapeUrl(part) {
    if (!part.onshape_document_id || !part.onshape_wvmid) return null;
    const baseUrl = PUBLIC_ONSHAPE_BASE_URL || 'https://cad.onshape.com';
    const wvm = part.onshape_wvm || 'w';
    const elementId = part.onshape_drawing_element_id || part.onshape_element_id;
    if (!elementId) return null;
    return `${baseUrl.replace(/\/$/, '')}/documents/${encodeURIComponent(part.onshape_document_id)}/${encodeURIComponent(wvm)}/${encodeURIComponent(part.onshape_wvmid)}/e/${encodeURIComponent(elementId)}`;
  }

  // Format date/time in a friendly way
  function formatDateTime(dateStr) {
    if (!dateStr) return 'N/A';
    return formatPacificDateTimeWithZone(dateStr) || 'N/A';
  }

  // Open the subsystem page or linked Onshape document for parts that require drawings
  async function openSubsystemDocument(part) {
    try {
      // Prefer navigating to the subsystem page if we have a subsystem_id
      if (part.subsystem_id) {
        const url = `/cad/${part.subsystem_id}`;
        window.open(url, '_blank', 'noopener');
        return;
      }

      // If we have Onshape params in the DB, open the Onshape web UI directly.
      // Use drawing element id when available (onshape_drawing_element_id),
      // otherwise fall back to the primary element id.
      if (part.onshape_document_id && (part.onshape_wvmid || part.onshape_wvm) && (part.onshape_drawing_element_id || part.onshape_element_id)) {
        try {
          const baseUrl = PUBLIC_ONSHAPE_BASE_URL || 'https://cad.onshape.com';
          const documentId = part.onshape_document_id;
          const wvm = part.onshape_wvm || 'w'; // expected 'w'|'v'|'m'
          const wvmId = part.onshape_wvmid;
          const elementId = part.onshape_drawing_element_id || part.onshape_element_id;

          // Construct URL like: https://cad.onshape.com/documents/{documentId}/{wvm}/{wvmId}/e/{elementId}
          const url = `${baseUrl.replace(/\/$/, '')}/documents/${encodeURIComponent(documentId)}/${encodeURIComponent(wvm)}/${encodeURIComponent(wvmId)}/e/${encodeURIComponent(elementId)}`;
          window.open(url, '_blank', 'noopener');
          return;
        } catch (err) {
          console.error('Error constructing Onshape URL:', err);
        }
      }

      // If we have an Onshape document id but couldn't open the web UI directly,
      // try to find a linked subsystem and navigate there as a fallback.
      if (part.onshape_document_id) {
        try {
          const { data: subsystems, error } = await supabase
            .from('subsystems')
            .select('id')
            .eq('onshape_document_id', part.onshape_document_id)
            .limit(1);

          if (!error && subsystems && subsystems.length > 0) {
            const url = `/cad/${subsystems[0].id}`;
            window.open(url, '_blank', 'noopener');
            return;
          }
        } catch (err) {
          console.error('Error querying subsystems for document id:', err);
        }

        // If we couldn't find a subsystem, open the CAD landing page where users can locate the document
        window.open('/cad', '_blank', 'noopener');
        return;
      }

      alert('No subsystem or document found for this part.');
    } catch (error) {
      console.error('Error opening subsystem document:', error);
      alert('Unable to open subsystem document.');
    }
  }

  function getWorkflowLabel(workflow) {
    const found = workflows.find(w => w.value === workflow);
    return found ? found.label : workflow;
  }

  function getWorkflowIcon(workflow) {
    const found = workflows.find(w => w.value === workflow);
    return found ? found.icon : FileText;
  }

  function formatDate(dateString) {
    return formatPacificDate(dateString);
  }

  function getStatusDisplay(part) {
    // Completed parts show their bin / delivery state instead of a status label.
    if (part.status === 'complete') {
      if (part.kitting_bin) return part.kitting_bin;
      if (part.delivered) return 'Delivered';
      return 'Complete';
    }
    // All workflows share the unified status set — map the raw status (and any
    // router_meta sub-step like cam_review) to its display label.
    const meta = getRouterMeta(part);
    return getDisplayStatus(part.status, meta);
  }

  function getStatusBadgeClass(status) {
    if (status === 'in-progress') return 'status-progress';
    if (status === 'machined' || status === 'inspected') return 'status-progress';
    if (status === 'cammed') return 'status-cammed';
    if (status === 'complete') return 'status-complete';
    return 'status-pending';
  }

  async function exportToCSV() {
    try {
      // Fetch all parts data from the parts table
      const { data, error } = await supabase
        .from('parts')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      if (!data || data.length === 0) {
        alert('No parts data to export.');
        return;
      }
      
      // Define CSV headers
      const headers = [
        'ID',
        'Name',
        'Requester',
        'Project ID',
        'Workflow',
        'Quantity',
  'Stock',
        'Status',
        'Source Type',
        'File Name',
        'File Format',
        'Onshape Document ID',
        'Onshape Version',
        'Kitting Bin',
        'Delivered',
        'Created Date',
        'Updated Date'
      ];
      
      // Convert data to CSV format
      const csvContent = [
        headers.join(','), // Header row
        ...data.map(part => [
          part.id || '',
          `"${(part.name || '').replace(/"/g, '""')}"`, // Escape quotes
          `"${(part.requester || '').replace(/"/g, '""')}"`,
          `"${(part.project_id || '').replace(/"/g, '""')}"`,
          part.workflow || '',
          part.quantity || 1,
          `"${(part.stock_assignment || '').replace(/"/g, '""')}"`,
          part.status || '',
          part.source_type || '',
          `"${(part.file_name || '').replace(/"/g, '""')}"`,
          part.file_format || '',
          part.onshape_document_id || '',
          part.onshape_wvmid || '',
          `"${(part.kitting_bin || '').replace(/"/g, '""')}"`,
          part.delivered ? 'Yes' : 'No',
          part.created_at ? formatPacificDateTimeWithZone(part.created_at) : '',
          part.updated_at ? formatPacificDateTimeWithZone(part.updated_at) : ''
        ].join(','))
      ].join('\n');
      
      // Create and download the file
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      
      link.setAttribute('href', url);
      link.setAttribute('download', `parts_export_${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
    } catch (error) {
      console.error('Error exporting CSV:', error);
      alert('Error exporting data. Please try again.');
    }
  }

  // Edit modal handlers
  function openEditModal(part) {
    editPart = part;
    // If router part is in the CAM Review Ready pseudo-state, surface that value in the select
    const meta = part.workflow === 'router' ? getRouterMeta(part) : {};
    editStatus = (part.workflow === 'router' && meta.step === 'cam_review') ? 'cam_review' : (part.status || 'pending');
    editWorkflow = part.workflow || '';
    editStock = part.stock_assignment || '';
    editCustomStock = '';
    editQuantity = part.quantity || 1;
    editNotes = part.notes || '';
    editDueDate = (part.due_date || '').slice(0, 10);
    showEditModal = true;
  }

  // Local state helpers to avoid a full reload after button clicks
  function setLocalRouterMeta(partId, updates) {
    parts = parts.map((p) => {
      if (p.id !== partId) return p;
      let root = {};
      try {
        root = JSON.parse(p.file_url || '{}') || {};
      } catch {
        root = {};
      }
      root.router_meta = { ...(root.router_meta || {}), ...updates };
      return { ...p, file_url: JSON.stringify(root) };
    });
  }

  function setLocalStatus(partId, status) {
    parts = parts.map((p) => (p.id === partId ? { ...p, status } : p));
  }

  // Row click handler: for Onshape parts, show preview; otherwise open edit modal
  // but ignore clicks that originated on interactive elements (buttons, inputs, links)
  function onRowClick(e, part) {
    try {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) return;
    } catch (err) {
      // defensive: if DOM not available, just return
      return;
    }
    // Show preview modal for Onshape parts that have all required IDs
    if (part.source_type === 'onshape_api' && part.onshape_document_id && part.onshape_element_id && part.onshape_part_id) {
      openPreviewModal(part);
    } else {
      openEditModal(part);
    }
  }

  function onRowKeyDown(e, part) {
    // Only act on Enter or Space
    if (e.key !== 'Enter' && e.key !== ' ') return;
    try {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) return;
    } catch (err) {
      return;
    }
    // Prevent page from scrolling on Space
    e.preventDefault();
    // Show preview modal for Onshape parts that have all required IDs
    if (part.source_type === 'onshape_api' && part.onshape_document_id && part.onshape_element_id && part.onshape_part_id) {
      openPreviewModal(part);
    } else {
      openEditModal(part);
    }
  }

  // Part Preview Modal Functions
  async function openPreviewModal(part) {
    previewPart = part;
    previewImage = null;
    previewError = null;
    previewLoading = true;
    showPreviewModal = true;
    
    // Initialize edit state
    const meta = part.workflow === 'router' ? getRouterMeta(part) : {};
    previewStatus = (part.workflow === 'router' && meta.step === 'cam_review') ? 'cam_review' : (part.status || 'pending');
    previewWorkflow = part.workflow || '';
    previewStock = part.stock_assignment || '';
    previewCustomStock = '';
    previewQuantity = part.quantity || 1;
    previewNotes = part.notes || '';
    previewDueDate = (part.due_date || '').slice(0, 10);

    // Check if we have a cached preview image URL first
    if (part.preview_image_url) {
      const { data: urlData } = supabase.storage.from('part-previews').getPublicUrl(part.preview_image_url);
      previewImage = urlData?.publicUrl || null;
      if (previewImage) {
        previewLoading = false;
        return;
      }
    }
    
    // Fetch from Onshape API if no cached image
    await fetchAndCachePreviewImage(part);
  }

  // Fetch preview image from Onshape and cache it to storage
  async function fetchAndCachePreviewImage(part) {
    if (!part.onshape_document_id || !part.onshape_element_id || !part.onshape_part_id) {
      previewError = 'Missing Onshape IDs for preview';
      previewLoading = false;
      return null;
    }
    
    try {
      const params = new URLSearchParams({
        action: 'shaded-views',
        documentId: part.onshape_document_id,
        elementId: part.onshape_element_id,
        partId: part.onshape_part_id,
        wvm: part.onshape_wvm || 'w',
        wvmId: part.onshape_wvmid,
        outputHeight: '800',
        outputWidth: '800'
      });
      
      const response = await fetch(`/api/onshape?${params}`);
      const data = await response.json();
      
      if (data.success && data.image) {
        // Show the image immediately
        previewImage = `data:image/png;base64,${data.image}`;
        
        // Upload to storage (wait for it to complete)
        await uploadPreviewToStorage(part.id, data.image);
          
        return data.image;
      } else {
        previewError = data.error || 'Failed to load preview';
        return null;
      }
    } catch (err) {
      console.error('Error loading part preview:', err);
      previewError = err.message || 'Failed to load preview';
      return null;
    } finally {
      previewLoading = false;
    }
  }
  
  // Upload preview image to storage bucket and update database
  async function uploadPreviewToStorage(partId, base64Image) {
    try {
      console.log('Starting upload for part:', partId, 'image size:', base64Image.length);
      
      // Convert base64 to blob
      const byteCharacters = atob(base64Image);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'image/png' });
      console.log('Blob created, size:', blob.size);
      
      // Upload to storage
      const fileName = `${partId}.png`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('part-previews')
        .upload(fileName, blob, { upsert: true, contentType: 'image/png' });
      
      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        return;
      }
      console.log('Upload successful:', uploadData);
      
      // Update the parts table with the storage path
      const { error: updateError } = await supabase
        .from('parts')
        .update({ 
          preview_image_url: fileName,
          preview_image_updated_at: new Date().toISOString()
        })
        .eq('id', partId);
      
      if (updateError) {
        console.error('Database update error:', updateError);
      } else {
        console.log('Preview image saved for part:', partId);
      }
    } catch (err) {
      console.error('Error uploading preview to storage:', err);
    }
  }

  function closePreviewModal() {
    showPreviewModal = false;
    previewPart = null;
    previewImage = null;
    previewError = null;
    previewLoading = false;
    previewStatus = '';
    previewWorkflow = '';
    previewStock = '';
    previewCustomStock = '';
    previewQuantity = 1;
    previewNotes = '';
    previewDueDate = '';
  }

  async function savePreviewEdits() {
    if (!previewPart) return;
    if (previewStatus === 'cammed' && !assertCanCamReview()) return;
    const effectiveStock = previewStock === '__other__' ? (previewCustomStock || '').trim() : previewStock;
    const update = {
      status: previewStatus === 'cam_review' ? 'in-progress' : previewStatus,
      workflow: previewWorkflow,
      quantity: Math.max(1, Number(previewQuantity) || 1),
      notes: (previewNotes || '').trim() || null,
      due_date: previewDueDate || null,
      updated_at: new Date().toISOString()
    };
    if (effectiveStock) update.stock_assignment = effectiveStock;
    try {
      const { error } = await supabase
        .from('parts')
        .update(update)
        .eq('id', previewPart.id);
      if (error) throw error;
      if (previewStatus === 'cam_review') {
        try { await updateRouterMeta(previewPart, { step: 'cam_review' }); } catch (e) { console.warn('updateRouterMeta failed:', e); }
      }
      await loadParts();
      showToastMessage('Part updated');
      closePreviewModal();
    } catch (e) {
      console.error('savePreviewEdits error:', e);
      alert('Failed to update part: ' + (e.message || e));
    }
  }

  async function deletePreviewPart() {
    if (!previewPart) return;
    if (!await requestConfirmation({ message: 'Delete this part permanently?', confirmLabel: 'Delete part', danger: true })) return;
    try {
      await deletePartsByIds([previewPart.id]);
      showToastMessage('Part deleted');
      closePreviewModal();
    } catch (e) {
      console.error('deletePreviewPart error:', e);
      alert('Failed to delete part: ' + (e.message || e));
    }
  }

  $: previewStockOptions = previewWorkflow ? (stockData[previewWorkflow] || []).map(s => s.description) : [];
  $: previewStatusOptions = filterRestrictedStatusOptions(previewWorkflow ? getWorkflowStatuses(previewWorkflow) : statuses);

  function closeEditModal() {
    showEditModal = false;
    editPart = null;
  }

  async function saveEdits() {
    if (!editPart) return;
    if (editStatus === 'cammed' && !assertCanCamReview()) return;
    const effectiveStock = editStock === '__other__' ? (editCustomStock || '').trim() : editStock;
    // If the user selected the CAM review pseudo-status, store underlying 'cammed'
    // as the actual status and set router_meta.step = 'cam_review' separately.
    const update = {
      // If user picked the pseudo-status 'cam_review' (CAM Review Ready), keep underlying status as in-progress
      // and set router_meta.step to 'cam_review' below. Previously this stored 'cammed' which caused it to appear
      // immediately as CAM Reviewed; keep it as 'in-progress' instead.
      status: editStatus === 'cam_review' ? 'in-progress' : editStatus,
      workflow: editWorkflow,
      quantity: Math.max(1, Number(editQuantity) || 1),
      notes: (editNotes || '').trim() || null,
      due_date: editDueDate || null,
      updated_at: new Date().toISOString()
    };
    if (effectiveStock) update.stock_assignment = effectiveStock;
    try {
      const { error } = await supabase
        .from('parts')
        .update(update)
        .eq('id', editPart.id);
      if (error) throw error;
      // If the pseudo-status was selected, ensure router_meta step is set
      if (editStatus === 'cam_review') {
        try { await updateRouterMeta(editPart, { step: 'cam_review' }); } catch (e) { console.warn('updateRouterMeta failed:', e); }
      }
      await loadParts();
      showToastMessage('Part updated');
    } catch (e) {
      console.error('saveEdits error:', e);
      alert('Failed to update part: ' + (e.message || e));
    } finally {
      closeEditModal();
    }
  }

  async function deleteCurrentPart() {
    if (!editPart) return;
    if (!await requestConfirmation({ message: 'Delete this part permanently?', confirmLabel: 'Delete part', danger: true })) return;
    try {
      await deletePartsByIds([editPart.id]);
      showToastMessage('Part deleted');
    } catch (e) {
      console.error('deleteCurrentPart error:', e);
      alert('Failed to delete part: ' + (e.message || e));
    } finally {
      closeEditModal();
    }
  }

  async function deletePartsByIds(partIds) {
    const normalizedIds = [...new Set(partIds.map(getNormalizedPartId).filter((id) => id !== null && id !== undefined && id !== ''))];
    if (normalizedIds.length === 0) return;

    try {
      for (const batch of chunkArray(normalizedIds)) {
        const { error: clearErr } = await supabase
          .from('build_bom')
          .update({ parts_id: null, added: false })
          .in('parts_id', batch);
        if (clearErr) throw clearErr;
      }
    } catch (e) {
      console.error('Failed to clear BOM refs before deleting part(s):', e);
      throw new Error('Could not clear BOM references. Remove or unlink those BOM rows first.');
    }

    const { error } = await supabase
      .from('parts')
      .delete()
      .in('id', normalizedIds);

    if (error) throw error;

    selectedPartIds = selectedPartIds.filter((id) => !normalizedIds.map(String).includes(id));
    await loadParts();
  }

  async function bulkDeleteSelected() {
    const idsToDelete = filteredParts
      .filter((part) => selectedPartIds.includes(getPartKey(part)))
      .map((part) => part.id);

    if (idsToDelete.length === 0) return;
    if (!await requestConfirmation({ message: `Delete ${idsToDelete.length} selected part${idsToDelete.length === 1 ? '' : 's'} permanently?`, confirmLabel: 'Delete parts', danger: true })) return;

    try {
      await deletePartsByIds(idsToDelete);
      showToastMessage(`${idsToDelete.length} part${idsToDelete.length === 1 ? '' : 's'} deleted`);
    } catch (e) {
      console.error('bulkDeleteSelected error:', e);
      alert('Failed to delete selected parts: ' + (e.message || e));
    }
  }

  // Reactive statement that filters parts when search term, filters, or parts array changes
  // ToDo tab: hide completed parts
  $: filteredParts = parts.filter(part => {
    const matchesSearch = !searchTerm || 
      part.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      part.requester.toLowerCase().includes(searchTerm.toLowerCase()) ||
      part.project_id.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesWorkflow = !filterWorkflow || part.workflow === filterWorkflow;
    const meta = part.workflow === 'router' ? getRouterMeta(part) : {};
    // Treat CAM Review Ready as a pseudo-status based on router_meta.step
    const matchesStatus = !filterStatus ||
      part.status === filterStatus ||
      (filterStatus === 'cam_review' && meta.step === 'cam_review');
    const matchesProject = !filterProject || part.project_id === filterProject;
    const notCompleted = !isPartFullyCompleted(part);
    const matchesTeam = passesTeamFilter(part.frc_team, show971, show9584);
    const matchesSeason = passesSeasonFilter(part.created_at, filterSeason);

    return matchesSearch && matchesWorkflow && matchesStatus && matchesProject && notCompleted && matchesTeam && matchesSeason;
  });

  $: filteredPartKeys = filteredParts.map(getPartKey);
  $: selectedFilteredCount = filteredPartKeys.filter((key) => selectedPartIds.includes(key)).length;
  $: allFilteredSelected = filteredPartKeys.length > 0 && selectedFilteredCount === filteredPartKeys.length;

  // Toast notification functions
  function showToastMessage(message, tone = 'neutral') {
    toastMessage = message;
    toastTone = tone;
    showToast = true;
    
    // Auto-hide after 3 seconds
    setTimeout(() => {
      showToast = false;
    }, 3000);
  }

  // SVG download function for laser cutter
  async function downloadSVGForLaser(part) {
    try {
      showToastMessage('Download requested - Converting to SVG...');
      
      // Build the API URL for SVG conversion
      const params = new URLSearchParams({
        action: 'convert-to-svg',
        documentId: part.onshape_document_id,
        elementId: part.onshape_element_id,
        partId: part.onshape_part_id,
        wvm: part.onshape_wvm,
        wvmId: part.onshape_wvmid
      });
      
      const response = await fetch(`/api/onshape?${params}`);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }
      
      // Create blob and download SVG
      const blob = await response.blob();
      const fileName = `${part.name.replace(/[^a-zA-Z0-9]/g, '_')}.svg`;
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      showToastMessage('SVG file downloaded successfully!');
    } catch (error) {
      console.error('Error downloading SVG:', error);
      showToastMessage(`Error downloading SVG: ${error.message}`);
    }
  }
</script>

<svelte:head>
  <title>Parts List - Manufacturing Management</title>
</svelte:head>

<div class="manufacture-page-container">
<div class="page-header">
  <h1>Parts List</h1>
  <div class="page-actions">
    {#if canDelete}
      <button class="btn {batchSelectMode ? 'btn-primary' : 'btn-secondary'}" on:click={toggleBatchSelectMode}>
        <Package size={16} />
        {batchSelectMode ? 'Exit Batch Select' : 'Batch Select'}
      </button>
    {/if}
    {#if canDelete && batchSelectMode && selectedFilteredCount > 0}
      <button class="btn btn-danger" on:click={bulkDeleteSelected}>
        <Trash2 size={16} />
        Delete Selected ({selectedFilteredCount})
      </button>
    {/if}
    {#if canUseAssignMode}
      <button 
        class="btn {assignMode ? 'btn-primary' : 'btn-secondary'}"
        on:click={toggleAssignMode}
      >
        <Users size={16} />
        {assignMode ? 'Exit Assign Mode' : 'Assign Mode'}
      </button>
    {/if}
    <button class="btn btn-primary" on:click={openQuickPrintModal}>
      <Upload size={16} />
      Quick Print Add
    </button>
    <a href="/manufacture/create" class="btn btn-primary page-actions-primary">
      <Upload size={16} />
      Create New Part
    </a>
    <button
      class="btn btn-secondary"
      on:click={exportToCSV}
    >
      <Download size={16} />
      Export CSV
    </button>
  </div>
</div>

<!-- Manufacture Sub-Tabs -->
<div class="subtabs">
  <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
  <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
  <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
  <a href="/manufacture/post-processing" class:active={$page.url.pathname === '/manufacture/post-processing'}>Post Processing</a>
  <a href="/manufacture/bins" class:active={$page.url.pathname === '/manufacture/bins'}>Bins</a>
  <a href="/manufacture/gcode-converter" class:active={$page.url.pathname === '/manufacture/gcode-converter'}>G-code Converter</a>
  <a href="/manufacture/files" class:active={$page.url.pathname === '/manufacture/files'}>Files</a>
</div>

<div class="card">
  <div class="filters" style="--filters-columns: 2fr 1fr 1fr 1fr 1fr;">
    <div class="form-group">
      <label class="form-label">
        <Search size={16} />
        Search
      </label>
      <input
        type="text"
        class="form-input"
        placeholder="Search by name, requester, or project ID..."
        bind:value={searchTerm}
      />
    </div>

    <div class="form-group">
      <label class="form-label">
        <Filter size={16} />
        Workflow
      </label>
      <select class="form-select" bind:value={filterWorkflow}>
        <option value="">All Workflows</option>
        {#each workflows as workflow}
          <option value={workflow.value}>{workflow.label}</option>
        {/each}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">
        <Filter size={16} />
        Status
      </label>
      <select class="form-select" bind:value={filterStatus}>
        <option value="">All Statuses</option>
        {#each statuses as status}
          <option value={status.value}>{status.label}</option>
        {/each}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">
        <Filter size={16} />
        Project
      </label>
      <select class="form-select" bind:value={filterProject}>
        <option value="">All Projects</option>
        {#each projectIds as pid}
          <option value={pid}>{pid}</option>
        {/each}
      </select>
    </div>

    <SeasonFilter options={seasonOptions} bind:value={filterSeason} />
  </div>
  <div class="team-filter-row">
    <TeamFilter bind:show971 bind:show9584 />
  </div>
</div>

{#if loading}
  <div class="card">
    <p>Loading parts...</p>
  </div>
{:else if filteredParts.length === 0}
  <div class="card">
    <p>No parts found. {parts.length === 0 ? 'Create your first part!' : 'Try adjusting your filters.'}</p>
  </div>
{:else}
  <div class="content-layout">
    {#if assignMode}
      <aside class="assign-sidebar">
        <h3>Roster</h3>
        <div class="roster-list">
          {#each filteredRosterMembers as member}
            <div 
              class="roster-member" 
              draggable="true" 
              role="button"
              tabindex="0"
              on:dragstart={(e) => handleDragStart(e, member)}
            >
              <div class="member-name">{member.user?.full_name || member.user?.email}</div>
              <div class="member-role">{member.key?.key_name}</div>
            </div>
          {/each}
          {#if filteredRosterMembers.length === 0}
            <p class="text-muted">No members found for this workflow.</p>
          {/if}
        </div>
      </aside>
    {/if}

  <!-- Mobile Card View -->
  <div class="mobile-parts-list">
    {#each filteredParts as part (part.id)}
      {@const fusionJob = part.workflow === 'router' ? fusionJobsByPart[part.id] : null}
      <div
        id="part-{part.id}"
        class="part-card"
        class:deep-link-highlight={highlightedPartId === String(part.id)}
        on:click={(e) => onRowClick(e, part)}
        on:keydown={(e) => onRowKeyDown(e, part)}
        role="button"
        tabindex="0"
      >
        <div class="part-card-header">
          <div class="part-card-title">
            {#if batchSelectMode}
              <input
                class="part-select-checkbox"
                type="checkbox"
                checked={isPartSelected(part)}
                on:click|stopPropagation
                on:change|stopPropagation={() => togglePartSelection(part)}
              />
            {/if}
            <strong>{part.name}</strong>
            {#if isTeam9584(part.frc_team)}
              <span class="tag team-tag tag-9584">9584</span>
            {/if}
            {#if stepFileWarning(part) === 'missing'}
              <span class="tag tag-warning" title="No STEP file uploaded for this router part">⚠ No STEP</span>
            {:else if stepFileWarning(part) === 'invalid'}
              <span class="tag tag-warning" title="The uploaded STEP file failed validation">⚠ Bad STEP</span>
            {/if}
          </div>
          <span class="status-badge {getBadgeClass(part.status, getRouterMeta(part))}">{getStatusDisplay(part)}</span>
        </div>

        {#if assignMode}
          <!-- Touch alternative to the desktop roster sidebar's drag-and-drop
               (handleDrop) - dragging a card onto another card isn't a
               workable gesture on a phone, so assign mode gets its own tap
               picker per part here instead of losing the feature on mobile. -->
          <label class="part-card-assign">
            <span class="detail-label">Assign to</span>
            <select
              class="form-select"
              value={part.assigned_to || ''}
              on:click|stopPropagation
              on:change|stopPropagation={(e) => assignPartByTap(part, e.currentTarget.value)}
            >
              <option value="">Unassigned</option>
              {#each filteredRosterMembers as member}
                <option value={member.user_id}>{member.user?.full_name || member.user?.email}</option>
              {/each}
            </select>
          </label>
        {/if}

        <PartNotes item={part} table="parts" inline on:update={() => loadParts()} />

        <div class="part-card-meta">
          <span class={`tag workflow-tag ${getWorkflowClass(part.workflow)}`}>
            {getWorkflowLabel(part.workflow)}
          </span>
          {#if part.project_id}
            <span class="part-card-project">{part.project_id}</span>
          {/if}
          {#if part.assigned_to}
            <span class="pill pill-soft pill-assigned">
              {assignedUserNames[part.assigned_to] || 'Assigned'}
            </span>
          {/if}
        </div>
        
        <div class="part-card-details">
          <div class="part-card-detail">
            <span class="detail-label">Qty</span>
            <span class="detail-value">{getQuantitySummary(part)}</span>
          </div>
          {#if part.stock_assignment}
            <div class="part-card-detail">
              <span class="detail-label">Stock</span>
              <span class="detail-value">{part.stock_assignment}</span>
            </div>
          {/if}
          <div class="part-card-detail">
            <span class="detail-label">Created</span>
            <span class="detail-value">
              {formatDate(part.created_at)}
              {#if getSeasonBucket(part.created_at)}
                <span class="tag season-tag {getSeasonBucket(part.created_at).isOffseason ? 'tag-offseason' : 'tag-season'}">
                  {getSeasonBucket(part.created_at).label}
                </span>
              {/if}
            </span>
          </div>
          <div class="part-card-detail">
            <span class="detail-label">Due</span>
            <span class="detail-value" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
              <PartDueDate {part} on:update={() => loadParts()} />
            </span>
          </div>
          <div class="part-card-detail">
            <span class="detail-label">Requested By</span>
            <span class="detail-value">{part.requester || '—'}</span>
          </div>
        </div>
        {#if part.workflow === 'router' && getRouterProgressSummary(part)}
          <div class="part-card-progress">{getRouterProgressSummary(part)}</div>
        {/if}
        
        <div class="part-card-actions">
          <!-- Source/Download buttons -->
          {#if part.source_type === 'onshape_api'}
            {#if part.workflow === 'laser-cut'}
              <button class="btn btn-secondary btn-sm" on:click|stopPropagation={() => downloadFile(part, part.status)}>
                <Download size={14} /> SVG
              </button>
            {:else if part.workflow === 'lathe' || part.workflow === 'mill'}
              <button class="btn btn-secondary btn-sm" on:click|stopPropagation={() => openSubsystemDocument(part)}>
                <ExternalLink size={14} /> View
              </button>
            {:else if !canViewCad(part)}
              <button class="btn btn-secondary btn-sm" on:click|stopPropagation={() => (part.workflow === 'router' ? downloadStepFromOnshape(part) : downloadFile(part, part.status))}>
                <Download size={14} /> {part.workflow === 'router' ? 'STEP' : 'File'}
              </button>
            {/if}
          {:else if part.file_name && !canViewCad(part)}
            <button class="btn btn-secondary btn-sm" on:click|stopPropagation={() => downloadFromStorage(part.file_name, part.id)}>
              <Download size={14} /> File
            </button>
          {/if}

          <!-- CAD / Fusion CAM action grid -->
          {#if canViewCad(part)}
            <div class="cad-action-grid" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
              <button class="btn btn-secondary btn-sm" on:click={() => openCadViewer(part)} title="View 3D model">
                <Box size={14} /> View CAD
              </button>
              {#if part.workflow === 'router'}
                <button class="btn btn-secondary btn-sm" on:click|stopPropagation={() => openFusionCamModal(part)} title="Queue this request for Fusion AutoCAM">
                  <Layers size={14} /> AutoCAM
                </button>
              {/if}
              <button class="btn btn-secondary btn-sm" on:click={() => installCadStepFile(part)} title="Download STEP file">
                <Download size={14} /> Install CAD
              </button>
              {#if fusionJob?.status === 'completed' && fusionJob.params?.fusionJobKind !== 'plate:arrange'}
                <button class="btn btn-secondary btn-sm" on:click={() => downloadFusionNcFiles(fusionJob)} title="Download G-code">
                  <Download size={14} /> Install G-code
                </button>
              {/if}
            </div>
            {#if fusionJob}
              {#if ['queued', 'claimed', 'processing'].includes(fusionJob.status)}
                <span class="btn btn-secondary btn-sm fusion-cam-running part-card-fusion-status" title="Fusion CAM is processing this part">
                  <span class="fusion-cam-spinner"></span> {FUSION_JOB_STATUS_LABELS[fusionJob.status] || fusionJob.status}
                </span>
              {:else if fusionJob.status === 'completed'}
                <span class="fusion-cam-completed part-card-fusion-status"><CircleCheck size={14} /> Fusion CAM completed</span>
              {:else if fusionJob.status === 'failed'}
                <button class="fusion-cam-failed part-card-fusion-status" on:click={() => openFusionCamModal(part)} title={fusionJob.errors?.[0] || 'Unknown error'}>Fusion CAM failed - retry AutoCAM</button>
              {/if}
            {/if}
          {:else if part.workflow === 'router' || part.workflow === 'lathe'}
            <button
              class="btn btn-secondary btn-sm"
              on:click|stopPropagation={() => openCamProfileModal(part)}
              title="This part was created before STEP was required for its workflow - attach one to unlock the 3D viewer{part.workflow === 'router' ? ' and Fusion CAM' : ''}"
            >
              <Upload size={14} /> Attach STEP
            </button>
          {/if}

          <!-- Status action buttons -->
          {#if part.status === 'pending'}
            <!-- Start always shows for a pending part regardless of
                 workflow - direct instruction, restoring the plain
                 pending -> in-progress action every workflow used to have.
                 Router additionally gets Review CAM once real Fusion CAM
                 output exists, as its own separate action rather than a
                 replacement for Start. -->
            {#if part.workflow === 'router' && canAdvanceRouterToCamReview(part, fusionJob)}
              <button class="btn btn-secondary btn-sm" on:click|stopPropagation={() => advanceRouterToCamReview(part)}>
                <CircleCheck size={14} /> Review CAM
              </button>
            {/if}
            <button
              class="btn btn-secondary btn-sm"
              on:click|stopPropagation={async () => { await updatePartStatus(part.id, 'in-progress'); setLocalStatus(part.id, 'in-progress'); }}
            >
              <Clock size={14} /> Start
            </button>
          {:else if part.status === 'in-progress'}
            {#if part.workflow === 'router'}
              {#if (!getRouterMeta(part).step || getRouterMeta(part).step === 'cam_ing') && canAdvanceRouterToCamReview(part, fusionJob)}
                <button
                  class="btn btn-primary btn-sm"
                  on:click|stopPropagation={() => advanceRouterToCamReview(part)}
                >
                  <CircleCheck size={14} /> Review CAM
                </button>
              {:else if getRouterMeta(part).step === 'cam_review'}
                {#if canCamReview}
                  <button
                    class="btn btn-primary btn-sm"
                    on:click|stopPropagation={async () => { await updatePartStatus(part.id, 'cammed'); await updateRouterMeta(part, { step: 'cammed' }); setLocalStatus(part.id, 'cammed'); setLocalRouterMeta(part.id, { step: 'cammed' }); }}
                  >
                    {BUTTONS.CAM_REVIEWED}
                  </button>
                {/if}
              {/if}
            {/if}
          {:else if part.status === 'cammed'}
            {#if part.workflow === 'router'}
              <button
                class="btn btn-primary btn-sm"
                on:click|stopPropagation={() => markPartMachined(part)}
              >
                <Wrench size={14} /> Machine
              </button>
            {/if}
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <!-- Desktop Table View -->
  <div class="table-container desktop-table" class:assign-mode={assignMode}>
    <table class="table">
      <thead>
        <tr>
          {#if batchSelectMode}
            <th class="select-col">
              <input type="checkbox" checked={allFilteredSelected} on:change={toggleSelectAllFiltered} aria-label="Select all filtered parts" />
            </th>
          {/if}
          <th class="name-col">Name</th>
          <th class="workflow-col">Workflow</th>
          <th class="project-col mono" class:hidden={assignMode}>Project ID</th>
          <th class="quantity-col" class:hidden={assignMode}>Qty</th>
          <th class="stock-col" class:hidden={assignMode}>Stock</th>
          <th class="metadata-col">Status</th>
          <th class="metadata-col" class:hidden={assignMode}>Due</th>
          <th class="metadata-col" class:hidden={assignMode}>Created</th>
          <th class="requester-col" class:hidden={assignMode}>Requested By</th>
          <th class="actions-table-col" class:hidden={assignMode}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredParts as part (part.id)}
          {@const fusionJob = part.workflow === 'router' ? fusionJobsByPart[part.id] : null}
          <tr
            id="part-{part.id}"
            class="parts-row"
            class:deep-link-highlight={highlightedPartId === String(part.id)}
            on:click={(e) => onRowClick(e, part)}
            on:keydown={(e) => onRowKeyDown(e, part)}
            on:dragover={handleDragOver}
            on:drop={(e) => handleDrop(e, part)}
            role="button"
            tabindex="0"
            class:droppable={assignMode}
          >
            {#if batchSelectMode}
              <td class="select-col">
                <input
                  type="checkbox"
                  checked={isPartSelected(part)}
                  on:click|stopPropagation
                  on:change|stopPropagation={() => togglePartSelection(part)}
                  aria-label={`Select ${part.name}`}
                />
              </td>
            {/if}
            <td class="name-col">
              <div class="name-line">
                <strong>{part.name}</strong>
                {#if isTeam9584(part.frc_team)}
                  <span class="tag team-tag tag-9584" title="Requested by Team 9584">9584</span>
                {/if}
                {#if stepFileWarning(part) === 'missing'}
                  <span class="tag tag-warning" title="No STEP file uploaded for this router part">⚠ No STEP</span>
                {:else if stepFileWarning(part) === 'invalid'}
                  <span class="tag tag-warning" title="The uploaded STEP file failed validation">⚠ Bad STEP</span>
                {/if}
              </div>
              <PartNotes item={part} table="parts" inline on:update={() => loadParts()} />
              {#if part.assigned_to}
                 <span class="assigned-user-badge pill pill-soft pill-assigned">
                   {assignedUserNames[part.assigned_to] || 'Assigned'}
                 </span>
              {/if}
            </td>
            <td class="workflow-col">
              <span class={`tag workflow-tag ${getWorkflowClass(part.workflow)}`}>
                {getWorkflowLabel(part.workflow)}
              </span>
            </td>
            <td class="project-col mono" class:hidden={assignMode}>{part.project_id}</td>
            <td class="quantity-col" class:hidden={assignMode}>{getQuantitySummary(part)}</td>
            <td class="stock-col text-muted" class:hidden={assignMode}>{part.stock_assignment || '-'}</td>
            <td class="metadata-col">
              <div class="metadata-line">
                <span class="status-badge {getBadgeClass(part.status, getRouterMeta(part))} status-table status-fade">{getStatusDisplay(part)}</span>
              </div>
              {#if part.workflow === 'router' && getRouterProgressSummary(part)}
                <div class="metadata-sub router-progress-note">{getRouterProgressSummary(part)}</div>
              {/if}
            </td>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <td class="metadata-col" class:hidden={assignMode} on:click|stopPropagation on:keydown|stopPropagation>
              <div class="metadata-line">
                <PartDueDate {part} on:update={() => loadParts()} />
              </div>
            </td>
            <td class="metadata-col" class:hidden={assignMode}>
              <div class="metadata-line">{formatDate(part.created_at)}</div>
              {#if getSeasonBucket(part.created_at)}
                <div class="metadata-sub">
                  <span class="tag season-tag {getSeasonBucket(part.created_at).isOffseason ? 'tag-offseason' : 'tag-season'}">
                    {getSeasonBucket(part.created_at).label}
                  </span>
                </div>
              {/if}
            </td>
            <td class="requester-col" class:hidden={assignMode} title={part.requester || 'Requester not recorded'}>
              <div class="metadata-line requester-line"><span class="requester-text">{part.requester || '—'}</span></div>
            </td>
            <td class="actions-table-col" class:hidden={assignMode}>
              <div class="row-actions">
                {#if canViewCad(part)}
                  <div class="cad-action-grid" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
                    <button class="btn btn-secondary btn-sm" on:click={() => openCadViewer(part)} title="View 3D model">
                      <Box size={13} /> View CAD
                    </button>
                    {#if part.workflow === 'router'}
                      <button class="btn btn-secondary btn-sm" on:click|stopPropagation={() => openFusionCamModal(part)} title="Queue this request for Fusion AutoCAM">
                        <Layers size={13} /> AutoCAM
                      </button>
                    {/if}
                    <button class="btn btn-secondary btn-sm" on:click={() => installCadStepFile(part)} title="Download STEP file">
                      <Download size={13} /> Install CAD
                    </button>
                    {#if fusionJob?.status === 'completed' && fusionJob.params?.fusionJobKind !== 'plate:arrange'}
                      <button class="btn btn-secondary btn-sm" on:click={() => downloadFusionNcFiles(fusionJob)} title="Download G-code">
                        <Download size={13} /> Install G-code
                      </button>
                    {/if}
                    <!-- Start/Review CAM live inside this grid too (not as
                         separate siblings below, the old layout) so a
                         pending part's action buttons form one even 2-column
                         grid instead of a lopsided stack. See the duplicate
                         block below .row-actions for the !canViewCad(part)
                         case, where there's no grid for this to join. -->
                    {#if part.status === 'pending'}
                      {#if part.workflow === 'router' && canAdvanceRouterToCamReview(part, fusionJob)}
                        <button class="btn btn-secondary btn-sm" on:click={() => advanceRouterToCamReview(part)} title="Review completed Fusion CAM output">
                          <CircleCheck size={13} /> Review CAM
                        </button>
                      {/if}
                      <button
                        class="btn btn-secondary btn-sm"
                        on:click={async () => { await updatePartStatus(part.id, 'in-progress'); setLocalStatus(part.id, 'in-progress'); }}
                        title="Start Work"
                      >
                        <Clock size={13} /> Start
                      </button>
                    {/if}
                  </div>
                  {#if fusionJob}
                    {#if ['queued', 'claimed', 'processing'].includes(fusionJob.status)}
                      <span class="fusion-cam-running" title="Fusion CAM is processing this part">
                        <span class="fusion-cam-spinner"></span> {FUSION_JOB_STATUS_LABELS[fusionJob.status] || fusionJob.status}
                      </span>
                    {:else if fusionJob.status === 'completed'}
                      <span class="fusion-cam-completed"><CircleCheck size={14} /> Fusion CAM completed</span>
                    {:else if fusionJob.status === 'failed'}
                      <button class="fusion-cam-failed" on:click={() => openFusionCamModal(part)} title={fusionJob.errors?.[0] || 'Unknown error'}>Fusion CAM failed - retry AutoCAM</button>
                    {/if}
                  {/if}
                {:else if part.workflow === 'router' || part.workflow === 'lathe'}
                  <button
                    class="btn btn-secondary btn-sm"
                    on:click={() => openCamProfileModal(part)}
                    title="This part was created before STEP was required for its workflow - attach one to unlock the 3D viewer{part.workflow === 'router' ? ' and Fusion CAM' : ''}"
                  >
                    <Upload size={13} /> Attach STEP
                  </button>
                {/if}
              </div>
              {#if part.status === 'pending' && !canViewCad(part)}
                {#if part.workflow === 'router' && canAdvanceRouterToCamReview(part, fusionJob)}
                  <button class="btn btn-secondary btn-sm" on:click={() => advanceRouterToCamReview(part)} title="Review completed Fusion CAM output">
                    <CircleCheck size={13} /> Review CAM
                  </button>
                {/if}
                <button
                  class="btn btn-secondary btn-sm"
                  on:click={async () => { await updatePartStatus(part.id, 'in-progress'); setLocalStatus(part.id, 'in-progress'); }}
                  title="Start Work"
                >
                  <Clock size={13} /> Start
                </button>

              {:else if part.status === 'in-progress'}
                {#if part.workflow === 'router'}
                  <!-- Fusion completion is the only path from CAMing to review. -->
                  {#if (!getRouterMeta(part).step || getRouterMeta(part).step === 'cam_ing') && canAdvanceRouterToCamReview(part, fusionJob)}
                  <div class="actions-col">
                    <button
                      class="btn btn-primary btn-sm"
                      on:click={() => advanceRouterToCamReview(part)}
                      title="Review completed Fusion CAM output"
                    >
                      <CircleCheck size={13} /> Review CAM
                    </button>
                  </div>
              {:else if getRouterMeta(part).step === 'cam_review'}
                  {#if canCamReview}
                    <div class="actions-col">
                      <button
                        class="btn btn-primary btn-sm"
                        on:click={async () => { await updatePartStatus(part.id, 'cammed'); await updateRouterMeta(part, { step: 'cammed' }); setLocalStatus(part.id, 'cammed'); setLocalRouterMeta(part.id, { step: 'cammed' }); }}
                        title={BUTTONS.CAM_REVIEWED}
                      >
                        {BUTTONS.CAM_REVIEWED}
                      </button>
                    </div>
                  {/if}
                  {/if}
                {/if}
              {:else if part.status === 'cammed'}
                {#if part.workflow === 'router'}
                  <div class="actions-col">
                    <button
                      class="btn btn-primary btn-sm"
                      on:click={() => markPartMachined(part)}
                      title="Machine"
                    >
                      <Wrench size={14} />
                      Machine
                    </button>
                  </div>
                {/if}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  </div>
{/if}
</div>

<!-- Edit Part Modal -->
{#if showQuickPrintModal}
  <div
    class="modal-backdrop"
    on:click|self={closeQuickPrintModal}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeQuickPrintModal(); } }}
  >
    <div class="modal quick-print-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>Quick Print Add</h3>
        <button type="button" class="modal-close-button" aria-label="Close dialog" on:click={closeQuickPrintModal}>
          <X size={18} />
        </button>
      </div>
      <div class="modal-body quick-print-body">
        <div class="quick-print-note">
          Upload a STEP file and press add. Material defaults to PETG and subsystem defaults to the one you interacted with most recently, and both can be changed here.
        </div>
        <div class="form-group">
          <label class="form-label" for="quick-print-file">STEP File</label>
          <input id="quick-print-file" class="form-input" type="file" accept=".step,.stp" on:change={handleQuickPrintFileChange} />
          {#if quickPrintFile}
            <div class="file-hint">{quickPrintFile.name}</div>
          {/if}
        </div>
        <div class="form-group">
          <label class="form-label" for="quick-print-name">Part Name</label>
          <input id="quick-print-name" class="form-input" type="text" bind:value={quickPrintPartName} />
        </div>
        <div class="form-group">
          <label class="form-label" for="quick-print-subsystem">Subsystem</label>
          <select id="quick-print-subsystem" class="form-select" bind:value={quickPrintSubsystemId}>
            <option value="" disabled selected={!quickPrintSubsystemId}>Select subsystem</option>
            {#each subsystemOptions as subsystem}
              <option value={subsystem.id}>{subsystem.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="quick-print-material">Material</label>
          <select id="quick-print-material" class="form-select" bind:value={quickPrintMaterial}>
            {#each QUICK_PRINT_STOCK_OPTIONS as stock}
              <option value={stock.description}>{stock.material}</option>
            {/each}
            <option value="__other__">Custom...</option>
          </select>
        </div>
        {#if quickPrintMaterial === '__other__'}
          <div class="form-group">
            <label class="form-label" for="quick-print-custom-material">Custom Material</label>
            <input id="quick-print-custom-material" class="form-input" type="text" placeholder="Enter material or stock" bind:value={quickPrintCustomMaterial} />
          </div>
        {/if}
        <div class="form-group">
          <label class="form-label" for="quick-print-requester">Requester</label>
          <input id="quick-print-requester" class="form-input" type="text" bind:value={quickPrintRequester} />
        </div>
        <div class="form-group">
          <label class="form-label" for="quick-print-quantity">Quantity</label>
          <input id="quick-print-quantity" class="form-input" type="number" min="1" step="1" bind:value={quickPrintQuantity} />
        </div>
      </div>
      <div class="modal-footer">
        <div class="spacer"></div>
        <button class="btn" on:click={closeQuickPrintModal} disabled={quickPrintSubmitting}>Cancel</button>
        <button class="btn btn-primary" on:click={submitQuickPrint} disabled={quickPrintSubmitting || subsystemOptions.length === 0}>
          {quickPrintSubmitting ? 'Adding...' : 'Add'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showEditModal}
  <div
    class="modal-backdrop"
    on:click|self={closeEditModal}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Escape' && e.target === e.currentTarget) { e.preventDefault(); closeEditModal(); } }}
  >
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>Edit Part{editPart ? `: ${editPart.name}` : ''}</h3>
        <button type="button" class="modal-close-button" aria-label="Close dialog" on:click={closeEditModal}>
          <X size={18} />
        </button>
      </div>
      <div class="modal-body">
        <!-- Part Details Section -->
        {#if editPart}
          <div class="part-details-section">
            {#if getOnshapeUrl(editPart)}
              <div class="detail-row">
                <span class="detail-label">Onshape Document:</span>
                <a href={getOnshapeUrl(editPart)} target="_blank" rel="noopener noreferrer" class="onshape-link">
                  <ExternalLink size={14} />
                  Open in Onshape
                </a>
              </div>
            {/if}
            <div class="detail-row">
              <span class="detail-label">Added:</span>
              <span class="detail-value">{formatDateTime(editPart.created_at)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Last Updated:</span>
              <span class="detail-value">{formatDateTime(editPart.updated_at)}</span>
            </div>
          </div>
        {/if}

        <div class="form-group">
          <label class="form-label" for="edit-status">Status</label>
          <select id="edit-status" class="form-select" bind:value={editStatus}>
            {#each editStatusOptions as status}
              <option value={status.value}>{status.label}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-workflow">Workflow</label>
          <select id="edit-workflow" class="form-select" bind:value={editWorkflow}>
            {#each workflows as w}
              <option value={w.value}>{w.label}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-quantity">Quantity</label>
          <input id="edit-quantity" class="form-input" type="number" min="1" step="1" bind:value={editQuantity} />
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-stock">Stock</label>
          <select id="edit-stock" class="form-select" bind:value={editStock}>
            <option value="">—</option>
            {#each editStockOptions as s}
              <option value={s}>{s}</option>
            {/each}
            <option value="__other__">Custom...</option>
          </select>
        </div>
        {#if editStock === '__other__'}
        <div class="form-group">
          <input class="form-input" type="text" placeholder="Custom stock" bind:value={editCustomStock} />
        </div>
        {/if}
        <div class="form-group">
          <label class="form-label" for="edit-due-date">Due Date</label>
          <input id="edit-due-date" class="form-input" type="date" bind:value={editDueDate} />
        </div>
        <div class="form-group form-group-full">
          <label class="form-label" for="edit-notes">Notes</label>
          <textarea id="edit-notes" class="form-input" rows="4" bind:value={editNotes} placeholder="Add notes for this part (context, machining notes, blockers...)"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        {#if canDeletePart(editPart)}
          <button class="btn btn-danger" on:click={deleteCurrentPart}>
            <Trash2 size={16} />
            Delete
          </button>
        {/if}
        <div class="spacer"></div>
        <button class="btn" on:click={closeEditModal}>Cancel</button>
        <button class="btn btn-primary" on:click={saveEdits}>Save</button>
      </div>
    </div>
  </div>
{/if}

<!-- Part Preview Modal -->
{#if showPreviewModal}
  <div
    class="modal-backdrop"
    on:click|self={closePreviewModal}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closePreviewModal(); } }}
  >
    <div class="modal preview-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>{previewPart?.name || 'Part Preview'}</h3>
        <button type="button" class="modal-close-button" aria-label="Close dialog" on:click={closePreviewModal}>
          <X size={18} />
        </button>
      </div>
      <div class="modal-body preview-modal-body">
        <div class="preview-image-container">
          {#if previewLoading}
            <div class="preview-loading">
              <div class="spinner"></div>
              <span>Loading preview...</span>
            </div>
          {:else if previewError}
            <div class="preview-error">
              <span>⚠️ {previewError}</span>
            </div>
          {:else if previewImage}
            <img src={previewImage} alt="Isometric view of {previewPart?.name}" class="preview-image" />
          {/if}
        </div>
        
        {#if previewPart}
          <!-- Part Info -->
          <div class="preview-info-section">
            {#if previewPart.quantity}
              <div class="preview-info-item">
                <span class="preview-label">Quantity:</span>
                <span class="preview-value">{previewPart.quantity}</span>
              </div>
            {/if}
            {#if previewPart.project_id}
              <div class="preview-info-item">
                <span class="preview-label">Project:</span>
                <span class="preview-value mono">{previewPart.project_id}</span>
              </div>
            {/if}
            {#if getOnshapeUrl(previewPart)}
              <div class="preview-info-item">
                <a href={getOnshapeUrl(previewPart)} target="_blank" rel="noopener noreferrer" class="onshape-link">
                  <ExternalLink size={14} />
                  Open in Onshape
                </a>
              </div>
            {/if}
          </div>

          <!-- Edit Fields -->
          <div class="preview-edit-section">
            <div class="form-group">
              <label class="form-label" for="preview-status">Status</label>
              <select id="preview-status" class="form-select" bind:value={previewStatus}>
                {#each previewStatusOptions as status}
                  <option value={status.value}>{status.label}</option>
                {/each}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="preview-workflow">Workflow</label>
              <select id="preview-workflow" class="form-select" bind:value={previewWorkflow}>
                {#each workflows as w}
                  <option value={w.value}>{w.label}</option>
                {/each}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="preview-quantity">Quantity</label>
              <input id="preview-quantity" class="form-input" type="number" min="1" step="1" bind:value={previewQuantity} />
            </div>
            <div class="form-group">
              <label class="form-label" for="preview-stock">Stock</label>
              <select id="preview-stock" class="form-select" bind:value={previewStock}>
                <option value="">—</option>
                {#each previewStockOptions as s}
                  <option value={s}>{s}</option>
                {/each}
                <option value="__other__">Custom...</option>
              </select>
            </div>
            {#if previewStock === '__other__'}
            <div class="form-group">
              <input class="form-input" type="text" placeholder="Custom stock" bind:value={previewCustomStock} />
            </div>
            {/if}
            <div class="form-group">
              <label class="form-label" for="preview-due-date">Due Date</label>
              <input id="preview-due-date" class="form-input" type="date" bind:value={previewDueDate} />
            </div>
            <div class="form-group form-group-full">
              <label class="form-label" for="preview-notes">Notes</label>
              <textarea id="preview-notes" class="form-input" rows="4" bind:value={previewNotes} placeholder="Add notes for this part (context, machining notes, blockers...)"></textarea>
            </div>
          </div>
        {/if}
      </div>
      <div class="modal-footer">
        {#if canDeletePart(previewPart)}
          <button class="btn btn-danger" on:click={deletePreviewPart}>
            <Trash2 size={16} />
            Delete
          </button>
        {/if}
        <div class="spacer"></div>
        <button class="btn" on:click={closePreviewModal}>Cancel</button>
        <button class="btn btn-primary" on:click={savePreviewEdits}>Save</button>
      </div>
    </div>
  </div>
{/if}

<!-- CAD 3D Viewer Modal -->
{#if showCadModal && cadViewerPart}
  <div
    class="modal-backdrop"
    on:click|self={closeCadViewer}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeCadViewer(); } }}
  >
    <div class="modal cad-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>{cadViewerPart.name || '3D Model'}</h3>
        <div class="cad-modal-header-actions">
          {#if getStepFileName(cadViewerPart)}
            <button type="button" class="cad-download-btn" aria-label="Download STEP file" title="Download STEP file" on:click={() => downloadFromStorage(getStepFileName(cadViewerPart), cadViewerPart.id)}>
              <Download size={18} />
            </button>
          {/if}
          {#if cadViewerPart.workflow === 'router' && fusionJobsByPart[cadViewerPart.id]?.status === 'completed' && fusionJobsByPart[cadViewerPart.id]?.params?.fusionJobKind !== 'plate:arrange'}
            <button type="button" class="cad-download-btn" aria-label="Download G-code" title="Download G-code" on:click={() => downloadFusionNcFiles(fusionJobsByPart[cadViewerPart.id])}>
              <Zap size={18} />
            </button>
          {/if}
          <button type="button" class="modal-close-button" aria-label="Close dialog" on:click={closeCadViewer}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div class="modal-body">
        <CadViewer part={cadViewerPart} stepFileName={getStepFileName(cadViewerPart)} />
        <p class="cad-modal-hint">Drag to rotate · scroll to zoom · right-drag to pan</p>
      </div>
    </div>
  </div>
{/if}

{#if showCamProfileModal && camProfileModalPart}
  <div
    class="modal-backdrop"
    on:click|self={closeCamProfileModal}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeCamProfileModal(); } }}
  >
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>Attach STEP File - {camProfileModalPart.name}</h3>
        <button type="button" class="modal-close-button" aria-label="Close dialog" on:click={closeCamProfileModal}>
          <X size={18} />
        </button>
      </div>
      <div class="modal-body">
        <p class="cad-modal-hint">
          This part was created before a STEP file was required for its workflow. Attach one now to unlock the 3D viewer{camProfileModalPart.workflow === 'router' ? ' and Fusion CAM' : ''}.
          {#if camProfileModalPart.workflow === 'lathe'}
            Model it with the spindle axis along the STEP file's Z axis, centered at X=0, Y=0.
          {/if}
        </p>
        <input
          type="file"
          class="form-input"
          accept=".step,.stp"
          on:change={(e) => { camProfileFile = e.target.files?.[0] || null; }}
        />
        <button
          class="btn btn-primary"
          style="margin-top: 1rem;"
          disabled={!camProfileFile || queuingCamJobForPartId === camProfileModalPart.id}
          on:click={submitCamProfile}
        >
          {queuingCamJobForPartId === camProfileModalPart.id ? 'Attaching…' : 'Attach STEP'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if fusionQueuePart}
  <div class="modal-backdrop" role="button" tabindex="0" on:click|self={closeFusionCamModal} on:keydown={(event) => { if (event.key === 'Escape') closeFusionCamModal(); }}>
    <section class="modal cam-setup-modal" role="dialog" aria-modal="true" aria-labelledby="fusion-queue-title">
      <div class="modal-header">
        <h3 id="fusion-queue-title">Send to Fusion AutoCAM - {fusionQueuePart.name}</h3>
        <button type="button" class="modal-close-button" aria-label="Close dialog" on:click={closeFusionCamModal}><X size={18} /></button>
      </div>
      <div class="modal-body">
        {#if fusionQueueLoading}
          <p class="text-muted">Loading Fusion CAM options...</p>
        {:else}
          <div class="form-group">
            <span class="form-label">Stock type</span>
            <div class="cam-target-choice">
              <button type="button" class:active={fusionQueueKind === 'plate'} on:click={() => selectFusionQueueKind('plate')}>Plate part</button>
              <button type="button" class:active={fusionQueueKind === 'tube'} on:click={() => selectFusionQueueKind('tube')}>Tube stock</button>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="manufacture-fusion-quantity">Quantity</label>
              <input id="manufacture-fusion-quantity" class="form-input" type="number" min="1" step="1" bind:value={fusionQueueQuantity} />
            </div>
            {#if fusionQueueKind === 'plate'}
              <div class="form-group">
                <label class="form-label" for="manufacture-fusion-category">Material / Thickness</label>
                <select id="manufacture-fusion-category" class="form-select" bind:value={fusionQueueCategoryId}>
                  <option value="">Choose a stock category...</option>
                  {#each fusionQueueCategories as category}<option value={category.id}>{fusionQueueCategoryLabel(category)}</option>{/each}
                </select>
              </div>
            {:else}
              <div class="form-group">
                <label class="form-label" for="manufacture-fusion-material">Material</label>
                <select id="manufacture-fusion-material" class="form-select" bind:value={fusionQueueMaterialId}>
                  <option value="">Choose an aluminum material...</option>
                  {#each fusionQueueMaterials.filter((material) => /alumin(?:um|ium)/i.test(material.name || '')) as material}<option value={material.id}>{material.name}</option>{/each}
                </select>
              </div>
            {/if}
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="manufacture-fusion-router">Router</label>
              <select id="manufacture-fusion-router" class="form-select" value={fusionQueueMachineId} on:change={(event) => selectFusionQueueMachine(event.currentTarget.value)}>
                <option value="">Choose a router...</option>
                {#each fusionQueueMachines.filter((machine) => fusionQueueKind === 'tube' ? machine.can_run_box_tubes : machine.can_run_plates) as machine}<option value={machine.id}>{machine.name}</option>{/each}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="manufacture-fusion-tool">Tool</label>
              <select id="manufacture-fusion-tool" class="form-select" bind:value={fusionQueueToolId} disabled={!fusionQueueMachineId}>
                <option value="">{fusionQueueTools(fusionQueueMachineId).length ? 'Choose a tool...' : 'No tools installed on this router'}</option>
                {#each fusionQueueTools(fusionQueueMachineId) as tool}<option value={tool.id}>{fusionQueueToolLabel(tool)}</option>{/each}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="manufacture-fusion-file-name">Fusion file name</label>
            <input id="manufacture-fusion-file-name" class="form-input" value={fusionQueueFileName} on:input={(event) => (fusionQueueFileName = event.currentTarget.value.replace(/\s+/g, ''))} />
          </div>
          <div class="form-group">
            <span class="form-label">Save to folder</span>
            {#if fusionQueueFolderTree?.tree}
              <div class="folder-tree-box"><FolderTreeNode node={fusionQueueFolderTree.tree} selectedPath={fusionQueueFolderPath} onSelect={(path) => (fusionQueueFolderPath = path)} /></div>
            {:else}
              <p class="cam-form-hint">Using the default AutoCAM folder. A Fusion Runner will publish folder choices after its next folder sync.</p>
            {/if}
          </div>
        {/if}
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" disabled={fusionQueueLoading || !!queuingCamJobForPartId} on:click={closeFusionCamModal}>Cancel</button>
        <button type="button" class="btn btn-primary" disabled={fusionQueueLoading || !!queuingCamJobForPartId} on:click={submitFusionCamModal}><Layers size={16} /> {queuingCamJobForPartId ? 'Queueing...' : 'Queue CAM Job'}</button>
      </div>
    </section>
  </div>
{/if}

<!-- Toast Notification -->
{#if showToast}
  <div class="toast toast-{toastTone}" role="status">
    {toastMessage}
  </div>
{/if}

<style>
  /* No hover effects on the manufacture tab (dense buttons + table rows).
     Use theme tokens so rows flip correctly in dark mode. Ruled hairlines
     only — no zebra striping, matching the rest of the app's tables. */
  .btn:hover { box-shadow: none; }
  .table tr { background: var(--surface-1); }
  .table tbody tr:hover { background: var(--surface-1); }

  .fusion-cam-running {
    background: var(--purple-soft);
    color: var(--purple-strong);
    border-color: var(--purple-soft);
    cursor: default;
  }

  .fusion-cam-completed {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--green-strong, #237a41);
    font-size: var(--font-xs, 0.75rem);
    font-weight: 600;
  }

  .part-card-fusion-status {
    flex-basis: 100%;
  }

  .fusion-cam-failed {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--danger, #e05252);
    font-size: var(--font-xs, 0.75rem);
    font-weight: 600;
  }

  .fusion-cam-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid color-mix(in srgb, var(--purple-strong) 30%, transparent);
    border-top-color: var(--purple-strong);
    border-radius: 50%;
    animation: fusion-cam-spin 0.7s linear infinite;
  }

  @keyframes fusion-cam-spin { to { transform: rotate(360deg); } }

  .cad-action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.35rem;
    width: 100%;
    min-width: 0;
  }
  .cad-action-grid .btn {
    min-width: 0;
    justify-content: center;
    text-align: center;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.2;
    font-size: var(--font-xs, 0.75rem);
    padding: 0.35rem 0.45rem;
    /* app.css's base .btn pins a fixed `height: var(--btn-height)`. These
       buttons deliberately wrap instead (white-space: normal above), and a
       label that wraps to two lines - "Open Fusion CAM" is the one that
       actually does at this column width - is taller than that fixed
       height, so the text rendered outside the button's own background
       rather than growing it. Height has to become a minimum for wrapping
       to work at all; without this the wrap settings above have nothing to
       grow into. */
    height: auto;
    min-height: var(--btn-height);
  }

  .deep-link-highlight {
    animation: deep-link-flash 2.5s ease-out 1;
  }
  @keyframes deep-link-flash {
    0%, 15% { box-shadow: 0 0 0 2px var(--purple-strong); background: var(--purple-soft); }
    100% { box-shadow: 0 0 0 0 transparent; }
  }

  .cad-modal-header-actions { display: inline-flex; align-items: center; gap: 0.25rem; }
  .cad-download-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.25rem;
    border-radius: var(--radius-sm, 4px);
    color: var(--accent-strong, #1d4ed8);
    cursor: pointer;
  }
  .cad-download-btn:hover { background: var(--surface-2, #f3f4f6); }

  .manufacture-page-container {
    /* No cap of its own - the page shell already sets the shared width.
       This used to be 1400px, narrower than the 1440px shell around it,
       which made manufacture the tightest tab in the app and is why long
       part names ran out of room first. */
    width: 100%;
    margin: 0 auto;
  }

  .select-col {
    width: 40px;
    text-align: center;
  }

  .table th.name-col,
  .table td.name-col {
    /* The largest share - part names are the longest real content here and
       were the first thing to run out of room. */
    width: 17%;
    /* Part names wrap onto a second line rather than being cut off with
       an ellipsis - a truncated "P006950_Rev_x60 stiffn..." hides exactly
       the part of the name that distinguishes it from its neighbours.
       overflow-wrap: anywhere (not break-word) because these names are
       one long token with no spaces to break at. */
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .table {
    table-layout: fixed;
    /* Fills the container and shares it out proportionally, rather than
       being sized to the sum of fixed column widths. Those fixed widths
       added up to ~1690px, so anything narrower than a very wide monitor
       had to scroll sideways to reach the Actions column. Proportional
       columns keep the same relative layout at every width and simply get
       tighter, which is far better than hiding controls off-screen. */
    width: 100%;
    margin: 0 auto;
  }
  .table th.workflow-col,
  .table td.workflow-col {
    width: 7.5%;
  }
  .table th.project-col,
  .table td.project-col {
    width: 6.5%;
  }
  .table th.quantity-col,
  .table td.quantity-col {
    width: 3%;
    text-align: center;
  }
  .table th.stock-col,
  .table td.stock-col {
    /* Real values are full stock descriptions ('1/8" Polycarbonate Sheet'). */
    width: 9%;
  }
  /* Status, Due, and Created all share this width so the three columns
     stay horizontally even with equal spacing - sized to the longest real
     content across the three ("CAM Review Pending" measures ~160px
     rendered), not just Status's own longest label. */
  .table th.metadata-col,
  .table td.metadata-col {
    width: 11.5%;
    /* Centred, like every other column in the row (app.css's .table td
       default). These four were the only cells pinned to the top, so on a
       tall row - one with the full CAD action grid - Status, Due and
       Created floated up against the top edge while the part name, workflow
       tag and stock beside them sat centred. */
    vertical-align: middle;
    position: relative;
    /* .metadata-line below centers the badge/date/text inside the cell -
       the header label needs the same text-align or it sits at the base
       .table th default (left) while its column's real content sits
       centered underneath, reading as misaligned. Same fix quantity-col
       already has for its own centered content. */
    text-align: center;
  }
  /* One shared first line for Status / Due / Created / Requested By. A
     pill badge, a date input and plain text all have different intrinsic
     box heights, so left to themselves they each sit at a different
     vertical position even in cells that are all vertical-align: top.
     Giving each one the same fixed-height line box and centering inside
     it puts all four on the same horizontal level. */
  .metadata-line {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--control-height);
    width: 100%;
  }
  .requester-line {
    justify-content: flex-start;
  }
  .requester-text {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Keep the date/status and their secondary badge as one in-flow stack.
     The table cell's vertical-align: middle then centres the whole group,
     instead of absolutely positioning the badge against the bottom edge. */
  .metadata-col .metadata-sub {
    margin-top: 0.3rem;
    display: flex;
    justify-content: center;
    /* Keeps the season tag off the column edge so it never reads as though
       it belongs to the neighbouring column's controls. */
    padding: 0 0.35rem;
    box-sizing: border-box;
  }
  /* Keep the date field compact and centred within Due. A full-width native
     date control visually spills into the Created column on wide screens. */
  .metadata-col :global(.due-date) { width: auto; max-width: 100%; }
  .metadata-col :global(.due-input) {
    box-sizing: border-box;
    width: min(10.75rem, 100%);
  }
  .table th.requester-col,
  .table td.requester-col {
    width: 7.5%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Centred with the rest of the row. This was pinned to the top back
       when each of these cells rendered a differently-sized box and top
       alignment was the only thing keeping them level with each other;
       they now share one fixed-height line box (.metadata-line), so they
       stay level with each other AND with the row. */
    vertical-align: middle;
  }
  .table th.actions-table-col,
  .table td.actions-table-col {
    box-sizing: border-box;
    position: sticky;
    right: 0;
    width: 15%;
    box-shadow: -1px 0 0 var(--border);
  }
  .table thead th.actions-table-col {
    /* Match the rest of the header bar (.table thead th's own
       var(--background)) instead of the body's sticky-cover shade below -
       otherwise Actions reads as a different color than Name/Workflow/etc
       on the header row. */
    background: var(--background);
    z-index: 3;
  }
  .table tbody td.actions-table-col {
    /* Opaque cover so scrolled-under cell content doesn't show through
       this sticky column in the body rows - the header has no scrolled
       content beneath it, so it doesn't need this. */
    background: var(--surface-1);
    z-index: 2;
  }

  .name-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem 0.4rem;
  }

  .notes-indicator {
    display: inline-flex;
    align-items: center;
    color: var(--brand-gold-strong, #8f5f00);
    cursor: help;
  }

  .form-group-full {
    grid-column: 1 / -1;
  }

  .form-group-full textarea.form-input {
    width: 100%;
    height: auto;
    min-height: 90px;
    line-height: 1.45;
    padding: 0.5rem 0.6rem;
    resize: vertical;
    font-family: inherit;
  }

  .version-text {
    font-size: 0.75rem;
    color: var(--neutral-500);
  }


  .actions-col {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 110px;
  }

  /* Start/Review CAM now render as grid items inside .cad-action-grid
     itself (see the table row markup) instead of as a separate sibling
     below it, so a pending part's buttons form one even 2x2 grid instead
     of the CAD grid and a lopsided extra button stacking underneath it. */
  .table .row-actions {
    align-items: flex-start;
    column-gap: var(--gap-2);
    row-gap: var(--space-3);
  }

  .quick-print-modal {
    max-width: 560px;
  }

  .quick-print-body {
    display: grid;
    gap: 1rem;
  }

  .quick-print-note {
    color: var(--neutral-600);
    line-height: 1.4;
  }

  .file-hint {
    margin-top: 0.35rem;
    color: var(--neutral-600);
    font-size: 0.9rem;
  }

  .kitting-inline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .kitting-input {
    min-width: 120px;
    margin: 0;
    box-sizing: border-box;
  }

  .status-badge.status-table {
    display: inline-flex;
    align-items: center;
    min-width: 80px;
    border: 1px solid var(--border);
    box-sizing: border-box;
    vertical-align: middle;
    overflow: hidden;
    white-space: nowrap;
    background: transparent;
    color: var(--secondary);
  }

  /* No per-status colours here. This block used to restate the entire
     nine-hue palette (and a second modern-dark copy of it) purely because
     these .status-table selectors outrank the global ones - a fourth and
     fifth place the same colours had to be kept in sync. The shared palette
     in app.css now covers every state in every theme, so this list view
     just inherits it. */

  .parts-row {
    cursor: pointer;
    /* A compact floor; in-flow metadata and action content can grow it. */
    height: 6rem;
  }

  .assigned-user-badge {
    display: inline-flex;
    margin-top: 0.3rem;
  }

  :global(.btn-icon svg) {
    width: 16px;
    height: 16px;
  }

  :global(.actions-col .btn svg), :global(.kitting-inline .btn svg) { width: 18px; height: 18px; }
  .file-input-hidden { display: none; }
  .table thead th { background: var(--background); color: var(--text); font-weight: 600; border-bottom: none; }

  .content-layout { display: flex; gap: 1rem; align-items: flex-start; }
  .assign-sidebar { width: 250px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 4px; padding: 1rem; position: sticky; top: 1rem; max-height: calc(100vh - 2rem); display: flex; flex-direction: column; gap: 0.5rem; overflow: hidden; overscroll-behavior: contain; flex-shrink: 0; }
  .assign-sidebar h3 { margin-top: 0; margin-bottom: 1rem; font-size: 1.1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  .roster-list { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; min-height: 0; overflow-y: auto; max-height: calc(100vh - 6rem); overscroll-behavior: contain; padding-right: 0.25rem; }
  .roster-member { background: var(--surface-2); border: 1px solid var(--border); padding: 0.5rem; border-radius: 4px; cursor: grab; user-select: none; }
  .roster-member:active { cursor: grabbing; }
  .member-name { font-weight: 500; }
  .member-role { font-size: 0.8rem; color: var(--text-muted); }
  .table-container.assign-mode { flex: 1; }
  .hidden { display: none !important; }
  tr.droppable { transition: background-color 0.2s; }
  tr.droppable:hover { background-color: var(--surface-2); }

  /* Part Details Section in Edit Modal */
  .part-details-section {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .part-details-section .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .part-details-section .detail-row:last-child {
    border-bottom: none;
  }

  .part-details-section .detail-label {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .part-details-section .detail-value {
    font-size: 0.85rem;
    color: var(--text);
  }

  .onshape-link {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    color: var(--primary);
    font-size: 0.85rem;
    font-weight: 500;
    text-decoration: none;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--primary-soft, rgba(0, 102, 204, 0.1));
    transition: background 0.2s, color 0.2s;
  }

  .onshape-link:hover {
    background: var(--primary);
    color: white;
  }

  /* Toast notification */
  .toast {
    position: fixed;
    bottom: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    background: var(--secondary);
    color: var(--primary);
    padding: var(--space-3) var(--space-6);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    z-index: 1000;
    animation: toast-fade 3s ease forwards;
  }
  .toast-success { background: var(--green-strong, #237a41); color: white; }
  .toast-error { background: var(--red-strong, #b4232e); color: white; }
  @keyframes toast-fade {
    0%, 78% { opacity: 1; }
    100% { opacity: 0; }
  }

  /* Mobile Responsive Styles */
  
  /* Mobile Parts Card List - Hidden on desktop */
  .mobile-parts-list {
    display: none;
  }
  
  .part-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    margin-bottom: var(--space-3);
    cursor: pointer;
    transition: box-shadow 0.2s, border-color 0.2s;
  }
  
  .part-card:hover {
    border-color: var(--primary);
    box-shadow: var(--shadow-md);
  }
  
  .part-card:active {
    background: var(--surface-2);
  }
  
  .part-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--gap-3);
    margin-bottom: var(--space-3);
  }
  
  .part-card-title {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }
  
  .part-card-title strong {
    font-size: 1rem;
    color: var(--secondary);
    word-break: break-word;
  }
  
  .part-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    margin-bottom: var(--space-3);
  }
  
  .part-card-project {
    font-size: var(--font-xs);
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  
  .part-card-details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: var(--gap-3);
    padding: var(--space-3);
    background: var(--background);
    border-radius: var(--radius-sm);
    margin-bottom: var(--space-3);
  }
  
  .part-card-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .detail-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  
  .detail-value {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text);
  }
  
  .part-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .part-card-progress,
  .router-progress-note {
    margin-top: 0.35rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .part-select-checkbox {
    margin: 0;
    flex-shrink: 0;
  }

  .part-card-assign {
    display: grid;
    gap: 0.25rem;
    margin-bottom: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--accent-subtle, rgba(34, 197, 94, 0.08));
    border: 1px solid var(--accent, currentColor);
    border-radius: var(--radius-sm);
  }

  .part-card-assign select {
    width: 100%;
  }

  .part-card-actions .btn {
    flex: 1 1 auto;
    min-width: 80px;
    justify-content: center;
  }

  .part-card-actions .cad-action-grid .btn {
    min-width: 0;
  }

  @media (max-width: 900px) {
    .actions-col { min-width: auto; }
    .table th.name-col, .table td.name-col { min-width: 80px; max-width: 100px; }
    .cam-setup-grid { grid-template-columns: 1fr; }
    
    .content-layout {
      flex-direction: column;
    }
    
    .assign-sidebar {
      width: 100%;
      position: static;
      max-height: none;
    }
    
    .roster-list {
      max-height: 200px;
    }
  }

  @media (max-width: 768px) {
    .manufacture-page-container {
      padding: 0;
    }

    /* Hide desktop table, show mobile cards */
    .desktop-table {
      display: none;
    }

    .mobile-parts-list {
      display: block;
    }

    /* The roster sidebar's assignment gesture is drag-and-drop, which isn't
       workable on a touch screen - each part-card gets its own "Assign to"
       select instead (see .part-card-assign / assignPartByTap above), so
       the sidebar itself would just be dead weight here. */
    .assign-sidebar {
      display: none;
    }

    .page-header {
      padding: var(--space-3);
    }

    .page-header h1 {
      font-size: 1.25rem;
    }

    /* A 1-column stack of 6 buttons pushed every part below the fold on a
       phone. Two columns halves that, and the primary action (Create New
       Part) is pulled to the top and spans both columns via `order` so it
       reads as the one thing most people came here to do, regardless of
       where it sits in the desktop button row's own DOM order. */
    .page-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--gap-2);
      width: 100%;
    }

    .page-actions .btn {
      width: 100%;
      justify-content: center;
    }

    .page-actions .page-actions-primary {
      grid-column: 1 / -1;
      order: -1;
    }
  }

  @media (max-width: 480px) {
    .part-card {
      padding: var(--space-3);
    }
    
    .part-card-title strong {
      font-size: 0.9rem;
    }
    
    .part-card-details {
      grid-template-columns: 1fr 1fr;
      padding: var(--space-2);
    }
    
    .part-card-actions .btn {
      font-size: 0.75rem;
      padding: var(--space-2);
    }
    
    .status-badge {
      font-size: 0.65rem;
      padding: var(--space-1) var(--space-2);
    }
  }

  /* Part Preview Modal Styles */
  .preview-modal {
    max-width: 600px;
    width: 95%;
  }

  .preview-modal-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
  }

  .preview-image-container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 350px;
    height: 350px;
    background: var(--background);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .preview-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center;
  }

  .preview-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    color: var(--text-muted);
    padding: var(--space-6);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .preview-error {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
    color: var(--danger);
    text-align: center;
  }

  .preview-info-section {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--surface-1);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }

  .preview-info-item {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .preview-edit-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .preview-details {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-1);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }

  .preview-detail-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-3);
    padding: var(--space-1) 0;
  }

  .preview-detail-row:not(:last-child) {
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--space-2);
  }

  .preview-label {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .preview-value {
    font-size: 0.9rem;
    color: var(--text);
    font-weight: 500;
  }

  .preview-value.mono {
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }

  @media (max-width: 480px) {
    .preview-modal {
      max-width: 100%;
      margin: var(--space-2);
    }

    .preview-image-container {
      min-height: 200px;
      height: 200px;
    }
  }

  .team-filter-row {
    margin-top: var(--space-3, 0.75rem);
    padding-top: var(--space-3, 0.75rem);
    border-top: 1px solid var(--border);
  }

  .view-cad-link {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font-size: var(--font-xs);
    font-weight: 600;
    color: var(--accent-strong, #1d4ed8);
    text-decoration: underline;
    cursor: pointer;
    white-space: nowrap;
  }

  .view-cad-link:hover { opacity: 0.8; }

  .cad-modal {
    width: min(900px, 95vw);
    max-width: 95vw;
  }

  .cad-modal-hint {
    margin: var(--space-2) 0 0 0;
    text-align: center;
    font-size: var(--font-xs);
    color: var(--text-muted);
  }
</style>
