<script>
  import { eligiblePlateParts, platePartQuantity } from '$autocam/fusion/grouping.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { fetchPlates, createPlate, deletePlate, renamePlate, fetchPartCategories, fetchParts, assignPartToPlate, removePartFromPlate, queueFusionJob, fetchFusionFolderTree } from '$lib/fusionCam.js';
  import { Plus, Trash2, Layers, Send, Pencil, Check, X } from 'lucide-svelte';
  import FolderTreeNode from './FolderTreeNode.svelte';

  export let user;
  export let canManage;
  export let categoryFilter = '';
  $: visiblePlates = categoryFilter ? plates.filter((plate) => String(plate.category_id) === String(categoryFilter)) : plates;

  let plates = [];
  let parts = [];
  let categories = [];
  let machines = [];
  let loading = true;
  let showAddForm = false;
  let newPlate = { name: '', width: '', length: '', trueDepth: '', categoryId: '' };
  let renamingPlateId = null;
  let renameValue = '';
  // Which router each plate's "Queue CAM Job" is currently set to send the
  // job to - keyed by plate id, one router picked per row. No default: with
  // more than one real router now eligible (can_run_plates), silently
  // picking machines[0] means whichever router happens to sort first gets
  // every job regardless of which one it was actually meant for - a human
  // has to choose explicitly.
  let plateMachineSelections = {};
  let queueing = {};
  let plateToolSelections = {};
  let plateQueueModes = {};
  let plateSinglePartSelections = {};
  let plateGroupedPartSelections = {};
  let platePartSelections = {};
  let platePartQuantities = {};
  // machine_id -> cam_tools rows actually installed on that machine
  // (cam_machine_tools) - "job creation only offers the tools installed on
  // its machine" is this app's own existing convention (see the main
  // /autocam page's tool picker), not a new rule invented here.
  let machineTools = {};

  // Fusion filename + folder picker, shown as a confirmation step right
  // before a job actually queues. folderTreeRow is the cached Data Panel
  // tree (see fetchFusionFolderTree) - null until a Runner has synced at
  // least once, in which case the modal just falls back to the server's
  // own default folder with a note explaining why there's no tree to pick
  // from yet.
  let folderTreeRow = null;
  let queueModalPlate = null;
  let queueFileName = '';
  let queueFolderPath = '';
  let queueSubmitting = false;

  async function loadFolderTree() {
    try {
      folderTreeRow = await fetchFusionFolderTree();
    } catch (e) {
      console.warn('Could not load Fusion folder tree:', e.message);
    }
  }

  // showLoading=false for refreshes after an action (add/delete/nest/etc.) -
  // flipping loading back to true mid-interaction replaced the whole list
  // with a loading state and back, a jarring flash/"weird animation" for
  // what should be a quiet re-fetch. Only the initial mount needs it.
  async function load(showLoading = true) {
    if (showLoading) loading = true;
    try {
      [plates, categories, parts] = await Promise.all([fetchPlates(), fetchPartCategories(), fetchParts()]);
      platePartQuantities = Object.fromEntries(plates.map((plate) => [plate.id, platePartQuantities[plate.id] || 1]));
      plateGroupedPartSelections = Object.fromEntries(plates.map((plate) => {
        const nestedIds = new Set((plate.fusion_part_category_assignments || []).map((assignment) => assignment.fusion_parts?.id));
        return [plate.id, (plateGroupedPartSelections[plate.id] || []).filter((partId) => nestedIds.has(partId))];
      }));
      plateSinglePartSelections = Object.fromEntries(plates.map((plate) => {
        const nestedIds = new Set((plate.fusion_part_category_assignments || []).map((assignment) => assignment.fusion_parts?.id));
        const selected = plateSinglePartSelections[plate.id];
        return [plate.id, nestedIds.has(selected) ? selected : ''];
      }));
      const { data: machineRows } = await supabase.from('cam_machines').select('*').eq('can_run_plates', true).eq('enabled', true).order('name');
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
    } catch (e) {
      toastActions.show(e.message || 'Failed to load plates');
    } finally {
      loading = false;
    }
  }

  function toolsForMachine(machineId) {
    return machineId ? machineTools[machineId] || [] : [];
  }

  function toolLabel(tool) {
    return `${tool.name}${tool.diameter ? ` (${tool.diameter}")` : ''}`;
  }

  // Picking a router pre-selects that machine's default tool (if it's
  // actually installed on it) rather than leaving the tool blank - same
  // "profile picks reasonable defaults, human can still override" pattern
  // applyMachineDefaults() uses on the main /autocam page. Clears the
  // selection if the previous tool isn't valid for the newly-picked router.
  function handleMachineChange(plate, machineId) {
    plateMachineSelections = { ...plateMachineSelections, [plate.id]: machineId };
    const eligible = toolsForMachine(machineId);
    const machine = machines.find((m) => String(m.id) === String(machineId));
    const stillValid = eligible.some((t) => String(t.id) === String(plateToolSelections[plate.id]));
    if (!stillValid) {
      const defaultTool = eligible.find((t) => String(t.id) === String(machine?.default_tool_id));
      plateToolSelections = { ...plateToolSelections, [plate.id]: defaultTool?.id || '' };
    }
  }

  onMount(() => {
    load();
    loadFolderTree();
  });

  async function handleAdd() {
    if (!newPlate.name || !newPlate.width || !newPlate.length || !newPlate.trueDepth || !newPlate.categoryId) {
      toastActions.show('Fill in every field');
      return;
    }
    try {
      await createPlate({
        name: newPlate.name,
        width: Number(newPlate.width),
        length: Number(newPlate.length),
        trueDepth: Number(newPlate.trueDepth),
        categoryId: newPlate.categoryId
      });
      newPlate = { name: '', width: '', length: '', trueDepth: '', categoryId: '' };
      showAddForm = false;
      await load(false);
      toastActions.show('Plate added');
    } catch (e) {
      toastActions.show(e.message || 'Failed to add plate');
    }
  }

  async function handleDelete(plate) {
    if (!await requestConfirmation({ title: 'Delete plate', message: `Delete plate "${plate.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      await deletePlate(plate.id);
      // Splice locally instead of re-fetching everything (categories,
      // parts, machines, machineTools included) just to drop one row - a
      // real report: even with load()'s loading-flash fix, a full re-fetch
      // still visibly "reloaded" the list on every delete.
      plates = plates.filter((p) => p.id !== plate.id);
      parts = await fetchParts();
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete plate');
    }
  }

  function startRename(plate) {
    renamingPlateId = plate.id;
    renameValue = plate.name;
  }

  function cancelRename() {
    renamingPlateId = null;
    renameValue = '';
  }

  async function saveRename(plate) {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      toastActions.show('Name cannot be empty');
      return;
    }
    if (trimmed === plate.name) {
      cancelRename();
      return;
    }
    try {
      const updated = await renamePlate(plate.id, trimmed);
      plates = plates.map((p) => (p.id === plate.id ? { ...p, ...updated } : p));
      cancelRename();
    } catch (e) {
      toastActions.show(e.message || 'Failed to rename plate');
    }
  }

  // Everything queueing a job actually needs, checked before the filename/
  // folder confirmation modal even opens - failing fast here (as a toast)
  // reads better than opening the modal only to reject it on confirm.
  function queueValidationError(plate) {
    if (!plateMachineSelections[plate.id]) return 'Choose a router before queueing';
    // The Runner's own fallback (auto-picking a tool when none is given)
    // calls an API endpoint that doesn't exist in this app yet - without
    // an explicit tool, a queued job has no real way to resolve one, so
    // this is required here rather than left optional like machineId
    // originally was before routers were made explicit too.
    if (!plateToolSelections[plate.id]) return 'Choose a tool before queueing';
    const groupingMode = plateQueueModes[plate.id];
    if (!['single', 'grouped'].includes(groupingMode)) return 'Choose single-part or grouped CAM';
    if (groupingMode === 'single' && !plateSinglePartSelections[plate.id]) return 'Choose one nested part for single-part CAM';
    if (groupingMode === 'grouped' && (plateGroupedPartSelections[plate.id] || []).length < 2) return 'Select at least two nested part types for this group';
    return null;
  }

  function openQueueModal(plate) {
    const error = queueValidationError(plate);
    if (error) {
      toastActions.show(error);
      return;
    }
    queueModalPlate = plate;
    queueFileName = (plate.name || '').replace(/\s+/g, '');
    queueFolderPath = '';
  }

  function closeQueueModal() {
    queueModalPlate = null;
  }

  async function confirmQueue() {
    const plate = queueModalPlate;
    if (!plate || queueing[plate.id]) return;
    const error = queueValidationError(plate);
    if (error) {
      toastActions.show(error);
      return;
    }
    const groupingMode = plateQueueModes[plate.id];
    const selectedPartId = groupingMode === 'single' ? plateSinglePartSelections[plate.id] : null;
    const selectedPartIds = groupingMode === 'grouped' ? (plateGroupedPartSelections[plate.id] || []) : null;
    queueSubmitting = true;
    queueing = { ...queueing, [plate.id]: true };
    try {
      await queueFusionJob({
        fusionJobKind: 'plate:cam',
        plateId: plate.id,
        machineId: plateMachineSelections[plate.id],
        // The real cam_materials id, NOT plate.category_id (a
        // fusion_part_categories id) - cam_jobs.material_id has a foreign
        // key straight to cam_materials, so passing the category id here
        // would fail the insert outright with a foreign-key violation any
        // time the plate actually has a valid category.
        materialId: plate.fusion_part_categories?.material_id || null,
        toolId: plateToolSelections[plate.id] || null,
        groupingMode,
        selectedPartId,
        selectedPartIds,
        requestedBy: user?.id,
        name: `${groupingMode === 'grouped' ? 'Grouped Fusion CAM' : 'Fusion CAM'}: ${plate.name}`,
        fusionFileName: queueFileName.trim() || null,
        fusionFolderPath: queueFolderPath || null
      });
      toastActions.show('Queued for the Fusion Runner');
      closeQueueModal();
    } catch (e) {
      toastActions.show(e.message || 'Failed to queue job');
    } finally {
      queueSubmitting = false;
      queueing = { ...queueing, [plate.id]: false };
    }
  }

  function toggleGroupedPart(plateId, partId) {
    const selected = new Set(plateGroupedPartSelections[plateId] || []);
    if (selected.has(partId)) selected.delete(partId);
    else selected.add(partId);
    plateGroupedPartSelections = { ...plateGroupedPartSelections, [plateId]: [...selected] };
  }

  function eligibleParts(plate) {
    return eligiblePlateParts(plate, parts);
  }

  function selectedPart(plate) {
    return parts.find((part) => String(part.id) === String(platePartSelections[plate.id] || ''));
  }

  function maximumNestQuantity(plate, part) {
    return Number(part.quantity) + platePartQuantity(plate, part);
  }

  async function handleNestPart(plate) {
    const part = selectedPart(plate);
    const quantity = Number(platePartQuantities[plate.id]);
    if (!part) {
      toastActions.show('Choose a part to nest');
      return;
    }
    if (String(part.category_id) !== String(plate.category_id) || maximumNestQuantity(plate, part) <= 0) {
      toastActions.show('Choose an available part with the same material and thickness');
      return;
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      toastActions.show('Quantity must be a whole number greater than zero');
      return;
    }
    const maximumQuantity = maximumNestQuantity(plate, part);
    if (quantity > maximumQuantity) {
      toastActions.show(`Only ${maximumQuantity} of ${part.name} can be nested on this plate`);
      return;
    }
    try {
      await assignPartToPlate({ categoryId: part.category_id, plateId: plate.id, partId: part.id, quantity });
      platePartSelections = { ...platePartSelections, [plate.id]: '' };
      platePartQuantities = { ...platePartQuantities, [plate.id]: 1 };
      await load(false);
      toastActions.show(`${quantity}x ${part.name} nested on ${plate.name}`);
    } catch (e) {
      toastActions.show(e.message || 'Failed to nest part');
    }
  }

  async function handleRemoveNestedPart(plate, assignment) {
    const name = assignment.fusion_parts?.name || 'this part';
    if (!await requestConfirmation({ title: 'Remove nested part', message: `Remove ${assignment.quantity}x ${name} from "${plate.name}"?`, confirmLabel: 'Remove', danger: true })) return;
    try {
      await removePartFromPlate({ plateId: plate.id, partId: assignment.fusion_parts?.id });
      await load(false);
      toastActions.show(`${name} removed from ${plate.name}`);
    } catch (e) {
      toastActions.show(e.message || 'Failed to remove nested part');
    }
  }

  function categoryLabel(cat) {
    if (!cat) return 'Unknown';
    const material = cat.cam_materials?.name || 'Material';
    return `${material} - ${cat.thickness}"`;
  }
</script>

{#if loading}
  <p>Loading plates...</p>
{:else}
  {#if canManage}
    <div class="tab-actions">
      <button class="btn btn-primary" on:click={() => (showAddForm = !showAddForm)}>
        <Plus size={16} /> Add Plate
      </button>
    </div>
  {/if}

  {#if showAddForm}
    <div class="card">
      <h3>New Plate</h3>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="plate-name">Name</label>
          <input id="plate-name" class="form-input" bind:value={newPlate.name} placeholder="e.g. 12x24 Polycarb Sheet #3" />
        </div>
        <div class="form-group">
          <label class="form-label" for="plate-category">Material / Thickness</label>
          <select id="plate-category" class="form-select" bind:value={newPlate.categoryId}>
            <option value="">Select...</option>
            {#each categories as cat}
              <option value={cat.id}>{categoryLabel(cat)}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="plate-width">Width (in)</label>
          <input id="plate-width" type="number" step="0.01" class="form-input" bind:value={newPlate.width} />
        </div>
        <div class="form-group">
          <label class="form-label" for="plate-length">Length (in)</label>
          <input id="plate-length" type="number" step="0.01" class="form-input" bind:value={newPlate.length} />
        </div>
        <div class="form-group">
          <label class="form-label" for="plate-depth">True depth (in)</label>
          <input id="plate-depth" type="number" step="0.001" class="form-input" bind:value={newPlate.trueDepth} />
        </div>
      </div>
      <button class="btn btn-primary" on:click={handleAdd}>Add Plate</button>
    </div>
  {/if}

  {#if categoryFilter}
    <div class="cam-list-actions">
      <span class="cam-form-hint">Stock group: {categoryLabel(categories.find((category) => String(category.id) === String(categoryFilter)))}</span>
      <button type="button" class="btn btn-ghost btn-sm" on:click={() => (categoryFilter = '')}>Show all plates</button>
    </div>
  {/if}
  {#if visiblePlates.length === 0}
    <p class="empty-state">{categoryFilter ? 'No plates match this stock group.' : 'No plates yet.'} {canManage ? 'Add one above to get started.' : 'Ask a manufacturing lead to add one.'}</p>
  {:else}
    <div class="cam-list">
      {#each visiblePlates as plate (plate.id)}
        <div class="card cam-list-item">
          <div class="cam-list-header">
            {#if renamingPlateId === plate.id}
              <span class="rename-control">
                <Layers size={16} />
                <input
                  class="form-input rename-input"
                  bind:value={renameValue}
                  on:keydown={(e) => { if (e.key === 'Enter') saveRename(plate); if (e.key === 'Escape') cancelRename(); }}
                />
                <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveRename(plate)}><Check size={14} /></button>
                <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelRename}><X size={14} /></button>
              </span>
            {:else}
              <span class="rename-control">
                <strong><Layers size={16} /> {plate.name}</strong>
                {#if canManage}
                  <button type="button" class="btn btn-ghost btn-sm" title="Rename" on:click={() => startRename(plate)}><Pencil size={13} /></button>
                {/if}
              </span>
            {/if}
            <span class="tag">{categoryLabel(plate.fusion_part_categories)}</span>
          </div>
          <p class="cam-form-hint">{plate.width}" x {plate.length}", true depth {plate.true_depth}"</p>
          {#if plate.fusion_part_category_assignments?.length}
            <div class="cam-list-actions">
              <span class="cam-form-hint">Nested parts:</span>
              {#each plate.fusion_part_category_assignments as assignment}
                <span class="cam-form-hint">{assignment.quantity}x {assignment.fusion_parts?.name || 'part'}</span>
                {#if canManage}
                  <button class="btn btn-ghost btn-sm" type="button" title="Remove {assignment.fusion_parts?.name || 'part'}" aria-label="Remove {assignment.fusion_parts?.name || 'part'} from {plate.name}" on:click={() => handleRemoveNestedPart(plate, assignment)}>×</button>
                {/if}
              {/each}
            </div>
          {/if}
          {#if canManage}
            {@const availableParts = eligibleParts(plate)}
            {@const chosenPart = selectedPart(plate)}
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for={`plate-nest-part-${plate.id}`}>Add a part</label>
                <select id={`plate-nest-part-${plate.id}`} class="form-select" bind:value={platePartSelections[plate.id]}>
                  <option value="">{availableParts.length ? 'Select a matching part...' : 'No matching parts available'}</option>
                  {#each availableParts as part}
                    <option value={part.id}>{part.name} ({part.quantity} available, {platePartQuantity(plate, part)} on this plate)</option>
                  {/each}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for={`plate-nest-quantity-${plate.id}`}>How many</label>
                <input id={`plate-nest-quantity-${plate.id}`} type="number" min="1" max={chosenPart ? maximumNestQuantity(plate, chosenPart) : undefined} step="1" class="form-input" bind:value={platePartQuantities[plate.id]} disabled={!chosenPart} />
              </div>
              <div class="form-group">
                <span class="form-label" aria-hidden="true">&nbsp;</span>
                <button class="btn btn-secondary btn-sm" type="button" disabled={!chosenPart} on:click={() => handleNestPart(plate)}><Plus size={14} /> Nest Part</button>
              </div>
            </div>
          {/if}
          <div class="cam-list-actions">
            <select class="form-select router-select" bind:value={plateQueueModes[plate.id]} aria-label="CAM mode for {plate.name}">
              <option value="">Choose CAM mode...</option>
              <option value="single">Single nested part</option>
              <option value="grouped" disabled={(plate.fusion_part_category_assignments?.length || 0) < 2}>Grouped plate ({plate.fusion_part_category_assignments?.length || 0} part types)</option>
            </select>
            {#if plateQueueModes[plate.id] === 'single'}
              <select class="form-select router-select" bind:value={plateSinglePartSelections[plate.id]} aria-label="Part for single-part CAM on {plate.name}">
                <option value="">Choose one nested part...</option>
                {#each plate.fusion_part_category_assignments || [] as assignment}
                  <option value={assignment.fusion_parts?.id}>{assignment.quantity}x {assignment.fusion_parts?.name || 'part'}</option>
                {/each}
              </select>
            {:else if plateQueueModes[plate.id] === 'grouped'}
              <fieldset class="group-part-picker">
                <legend>Select parts for grouped CAM</legend>
                {#each plate.fusion_part_category_assignments || [] as assignment}
                  {@const groupedPartId = assignment.fusion_parts?.id}
                  <label>
                    <input
                      type="checkbox"
                      checked={(plateGroupedPartSelections[plate.id] || []).includes(groupedPartId)}
                      on:change={() => toggleGroupedPart(plate.id, groupedPartId)}
                    />
                    {assignment.quantity}x {assignment.fusion_parts?.name || 'part'}
                  </label>
                {/each}
              </fieldset>
            {/if}
            <select class="form-select router-select" value={plateMachineSelections[plate.id]} on:change={(e) => handleMachineChange(plate, e.currentTarget.value)} aria-label="Router for {plate.name}">
              <option value={undefined}>Choose a router...</option>
              {#each machines as m}
                <option value={m.id}>{m.name}</option>
              {/each}
            </select>
            <select class="form-select router-select" bind:value={plateToolSelections[plate.id]} aria-label="Tool for {plate.name}" disabled={!plateMachineSelections[plate.id]}>
              <option value="">{toolsForMachine(plateMachineSelections[plate.id]).length ? 'Choose a tool...' : 'No tools installed on this router'}</option>
              {#each toolsForMachine(plateMachineSelections[plate.id]) as t}
                <option value={t.id}>{toolLabel(t)}</option>
              {/each}
            </select>
            <button class="btn btn-secondary btn-sm" disabled={queueing[plate.id] || !plateQueueModes[plate.id] || (plateQueueModes[plate.id] === 'single' && !plateSinglePartSelections[plate.id]) || (plateQueueModes[plate.id] === 'grouped' && (plateGroupedPartSelections[plate.id] || []).length < 2) || !plate.fusion_part_category_assignments?.length || !plateMachineSelections[plate.id] || !plateToolSelections[plate.id]} on:click={() => openQueueModal(plate)}>
              <Send size={14} /> Queue {plateQueueModes[plate.id] === 'grouped' ? 'Grouped ' : ''}CAM Job
            </button>
            {#if canManage}
              <button class="btn btn-ghost btn-sm" on:click={() => handleDelete(plate)}>
                <Trash2 size={14} /> Delete
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}

{#if queueModalPlate}
  <div class="modal-overlay" role="presentation" on:click={closeQueueModal}>
    <div class="modal queue-modal" role="dialog" aria-labelledby="queue-modal-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="queue-modal-title">Queue "{queueModalPlate.name}"</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueueModal}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <p class="cam-form-hint">This saves a new Fusion document for the job. Name it and pick where it goes - both default to something reasonable if you skip them.</p>
        <div class="form-group">
          <label class="form-label" for="queue-file-name">Fusion file name</label>
          <input
            id="queue-file-name"
            class="form-input"
            value={queueFileName}
            on:input={(e) => (queueFileName = e.currentTarget.value.replace(/\s+/g, ''))}
            placeholder="e.g. GearboxSidePlate"
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
          <Send size={14} /> {queueSubmitting ? 'Queueing…' : 'Queue Job'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tab-actions { margin-bottom: 1rem; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-row .form-group { flex: 1; min-width: 160px; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .rename-control { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .rename-input { padding: 0.2rem 0.4rem; height: auto; width: auto; min-width: 10rem; }
  .cam-list-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .router-select { width: auto; min-width: 160px; height: var(--control-height, 2.25rem); }
  .group-part-picker { display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem; }
  .group-part-picker legend { color: var(--text-muted); font-size: 0.75rem; padding: 0 0.25rem; }
  .group-part-picker label { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
  .queue-modal { max-width: 32rem; }
  .folder-tree-box {
    max-height: 16rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem;
  }
</style>
