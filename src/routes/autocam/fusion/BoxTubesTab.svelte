<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount, tick } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import {
    fetchBoxTubes, createBoxTube, deleteBoxTube, renameBoxTube, updateBoxTubeQuantity,
    fetchFusionFolderTree, installFusionPartCad, queueFusionJob
  } from '$lib/fusionCam.js';
  import { formatPacificDateTime } from '$lib/timezone.js';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import FolderTreeNode from './FolderTreeNode.svelte';
  import { Plus, Trash2, Box, Send, X, Pencil, Check, Download } from 'lucide-svelte';

  export let user;
  export let canManage;

  let boxTubes = [];
  let machines = [];
  let materials = [];
  // Real manufacturing requests this box tube can optionally be linked to -
  // see PartsTab.svelte's matching field for the full reasoning.
  let manufacturingParts = [];
  let loading = true;
  let showAddForm = false;
  // True when this form was opened from the page-level "Quick Queue"
  // button (see openQuickQueue below) rather than the normal "Add Tube
  // Stock" button - see PartsTab.svelte's matching flag for the full
  // reasoning.
  let quickQueueMode = false;
  let newBoxTube = { name: '', epic: '', ticket: '', quantity: 1, manufacturingPartId: '', projectId: '', stockAssignment: '' };
  let stepFile = null;
  let submitting = false;
  // Which router each box tube's "Queue CAM Job" currently targets - keyed
  // by box tube id. No default - see the matching comment in
  // PartsTab.svelte for why silently picking machines[0] is wrong once
  // more than one real router is eligible.
  let boxTubeMachineSelections = {};
  let boxTubeToolSelections = {};
  let boxTubeMaterialSelections = {};
  // machine_id -> cam_tools rows actually installed on that machine - see
  // PartsTab.svelte's matching comment for why (this app's own existing
  // "job creation only offers the tools installed on its machine" rule).
  let machineTools = {};
  let queuePickerOpen = false;
  let queuedTubeId = '';
  let folderTreeRow = null;
  let queueModalTube = null;
  let queueFileName = '';
  let queueFolderPath = '';
  let queueSubmitting = false;
  let cadModalTube = null;
  let renamingTubeId = null;
  let renameTubeValue = '';
  let editingQuantityId = null;
  let quantityValue = '';
  // Free-text search over "Recent tube stock" - empty shows the 6 most
  // recent queueable tubes, typing searches every queueable tube by name.
  let recentTubeSearch = '';
  $: aluminumMaterials = materials.filter((material) => /alumin(?:um|ium)/i.test(material.name || ''));
  $: queueableTubesByCreatedAt = [...boxTubes]
    .filter((tube) => tube.step_file_name && Number(tube.quantity) > 0)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  $: recentTubeSearchTerm = recentTubeSearch.trim().toLowerCase();
  $: recentQueueableTubes = recentTubeSearchTerm
    ? queueableTubesByCreatedAt.filter((tube) => tube.name?.toLowerCase().includes(recentTubeSearchTerm))
    : queueableTubesByCreatedAt.slice(0, 6);

  async function loadManufacturingParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('id, name, project_id, workflow, quantity, file_name, file_url, stock_assignment')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.warn('Could not load manufacturing requests to link:', error.message);
      return;
    }
    manufacturingParts = data || [];
  }

  // showLoading=false for refreshes after an action (add/delete/etc.) -
  // flipping loading back to true mid-interaction replaced the whole list
  // with a loading state and back, a jarring flash for what should be a
  // quiet re-fetch. Only the initial mount needs it.
  async function load(showLoading = true) {
    if (showLoading) loading = true;
    try {
      boxTubes = await fetchBoxTubes();
      const { data: machineRows } = await supabase.from('cam_machines').select('*').eq('can_run_box_tubes', true).eq('enabled', true).order('name');
      machines = machineRows || [];
      const { data: materialRows } = await supabase.from('cam_materials').select('id, name, enabled').eq('enabled', true).order('name');
      materials = materialRows || [];
      const { data: machineToolRows } = await supabase
        .from('cam_machine_tools')
        .select('machine_id, cam_tools(id, name, diameter, tool_type)')
        .in('machine_id', machines.map((m) => m.id));
      machineTools = {};
      for (const row of machineToolRows || []) {
        if (!row.cam_tools) continue;
        (machineTools[row.machine_id] ||= []).push(row.cam_tools);
      }
      await loadManufacturingParts();
    } catch (e) {
      toastActions.show(e.message || 'Failed to load box tubes');
    } finally {
      loading = false;
    }
  }

  async function loadFolderTree() {
    try {
      folderTreeRow = await fetchFusionFolderTree();
    } catch (error) {
      // A Runner may not have published its folder index yet. The default
      // AutoCAM folder remains a valid destination in that case.
      console.warn('Could not load Fusion folder tree:', error.message);
    }
  }

  onMount(() => {
    load();
    loadFolderTree();
  });

  function toolsForMachine(machineId) {
    return machineId ? machineTools[machineId] || [] : [];
  }

  function toolLabel(tool) {
    return `${tool.name}${tool.diameter ? ` (${tool.diameter}")` : ''}`;
  }

  function handleMachineChange(boxTube, machineId) {
    boxTubeMachineSelections = { ...boxTubeMachineSelections, [boxTube.id]: machineId };
    const eligible = toolsForMachine(machineId);
    const machine = machines.find((m) => String(m.id) === String(machineId));
    const stillValid = eligible.some((t) => String(t.id) === String(boxTubeToolSelections[boxTube.id]));
    if (!stillValid) {
      const defaultTool = eligible.find((t) => String(t.id) === String(machine?.default_tool_id));
      boxTubeToolSelections = { ...boxTubeToolSelections, [boxTube.id]: defaultTool?.id || '' };
    }
    const defaultMaterial = aluminumMaterials.find((material) => String(material.id) === String(machine?.default_material_id));
    if (!boxTubeMaterialSelections[boxTube.id] && defaultMaterial) {
      boxTubeMaterialSelections = { ...boxTubeMaterialSelections, [boxTube.id]: defaultMaterial.id };
    }
  }

  function handleFileChange(event) {
    stepFile = event.target.files?.[0] || null;
  }

  async function handleManufacturingLinkChange() {
    const linked = manufacturingParts.find((part) => part.id === newBoxTube.manufacturingPartId);
    if (!linked) return;
    newBoxTube = { ...newBoxTube, name: linked.name || newBoxTube.name, quantity: Number(linked.quantity) || newBoxTube.quantity, projectId: linked.project_id || '', stockAssignment: linked.stock_assignment || '' };
    let stepPath = null;
    try { stepPath = JSON.parse(linked.file_url || '{}')?.step_file; } catch {}
    stepPath ||= linked.file_name && /\.(step|stp)$/i.test(linked.file_name) ? linked.file_name : null;
    if (!stepPath) return;
    try {
      const { data, error } = await supabase.storage.from('manufacturing-files').download(stepPath);
      if (error || !data) throw error || new Error('Empty download');
      stepFile = new File([data], stepPath.split('/').pop(), { type: data.type || 'application/step' });
    } catch (error) {
      toastActions.show(error.message || 'Could not load the linked request STEP file');
    }
  }

  function cancelAdd() {
    newBoxTube = { name: '', epic: '', ticket: '', quantity: 1, manufacturingPartId: '', projectId: '', stockAssignment: '' };
    stepFile = null;
    showAddForm = false;
    quickQueueMode = false;
  }

  export function openQueuePicker() {
    queuePickerOpen = true;
    if (!queuedTubeId) queuedTubeId = boxTubes.find((tube) => tube.step_file_name)?.id || '';
    recentTubeSearch = '';
  }

  // Called externally via bind:this from +page.svelte's "Quick Queue"
  // button, after the user has already chosen "Tube" there.
  export function openQuickQueue() {
    quickQueueMode = true;
    showAddForm = true;
  }

  function closeQueuePicker() {
    queuePickerOpen = false;
    queuedTubeId = '';
    recentTubeSearch = '';
  }

  function selectRecentTube(tube) {
    queuedTubeId = tube.id;
  }

  async function queueTubeCam(boxTube, machineId, toolId, materialId, fusionFileName, fusionFolderPath) {
    await queueFusionJob({
      fusionJobKind: 'box_tube',
      boxTubeId: boxTube.id,
      machineId,
      toolId,
      materialId,
      fusionFileName: fusionFileName || null,
      fusionFolderPath: fusionFolderPath || null,
      requestedBy: user?.id,
      name: `Tube Stock CAM: ${boxTube.name}`,
      // This is intentionally a clean 1:1 link. Tube stock is linear,
      // never plate-nested, and has no grouping mode.
      partId: boxTube.part_id || null
    });
  }

  async function handleAdd() {
    if (!newBoxTube.name || !newBoxTube.quantity) {
      toastActions.show('Name and quantity are required');
      return;
    }
    submitting = true;
    const wasQuickQueue = quickQueueMode;
    try {
      const createdTube = await createBoxTube({
        name: newBoxTube.name,
        epic: newBoxTube.epic,
        ticket: newBoxTube.ticket,
        quantity: Number(newBoxTube.quantity),
        stepFile,
        createdBy: user?.id,
        partId: newBoxTube.manufacturingPartId || null,
        projectId: newBoxTube.projectId || null,
        stockAssignment: newBoxTube.stockAssignment || null
      });
      newBoxTube = { name: '', epic: '', ticket: '', quantity: 1, manufacturingPartId: '', projectId: '', stockAssignment: '' };
      stepFile = null;
      showAddForm = false;
      quickQueueMode = false;
      await load(false);
      if (wasQuickQueue && createdTube) {
        await tick();
        openQueuePicker();
        selectRecentTube(createdTube);
        toastActions.show('Tube stock added - choose a router and tool to queue it');
      } else {
        toastActions.show('Tube stock added');
      }
    } catch (e) {
      toastActions.show(e.message || 'Failed to add tube stock');
    } finally {
      submitting = false;
    }
  }

  async function handleDelete(boxTube) {
    if (!await requestConfirmation({ title: 'Delete box tube', message: `Delete box tube "${boxTube.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      await deleteBoxTube(boxTube.id);
      // Splice locally instead of re-fetching everything just to drop one
      // row - see PartsTab.svelte's matching comment.
      boxTubes = boxTubes.filter((b) => b.id !== boxTube.id);
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete box tube');
    }
  }

  function startRenameTube(boxTube) {
    renamingTubeId = boxTube.id;
    renameTubeValue = boxTube.name;
  }

  function cancelRenameTube() {
    renamingTubeId = null;
    renameTubeValue = '';
  }

  async function saveRenameTube(boxTube) {
    try {
      const updated = await renameBoxTube(boxTube.id, renameTubeValue);
      boxTubes = boxTubes.map((tube) => tube.id === boxTube.id ? updated : tube);
      cancelRenameTube();
    } catch (error) {
      toastActions.show(error.message || 'Failed to rename tube stock');
    }
  }

  function startEditQuantity(boxTube) {
    editingQuantityId = boxTube.id;
    quantityValue = String(boxTube.quantity);
  }

  function cancelEditQuantity() {
    editingQuantityId = null;
    quantityValue = '';
  }

  async function saveQuantity(boxTube) {
    const quantity = Number(quantityValue);
    if (!Number.isInteger(quantity) || quantity < 0) {
      toastActions.show('Quantity must be a whole number, zero or more');
      return;
    }
    try {
      const updated = await updateBoxTubeQuantity(boxTube.id, quantity);
      boxTubes = boxTubes.map((tube) => tube.id === boxTube.id ? updated : tube);
      cancelEditQuantity();
    } catch (error) {
      toastActions.show(error.message || 'Failed to update tube quantity');
    }
  }

  async function handleInstallCad(boxTube) {
    try {
      const url = await installFusionPartCad(boxTube.step_file_name);
      window.open(url, '_blank');
    } catch (error) {
      toastActions.show(error.message || 'Failed to download STEP file');
    }
  }

  async function handleQueue(boxTube) {
    if (!boxTube.step_file_name) {
      toastActions.show('This box tube has no STEP file attached - add one before queuing');
      return;
    }
    const machineId = boxTubeMachineSelections[boxTube.id];
    if (!machineId) {
      toastActions.show('Choose a router before queueing');
      return;
    }
    // See PartsTab.svelte's matching comment - the Runner has no working
    // fallback for an unspecified tool (its auto-select calls an API
    // endpoint that doesn't exist here), so this is required.
    if (!boxTubeToolSelections[boxTube.id]) {
      toastActions.show('Choose a tool before queueing');
      return;
    }
    const materialId = boxTubeMaterialSelections[boxTube.id];
    if (!aluminumMaterials.some((material) => String(material.id) === String(materialId))) {
      toastActions.show('Choose an aluminum material before queueing tube CAM');
      return;
    }
    queueModalTube = boxTube;
    queueFileName = boxTube.name.replace(/\s+/g, '');
    queueFolderPath = '';
    closeQueuePicker();
  }

  function closeQueueModal() {
    if (queueSubmitting) return;
    queueModalTube = null;
    queueFileName = '';
    queueFolderPath = '';
  }

  async function confirmQueue() {
    if (!queueModalTube) return;
    const machineId = boxTubeMachineSelections[queueModalTube.id];
    const toolId = boxTubeToolSelections[queueModalTube.id];
    const materialId = boxTubeMaterialSelections[queueModalTube.id];
    queueSubmitting = true;
    try {
      await queueTubeCam(queueModalTube, machineId, toolId, materialId, queueFileName, queueFolderPath);
      toastActions.show('Queued for the Fusion Runner');
      queueModalTube = null;
      queueFileName = '';
      queueFolderPath = '';
    } catch (e) {
      toastActions.show(e.message || 'Failed to queue job');
    } finally {
      queueSubmitting = false;
    }
  }
</script>

{#if loading}
  <p>Loading box tubes...</p>
{:else}
  {#if canManage}
  <div class="tab-actions">
    <button class="btn btn-primary" on:click={() => (showAddForm = !showAddForm)}>
      <Plus size={16} /> Add Tube Stock
    </button>
  </div>

  {/if}
  {#if showAddForm && canManage}
    <div class="card">
      <div class="cam-list-header">
        <h3>{quickQueueMode ? 'Quick Queue: New Tube Stock' : 'New Tube Stock'}</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" aria-label="Close without adding tube stock" on:click={cancelAdd}><X size={16} /></button>
      </div>
      <p class="cam-form-hint">
        {quickQueueMode
          ? 'Fill this in, then choose a router and tool on the next screen to queue it right away.'
          : 'A named quantity of tube stock waiting to be sent to Fusion CAM.'}
      </p>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="bt-name">Name</label>
          <input id="bt-name" class="form-input" bind:value={newBoxTube.name} placeholder="e.g. Drivebase Rail" />
        </div>
        <div class="form-group">
          <label class="form-label" for="bt-quantity">Quantity</label>
          <input id="bt-quantity" type="number" min="1" class="form-input" bind:value={newBoxTube.quantity} />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="bt-epic">Epic (optional)</label>
          <input id="bt-epic" class="form-input" bind:value={newBoxTube.epic} />
        </div>
        <div class="form-group">
          <label class="form-label" for="bt-ticket">Ticket (optional)</label>
          <input id="bt-ticket" class="form-input" bind:value={newBoxTube.ticket} />
        </div>
        <div class="form-group">
          <label class="form-label" for="bt-manufacturing-link">Manufacturing request (optional)</label>
          <select id="bt-manufacturing-link" class="form-select" bind:value={newBoxTube.manufacturingPartId} on:change={handleManufacturingLinkChange}>
            <option value="">Not linked to a request</option>
            {#each manufacturingParts as mp}
              <option value={mp.id}>{mp.name}{mp.project_id ? ` (${mp.project_id})` : ''}</option>
            {/each}
          </select>
          <p class="cam-form-hint">Traces this box tube back to the real request it's for - leave unlinked for ad-hoc stock.</p>
        </div>
      </div>
      <div class="form-row form-row-final">
        <div class="form-group">
          <label class="form-label" for="bt-project-id">Project ID (optional)</label>
          <input id="bt-project-id" class="form-input" list="tube-project-ids" bind:value={newBoxTube.projectId} />
          <datalist id="tube-project-ids">{#each [...new Set(manufacturingParts.map((part) => part.project_id).filter(Boolean))].sort() as projectId}<option value={projectId} />{/each}</datalist>
        </div>
        <div class="form-group">
          <label class="form-label" for="bt-step">STEP file</label>
          <input id="bt-step" type="file" accept=".step,.stp" class="form-input" on:change={handleFileChange} />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" disabled={submitting} on:click={handleAdd}>{submitting ? 'Adding...' : (quickQueueMode ? 'Add & Continue to Queue' : 'Add Tube Stock')}</button>
        <button type="button" class="btn btn-secondary" disabled={submitting} on:click={cancelAdd}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if boxTubes.length === 0}
    <p class="empty-state">No box tubes yet. Add one above.</p>
  {:else}
    <div class="cam-list">
      {#each boxTubes as boxTube (boxTube.id)}
        <div class="card cam-list-item">
          <div class="cam-list-header">
            {#if renamingTubeId === boxTube.id}
              <span class="rename-control">
                <Box size={16} />
                <input
                  class="form-input rename-input"
                  bind:value={renameTubeValue}
                  on:keydown={(event) => { if (event.key === 'Enter') saveRenameTube(boxTube); if (event.key === 'Escape') cancelRenameTube(); }}
                />
                <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveRenameTube(boxTube)}><Check size={14} /></button>
                <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelRenameTube}><X size={14} /></button>
              </span>
            {:else}
              <span class="rename-control">
                <strong><Box size={16} /> {boxTube.name}</strong>
                {#if canManage}
                  <button type="button" class="btn btn-ghost btn-sm" title="Rename" on:click={() => startRenameTube(boxTube)}><Pencil size={13} /></button>
                {/if}
              </span>
            {/if}
            <span class="tag">ALUMINUM TUBE</span>
          </div>
          <p class="cam-form-hint">
            {#if editingQuantityId === boxTube.id}
              <span class="rename-control quantity-control">
                Quantity:
                <input
                  type="number"
                  min="0"
                  step="1"
                  class="form-input rename-input quantity-input"
                  bind:value={quantityValue}
                  on:keydown={(event) => { if (event.key === 'Enter') saveQuantity(boxTube); if (event.key === 'Escape') cancelEditQuantity(); }}
                />
                <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveQuantity(boxTube)}><Check size={14} /></button>
                <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelEditQuantity}><X size={14} /></button>
              </span>
            {:else}
              <span class="rename-control quantity-control">
                Quantity: {boxTube.quantity}
                {#if canManage}
                  <button type="button" class="btn btn-ghost btn-sm" title="Edit quantity" on:click={() => startEditQuantity(boxTube)}><Pencil size={13} /></button>
                {/if}
              </span>
            {/if}
            {#if boxTube.epic}{boxTube.epic}{/if}
            {#if boxTube.ticket} - {boxTube.ticket}{/if}
            {#if boxTube.project_id} - project <strong>{boxTube.project_id}</strong>{/if}
            {#if boxTube.stock_assignment} - stock <strong>{boxTube.stock_assignment}</strong>{/if}
            {#if !boxTube.step_file_name} - <em>no STEP file attached</em>{/if}
            {#if boxTube.parts} - linked to <strong>{boxTube.parts.name}</strong>{/if}
            {#if boxTube.created_at} - added {formatPacificDateTime(boxTube.created_at)}{/if}
          </p>
          <div class="cam-list-actions">
            {#if boxTube.step_file_name}
              <button class="btn btn-secondary btn-sm" on:click={() => (cadModalTube = boxTube)}>
                <Box size={14} /> View CAD
              </button>
              <button class="btn btn-secondary btn-sm" on:click={() => handleInstallCad(boxTube)}>
                <Download size={14} /> Install CAD
              </button>
            {/if}
            {#if canManage}
              <button class="btn btn-ghost btn-sm" on:click={() => handleDelete(boxTube)}>
                <Trash2 size={14} /> Delete
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}

{#if cadModalTube}
  <div class="modal-backdrop" on:click|self={() => (cadModalTube = null)} role="button" tabindex="0"
       on:keydown={(event) => { if (event.key === 'Escape') cadModalTube = null; }}>
    <div class="modal cad-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>CAD Preview - {cadModalTube.name}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={() => (cadModalTube = null)}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <CadViewer part={null} stepFileName={cadModalTube.step_file_name} />
        <p class="cam-form-hint">Drag to rotate &middot; scroll to zoom &middot; right-drag to pan</p>
      </div>
    </div>
  </div>
{/if}

{#if canManage && queuePickerOpen}
  <div class="modal-overlay" role="presentation" on:click={closeQueuePicker}>
    <div class="modal queue-picker-modal" role="dialog" aria-labelledby="tube-queue-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="tube-queue-title">Send Tube Stock to Fusion CAM</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueuePicker}>×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="tube-queue-part">Tube stock</label>
            <select id="tube-queue-part" class="form-select" bind:value={queuedTubeId}>
              <option value="">Choose tube stock...</option>
              {#each boxTubes.filter((tube) => tube.step_file_name) as tube}
                <option value={tube.id}>{tube.name} (Qty {tube.quantity})</option>
              {/each}
            </select>
          </div>
        </div>
        {#if queueableTubesByCreatedAt.length}
          <div class="recent-queue-picker">
            <div class="recent-queue-header">
              <span class="form-label">{recentTubeSearchTerm ? 'Search results' : 'Recent tube stock'}</span>
              <input
                type="search"
                class="form-input recent-queue-search"
                placeholder="Search tube stock by name..."
                bind:value={recentTubeSearch}
                aria-label="Search recent tube stock by name"
              />
            </div>
            {#if recentQueueableTubes.length}
              <div class="recent-queue-grid">
                {#each recentQueueableTubes as tube}
                  <button type="button" class="recent-queue-button" title={tube.name} on:click={() => selectRecentTube(tube)}>
                    <span class="recent-queue-name">{tube.name}</span>
                    <span class="recent-queue-detail">Qty {tube.quantity}</span>
                  </button>
                {/each}
              </div>
            {:else}
              <p class="cam-form-hint">No tube stock matches "{recentTubeSearch}".</p>
            {/if}
          </div>
        {/if}
        {#if queuedTubeId}
          {@const tube = boxTubes.find((item) => item.id === queuedTubeId)}
          {#if tube}
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="tube-queue-router">Router</label>
                <select id="tube-queue-router" class="form-select" value={boxTubeMachineSelections[tube.id]} on:change={(e) => handleMachineChange(tube, e.currentTarget.value)}>
                  <option value="">Choose a router...</option>
                  {#each machines as machine}<option value={machine.id}>{machine.name}</option>{/each}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="tube-queue-tool">Tool</label>
                <select id="tube-queue-tool" class="form-select" bind:value={boxTubeToolSelections[tube.id]} disabled={!boxTubeMachineSelections[tube.id]}>
                  <option value="">{toolsForMachine(boxTubeMachineSelections[tube.id]).length ? 'Choose a tool...' : 'No tools installed'}</option>
                  {#each toolsForMachine(boxTubeMachineSelections[tube.id]) as tool}<option value={tool.id}>{toolLabel(tool)}</option>{/each}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="tube-queue-material">Material</label>
                <select id="tube-queue-material" class="form-select" bind:value={boxTubeMaterialSelections[tube.id]}>
                  <option value="">Choose a material...</option>
                  {#each aluminumMaterials as material}<option value={material.id}>{material.name}</option>{/each}
                </select>
              </div>
            </div>
          {/if}
        {/if}
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeQueuePicker}>Cancel</button>
        {#if queuedTubeId}
          {@const tube = boxTubes.find((item) => item.id === queuedTubeId)}
          <button class="btn btn-primary" type="button" disabled={!tube || !boxTubeMachineSelections[tube.id] || !boxTubeToolSelections[tube.id] || !aluminumMaterials.some((material) => String(material.id) === String(boxTubeMaterialSelections[tube.id]))} on:click={() => handleQueue(tube)}><Send size={14} /> Queue CAM Job</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if queueModalTube}
  <div class="modal-overlay" role="presentation" on:click={closeQueueModal}>
    <div class="modal queue-modal" role="dialog" aria-labelledby="tube-queue-modal-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="tube-queue-modal-title">Queue "{queueModalTube.name}"</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueueModal}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <p class="cam-form-hint">This saves a new Fusion document for the tube job. Name it and pick where it goes - both default to something reasonable if you skip them.</p>
        <div class="form-group">
          <label class="form-label" for="tube-queue-file-name">Fusion file name</label>
          <input
            id="tube-queue-file-name"
            class="form-input"
            value={queueFileName}
            on:input={(event) => (queueFileName = event.currentTarget.value.replace(/\s+/g, ''))}
            placeholder="e.g. DrivebaseRail"
          />
          <p class="cam-form-hint">No spaces - this becomes the saved document's name in Fusion's Data Panel.</p>
        </div>
        <div class="form-group">
          <span class="form-label">Save to folder</span>
          {#if folderTreeRow?.tree}
            <div class="folder-tree-box">
              <FolderTreeNode node={folderTreeRow.tree} selectedPath={queueFolderPath} onSelect={(path) => (queueFolderPath = path)} />
            </div>
            <p class="cam-form-hint">
              {queueFolderPath ? `Selected: ${queueFolderPath}` : "Using the default AutoCAM folder - click a folder above to save somewhere else."}
              Folder list as of {new Date(folderTreeRow.synced_at).toLocaleString()}.
            </p>
          {:else}
            <p class="cam-form-hint">No folder list yet - a Fusion Runner needs to have run at least once to share it. This will save to the default AutoCAM folder.</p>
          {/if}
        </div>
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeQueueModal}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={queueSubmitting} on:click={confirmQueue}>
          <Send size={14} /> {queueSubmitting ? 'Queueing...' : 'Queue Job'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tab-actions { margin-bottom: 1rem; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-row-final { padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .form-row .form-group { flex: 1; min-width: 160px; }
  .form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .rename-control { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .rename-input { padding: 0.2rem 0.4rem; height: auto; width: auto; min-width: 10rem; }
  .quantity-control { display: inline-flex; }
  .quantity-input { min-width: 4rem; width: 4rem; }
  .cam-list-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
  .queue-modal { max-width: 32rem; }
  .cad-modal { width: min(900px, 94vw); }
  .cad-modal .modal-body { min-height: 60vh; }
  .queue-picker-modal { --modal-width: 46rem; }
  .recent-queue-picker { margin: 0.75rem 0; }
  .recent-queue-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
  .recent-queue-search { max-width: 220px; height: 2rem; padding: 0.25rem 0.5rem; font-size: 0.8rem; }
  .recent-queue-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.45rem; }
  .recent-queue-button {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
    min-height: 3.6rem;
    padding: 0.5rem 0.6rem;
    text-align: left;
    color: var(--text);
    background: var(--surface-2, #f7f7f5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
  }
  .recent-queue-button:hover, .recent-queue-button:focus-visible { border-color: var(--accent); background: var(--surface); outline: none; }
  .recent-queue-name, .recent-queue-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-queue-name { font-weight: 600; font-size: 0.8rem; }
  .recent-queue-detail { color: var(--text-muted); font-size: 0.72rem; }
  @media (max-width: 640px) { .recent-queue-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .folder-tree-box {
    max-height: 16rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem;
  }
</style>
