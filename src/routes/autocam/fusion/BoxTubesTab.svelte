<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { fetchBoxTubes, createBoxTube, deleteBoxTube, queueFusionJob } from '$lib/fusionCam.js';
  import { Plus, Trash2, Box, Send } from 'lucide-svelte';

  export let user;
  export let canManage;

  let boxTubes = [];
  let machines = [];
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
  // PlatesTab.svelte for why silently picking machines[0] is wrong once
  // more than one real router is eligible.
  let boxTubeMachineSelections = {};
  let boxTubeToolSelections = {};
  // machine_id -> cam_tools rows actually installed on that machine - see
  // PlatesTab.svelte's matching comment for why (this app's own existing
  // "job creation only offers the tools installed on its machine" rule).
  let machineTools = {};

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

  onMount(load);

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
  }

  function handleFileChange(event) {
    stepFile = event.target.files?.[0] || null;
  }

  async function handleAdd() {
    if (!newBoxTube.name || !newBoxTube.quantity) {
      toastActions.show('Name and quantity are required');
      return;
    }
    submitting = true;
    try {
      await createBoxTube({
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
      toastActions.show('Box tube added');
    } catch (e) {
      toastActions.show(e.message || 'Failed to add box tube');
    } finally {
      submitting = false;
    }
  }

  async function handleDelete(boxTube) {
    if (!await requestConfirmation({ title: 'Delete box tube', message: `Delete box tube "${boxTube.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      await deleteBoxTube(boxTube.id);
      await load(false);
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
    // See PlatesTab.svelte's matching comment - the Runner has no working
    // fallback for an unspecified tool (its auto-select calls an API
    // endpoint that doesn't exist here), so this is required.
    if (!boxTubeToolSelections[boxTube.id]) {
      toastActions.show('Choose a tool before queueing');
      return;
    }
    try {
      await queueFusionJob({
        fusionJobKind: 'box_tube',
        boxTubeId: boxTube.id,
        machineId,
        toolId: boxTubeToolSelections[boxTube.id],
        requestedBy: user?.id,
        name: `Box Tube CAM: ${boxTube.name}`,
        // Traces the resulting cam_jobs row back to the real manufacturing
        // request this box tube is for, if it's linked to one - a clean
        // 1:1 (one box tube per job), unlike a plate's many-parts case.
        partId: boxTube.part_id || null
      });
      toastActions.show('Queued for the Fusion Runner');
    } catch (e) {
      toastActions.show(e.message || 'Failed to queue job');
    }
  }
</script>

{#if loading}
  <p>Loading box tubes...</p>
{:else}
  <div class="tab-actions">
    <button class="btn btn-primary" on:click={() => (showAddForm = !showAddForm)}>
      <Plus size={16} /> Add Box Tube
    </button>
  </div>

  {#if showAddForm}
    <div class="card">
      <h3>New Box Tube</h3>
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
      <button class="btn btn-primary" disabled={submitting} on:click={handleAdd}>{submitting ? 'Adding...' : 'Add Box Tube'}</button>
    </div>
  {/if}

  {#if boxTubes.length === 0}
    <p class="empty-state">No box tubes yet. Add one above.</p>
  {:else}
    <div class="cam-list">
      {#each boxTubes as boxTube}
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
            <select class="form-select router-select" value={boxTubeMachineSelections[boxTube.id]} on:change={(e) => handleMachineChange(boxTube, e.currentTarget.value)} aria-label="Router for {boxTube.name}">
              <option value={undefined}>Choose a router...</option>
              {#each machines as m}
                <option value={m.id}>{m.name}</option>
              {/each}
            </select>
            <select class="form-select router-select" bind:value={boxTubeToolSelections[boxTube.id]} aria-label="Tool for {boxTube.name}" disabled={!boxTubeMachineSelections[boxTube.id]}>
              <option value="">{toolsForMachine(boxTubeMachineSelections[boxTube.id]).length ? 'Choose a tool...' : 'No tools installed on this router'}</option>
              {#each toolsForMachine(boxTubeMachineSelections[boxTube.id]) as t}
                <option value={t.id}>{toolLabel(t)}</option>
              {/each}
            </select>
            <button class="btn btn-secondary btn-sm" disabled={!boxTubeMachineSelections[boxTube.id] || !boxTubeToolSelections[boxTube.id]} on:click={() => handleQueue(boxTube)}>
              <Send size={14} /> Queue CAM Job
            </button>
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

<style>
  .tab-actions { margin-bottom: 1rem; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-row .form-group { flex: 1; min-width: 160px; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .cam-list-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .router-select { width: auto; min-width: 160px; height: var(--control-height, 2.25rem); }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
</style>
