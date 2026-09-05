<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { fetchPlates, createPlate, deletePlate, fetchPartCategories, fetchParts, assignPartToPlate, removePartFromPlate, queueFusionJob } from '$lib/fusionCam.js';
  import { Plus, Trash2, Layers, Send } from 'lucide-svelte';

  export let user;
  export let canManage;

  let plates = [];
  let parts = [];
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
  let platePartSelections = {};
  let platePartQuantities = {};

  async function load() {
    loading = true;
    try {
      [plates, categories, parts] = await Promise.all([fetchPlates(), fetchPartCategories(), fetchParts()]);
      platePartQuantities = Object.fromEntries(plates.map((plate) => [plate.id, platePartQuantities[plate.id] || 1]));
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

  function eligibleParts(plate) {
    return parts.filter((part) => String(part.category_id) === String(plate.category_id) && Number(part.quantity) > 0);
  }

  function selectedPart(plate) {
    return parts.find((part) => String(part.id) === String(platePartSelections[plate.id] || ''));
  }

  function maximumNestQuantity(plate, part) {
    const existing = plate.fusion_part_category_assignments?.find((assignment) => String(assignment.fusion_parts?.id) === String(part.id));
    return Number(part.quantity) + Number(existing?.quantity || 0);
  }

  async function handleNestPart(plate) {
    const part = selectedPart(plate);
    const quantity = Number(platePartQuantities[plate.id]);
    if (!part) {
      toastActions.show('Choose a part to nest');
      return;
    }
    if (String(part.category_id) !== String(plate.category_id) || Number(part.quantity) <= 0) {
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
      await load();
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
      await load();
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
                <label class="form-label" for={`plate-nest-part-${plate.id}`}>Nest a part</label>
                <select id={`plate-nest-part-${plate.id}`} class="form-select" bind:value={platePartSelections[plate.id]}>
                  <option value="">{availableParts.length ? 'Select a matching part...' : 'No matching parts available'}</option>
                  {#each availableParts as part}
                    <option value={part.id}>{part.name} ({part.quantity} available)</option>
                  {/each}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for={`plate-nest-quantity-${plate.id}`}>Quantity</label>
                <input id={`plate-nest-quantity-${plate.id}`} type="number" min="1" max={chosenPart ? maximumNestQuantity(plate, chosenPart) : undefined} step="1" class="form-input" bind:value={platePartQuantities[plate.id]} disabled={!chosenPart} />
              </div>
              <div class="form-group">
                <span class="form-label" aria-hidden="true">&nbsp;</span>
                <button class="btn btn-secondary btn-sm" type="button" disabled={!chosenPart} on:click={() => handleNestPart(plate)}><Plus size={14} /> Add</button>
              </div>
            </div>
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
