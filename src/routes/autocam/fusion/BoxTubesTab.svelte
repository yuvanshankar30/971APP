<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { fetchBoxTubes, createBoxTube, deleteBoxTube, fetchFusionFolderTree, queueFusionJob } from '$lib/fusionCam.js';
  import FolderTreeNode from './FolderTreeNode.svelte';
  import { Plus, Trash2, Box, Send, X } from 'lucide-svelte';

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
  let newBoxTube = { name: '', epic: '', ticket: '', quantity: 1, manufacturingPartId: '' };
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
  $: aluminumMaterials = materials.filter((material) => /alumin(?:um|ium)/i.test(material.name || ''));

  async function loadManufacturingParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('id, name, project_id, workflow')
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

  export function openQueuePicker() {
    queuePickerOpen = true;
    if (!queuedTubeId) queuedTubeId = boxTubes.find((tube) => tube.step_file_name)?.id || '';
  }

  function closeQueuePicker() {
    queuePickerOpen = false;
    queuedTubeId = '';
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
    try {
      const createdTube = await createBoxTube({
        name: newBoxTube.name,
        epic: newBoxTube.epic,
        ticket: newBoxTube.ticket,
        quantity: Number(newBoxTube.quantity),
        stepFile,
        createdBy: user?.id,
        partId: newBoxTube.manufacturingPartId || null
      });
      newBoxTube = { name: '', epic: '', ticket: '', quantity: 1, manufacturingPartId: '' };
      stepFile = null;
      showAddForm = false;
      await load(false);
      toastActions.show('Tube stock added');
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
      <h3>New Tube Stock</h3>
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
          <label class="form-label" for="bt-step">STEP file</label>
          <input id="bt-step" type="file" accept=".step,.stp" class="form-input" on:change={handleFileChange} />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="bt-manufacturing-link">Manufacturing request (optional)</label>
          <select id="bt-manufacturing-link" class="form-select" bind:value={newBoxTube.manufacturingPartId}>
            <option value="">Not linked to a request</option>
            {#each manufacturingParts as mp}
              <option value={mp.id}>{mp.name}{mp.project_id ? ` (${mp.project_id})` : ''}</option>
            {/each}
          </select>
          <p class="cam-form-hint">Traces this box tube back to the real request it's for - leave unlinked for ad-hoc stock.</p>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" disabled={submitting} on:click={handleAdd}>{submitting ? 'Adding...' : 'Add Tube Stock'}</button>
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
            <strong><Box size={16} /> {boxTube.name}</strong>
            <span class="tag">Qty {boxTube.quantity}</span>
          </div>
          <p class="cam-form-hint">
            {#if boxTube.epic}{boxTube.epic}{/if}
            {#if boxTube.ticket} - {boxTube.ticket}{/if}
            {#if !boxTube.step_file_name} - <em>no STEP file attached</em>{/if}
            {#if boxTube.parts} - linked to <strong>{boxTube.parts.name}</strong>{/if}
          </p>
          <div class="cam-list-actions">
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
                  <option value="">{toolsForMachine(boxTubeMachineSelections[tube.id]).length ? 'Choose a tool...' : 'No tools installed on this router'}</option>
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
  .form-row .form-group { flex: 1; min-width: 160px; }
  .form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .cam-list-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
  .queue-modal { max-width: 32rem; }
  .queue-picker-modal { --modal-width: 46rem; }
  .folder-tree-box {
    max-height: 16rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem;
  }
</style>
