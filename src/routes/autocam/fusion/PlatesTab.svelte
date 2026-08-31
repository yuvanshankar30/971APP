<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { fetchPlates, createPlate, deletePlate, fetchPartCategories, queueFusionJob } from '$lib/fusionCam.js';
  import { Plus, Trash2, Layers, Send } from 'lucide-svelte';

  export let user;
  export let canManage;

  let plates = [];
  let categories = [];
  let machines = [];
  let loading = true;
  let showAddForm = false;
  let newPlate = { name: '', width: '', length: '', trueDepth: '', categoryId: '' };
  // Which router each plate's "Queue CAM Job" is currently set to send the
  // job to - keyed by plate id, one router picked per row. No default: with
  // more than one real router now eligible (can_run_plates), silently
  // picking machines[0] means whichever router happens to sort first gets
  // every job regardless of which one it was actually meant for - a human
  // has to choose explicitly.
  let plateMachineSelections = {};

  async function load() {
    loading = true;
    try {
      [plates, categories] = await Promise.all([fetchPlates(), fetchPartCategories()]);
      const { data: machineRows } = await supabase.from('cam_machines').select('*').eq('can_run_plates', true).eq('enabled', true).order('name');
      machines = machineRows || [];
    } catch (e) {
      toastActions.show(e.message || 'Failed to load plates');
    } finally {
      loading = false;
    }
  }

  onMount(load);

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
      await load();
      toastActions.show('Plate added');
    } catch (e) {
      toastActions.show(e.message || 'Failed to add plate');
    }
  }

  async function handleDelete(plate) {
    if (!await requestConfirmation({ title: 'Delete plate', message: `Delete plate "${plate.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      await deletePlate(plate.id);
      await load();
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete plate');
    }
  }

  async function handleQueue(plate) {
    const machineId = plateMachineSelections[plate.id];
    if (!machineId) {
      toastActions.show('Choose a router before queueing');
      return;
    }
    try {
      await queueFusionJob({
        fusionJobKind: 'plate:cam',
        plateId: plate.id,
        machineId,
        materialId: plate.fusion_part_categories?.cam_materials ? plate.category_id : null,
        requestedBy: user?.id,
        name: `Plate CAM: ${plate.name}`
      });
      toastActions.show('Queued for the Fusion Runner');
    } catch (e) {
      toastActions.show(e.message || 'Failed to queue job');
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

  {#if plates.length === 0}
    <p class="empty-state">No plates yet. {canManage ? 'Add one above to get started.' : 'Ask a manufacturing lead to add one.'}</p>
  {:else}
    <div class="cam-list">
      {#each plates as plate}
        <div class="card cam-list-item">
          <div class="cam-list-header">
            <strong><Layers size={16} /> {plate.name}</strong>
            <span class="tag">{categoryLabel(plate.fusion_part_categories)}</span>
          </div>
          <p class="cam-form-hint">{plate.width}" x {plate.length}", true depth {plate.true_depth}"</p>
          {#if plate.fusion_part_category_assignments?.length}
            <p class="cam-form-hint">Nested parts: {plate.fusion_part_category_assignments.map((a) => `${a.quantity}x ${a.fusion_parts?.name || 'part'}`).join(', ')}</p>
          {/if}
          <div class="cam-list-actions">
            <select class="form-select router-select" bind:value={plateMachineSelections[plate.id]} aria-label="Router for {plate.name}">
              <option value={undefined}>Choose a router...</option>
              {#each machines as m}
                <option value={m.id}>{m.name}</option>
              {/each}
            </select>
            <button class="btn btn-secondary btn-sm" disabled={!plateMachineSelections[plate.id]} on:click={() => handleQueue(plate)}>
              <Send size={14} /> Queue CAM Job
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
