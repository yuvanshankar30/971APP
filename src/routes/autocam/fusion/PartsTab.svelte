<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { supabase } from '$lib/supabase.js';
  import { fetchParts, createPart, deletePart, renamePart, fetchPartCategories } from '$lib/fusionCam.js';
  import { Plus, Trash2, Package, Pencil, Check, X } from 'lucide-svelte';

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
  let newPart = { name: '', epic: '', ticket: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '' };
  let stepFile = null;
  let submitting = false;
  let renamingPartId = null;
  let renameValue = '';

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

  // Strips spaces as you type rather than rejecting on submit - this
  // becomes the Fusion document name (see camPlate.py), which treats it as
  // one filename token. Matches the DB check constraint.
  function handleFusionFileNameInput(event) {
    newPart.fusionFileName = event.target.value.replace(/\s+/g, '');
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
        partId: newPart.manufacturingPartId || null,
        fusionFileName: newPart.fusionFileName || null
      });
      newPart = { name: '', epic: '', ticket: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '' };
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
      // Splice locally instead of re-fetching everything just to drop one
      // row - see PlatesTab.svelte's matching comment.
      parts = parts.filter((p) => p.id !== part.id);
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete part');
    }
  }

  function startRename(part) {
    renamingPartId = part.id;
    renameValue = part.name;
  }

  function cancelRename() {
    renamingPartId = null;
    renameValue = '';
  }

  async function saveRename(part) {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      toastActions.show('Name cannot be empty');
      return;
    }
    if (trimmed === part.name) {
      cancelRename();
      return;
    }
    try {
      const updated = await renamePart(part.id, trimmed);
      parts = parts.map((p) => (p.id === part.id ? { ...p, ...updated } : p));
      cancelRename();
    } catch (e) {
      toastActions.show(e.message || 'Failed to rename part');
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
          <label class="form-label" for="part-fusion-file-name">Fusion file name (optional, no spaces)</label>
          <input
            id="part-fusion-file-name"
            class="form-input"
            value={newPart.fusionFileName}
            on:input={handleFusionFileNameInput}
            placeholder="e.g. GearboxSidePlate"
          />
          <p class="cam-form-hint">Used as the saved Fusion document name instead of the default Plate/Job ID name.</p>
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
      {#each parts as part (part.id)}
        <div class="card cam-list-item">
          <div class="cam-list-header">
            {#if renamingPartId === part.id}
              <span class="rename-control">
                <Package size={16} />
                <input
                  class="form-input rename-input"
                  bind:value={renameValue}
                  on:keydown={(e) => { if (e.key === 'Enter') saveRename(part); if (e.key === 'Escape') cancelRename(); }}
                />
                <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveRename(part)}><Check size={14} /></button>
                <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelRename}><X size={14} /></button>
              </span>
            {:else}
              <span class="rename-control">
                <strong><Package size={16} /> {part.name}</strong>
                {#if canManage}
                  <button type="button" class="btn btn-ghost btn-sm" title="Rename" on:click={() => startRename(part)}><Pencil size={13} /></button>
                {/if}
              </span>
            {/if}
            <span class="tag">{categoryLabel(part.fusion_part_categories)}</span>
          </div>
          <p class="cam-form-hint">
            Quantity: {part.quantity} of {part.original_quantity}
            {#if part.epic} - {part.epic}{/if}
            {#if part.ticket} - {part.ticket}{/if}
            {#if part.parts} - linked to <strong>{part.parts.name}</strong>{/if}
            {#if part.fusion_file_name} - Fusion file name: <strong>{part.fusion_file_name}</strong>{/if}
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
  .rename-control { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .rename-input { padding: 0.2rem 0.4rem; height: auto; width: auto; min-width: 10rem; }
  .cam-list-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
</style>
