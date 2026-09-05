<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { supabase } from '$lib/supabase.js';
  import { fetchParts, createPart, deletePart, fetchPartCategories } from '$lib/fusionCam.js';
  import { Plus, Trash2, Package } from 'lucide-svelte';

  export let user;
  export let canManage;

  let parts = [];
  let categories = [];
  // Real manufacturing requests this Fusion part can optionally be linked
  // to - see the migration that added fusion_parts.part_id. Kept separate
  // from Fusion's own catalog (fusion_parts) on purpose: /autocam/fusion
  // stays its own section for now, this is just the connecting reference.
  let manufacturingParts = [];
  let loading = true;
  let showAddForm = false;
  let newPart = { name: '', epic: '', ticket: '', quantity: 1, categoryId: '', manufacturingPartId: '' };
  let stepFile = null;
  let submitting = false;

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
      [parts, categories] = await Promise.all([fetchParts(), fetchPartCategories()]);
      await loadManufacturingParts();
    } catch (e) {
      toastActions.show(e.message || 'Failed to load parts');
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function handleFileChange(event) {
    stepFile = event.target.files?.[0] || null;
  }

  async function handleAdd() {
    if (!newPart.name || !newPart.categoryId || !newPart.quantity) {
      toastActions.show('Name, category, and quantity are required');
      return;
    }
    submitting = true;
    try {
      await createPart({
        name: newPart.name,
        epic: newPart.epic,
        ticket: newPart.ticket,
        quantity: Number(newPart.quantity),
        categoryId: newPart.categoryId,
        stepFile,
        createdBy: user?.id,
        partId: newPart.manufacturingPartId || null
      });
      newPart = { name: '', epic: '', ticket: '', quantity: 1, categoryId: '', manufacturingPartId: '' };
      stepFile = null;
      showAddForm = false;
      await load(false);
      toastActions.show('Part added');
    } catch (e) {
      toastActions.show(e.message || 'Failed to add part');
    } finally {
      submitting = false;
    }
  }

  async function handleDelete(part) {
    if (!await requestConfirmation({ title: 'Delete part', message: `Delete part "${part.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      await deletePart(part.id);
      await load(false);
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete part');
    }
  }

  function categoryLabel(cat) {
    if (!cat) return 'Unknown';
    const material = cat.cam_materials?.name || 'Material';
    return `${material} - ${cat.thickness}"`;
  }
</script>

{#if loading}
  <p>Loading parts...</p>
{:else}
  <div class="tab-actions">
    <button class="btn btn-primary" on:click={() => (showAddForm = !showAddForm)}>
      <Plus size={16} /> Add Part
    </button>
  </div>

  {#if showAddForm}
    <div class="card">
      <h3>New Part</h3>
      <p class="cam-form-hint">A named quantity of stock waiting to be nested onto a plate - not yet assigned to one.</p>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="part-name">Name</label>
          <input id="part-name" class="form-input" bind:value={newPart.name} placeholder="e.g. Gearbox Side Plate" />
        </div>
        <div class="form-group">
          <label class="form-label" for="part-category">Material / Thickness</label>
          <select id="part-category" class="form-select" bind:value={newPart.categoryId}>
            <option value="">Select...</option>
            {#each categories as cat}
              <option value={cat.id}>{categoryLabel(cat)}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="part-quantity">Quantity</label>
          <input id="part-quantity" type="number" min="1" class="form-input" bind:value={newPart.quantity} />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="part-epic">Epic (optional)</label>
          <input id="part-epic" class="form-input" bind:value={newPart.epic} />
        </div>
        <div class="form-group">
          <label class="form-label" for="part-ticket">Ticket (optional)</label>
          <input id="part-ticket" class="form-input" bind:value={newPart.ticket} />
        </div>
        <div class="form-group">
          <label class="form-label" for="part-step">STEP file (optional)</label>
          <input id="part-step" type="file" accept=".step,.stp" class="form-input" on:change={handleFileChange} />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="part-manufacturing-link">Manufacturing request (optional)</label>
          <select id="part-manufacturing-link" class="form-select" bind:value={newPart.manufacturingPartId}>
            <option value="">Not linked to a request</option>
            {#each manufacturingParts as mp}
              <option value={mp.id}>{mp.name}{mp.project_id ? ` (${mp.project_id})` : ''}</option>
            {/each}
          </select>
          <p class="cam-form-hint">Traces this stock back to the real request it's for - leave unlinked for ad-hoc/prototype stock.</p>
        </div>
      </div>
      <button class="btn btn-primary" disabled={submitting} on:click={handleAdd}>{submitting ? 'Adding...' : 'Add Part'}</button>
    </div>
  {/if}

  {#if parts.length === 0}
    <p class="empty-state">No parts yet. Add one above.</p>
  {:else}
    <div class="cam-list">
      {#each parts as part}
        <div class="card cam-list-item">
          <div class="cam-list-header">
            <strong><Package size={16} /> {part.name}</strong>
            <span class="tag">{categoryLabel(part.fusion_part_categories)}</span>
          </div>
          <p class="cam-form-hint">
            Quantity: {part.quantity} of {part.original_quantity}
            {#if part.epic} - {part.epic}{/if}
            {#if part.ticket} - {part.ticket}{/if}
            {#if part.parts} - linked to <strong>{part.parts.name}</strong>{/if}
          </p>
          <div class="cam-list-actions">
            {#if canManage}
              <button class="btn btn-ghost btn-sm" on:click={() => handleDelete(part)}>
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
  .cam-list-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
</style>
