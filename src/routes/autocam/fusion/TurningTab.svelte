<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import {
    fetchTurningParts, createTurningPart, deleteTurningPart, deleteTurningParts, renameTurningPart,
    updateTurningPartStepFile, updateTurningPartQuantity, installFusionPartCad, queueFusionJob,
    fetchCompletedFusionStockIds, TURNING_CAM_TYPES
  } from '$lib/fusionCam.js';
  import { formatPacificDateTime } from '$lib/timezone.js';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';
  import { getAllSeasonBuckets, passesSeasonFilter } from '$lib/frcSeason.js';
  import { RotateCcw, Plus, Trash2, Send, X, Pencil, Check, Download, Upload, Filter } from 'lucide-svelte';

  export let user;
  export let canManage;

  let turningParts = [];
  // fusion_turning_parts.id set with a completed CAM output job - see
  // BoxTubesTab.svelte's matching field and fetchCompletedFusionStockIds.
  let completedTurningIds = new Set();
  let machines = [];
  let loading = true;
  let showAddForm = false;
  // Only the STEP file and which CAM program to run are actually required -
  // direct instruction: minimize what an operator has to type in. Name is
  // auto-derived from the STEP filename (see handleFileChange); quantity and
  // tailstock length both have sensible defaults (1, and "use the part's own
  // measured length" - see HandleSpacer.py/HandleHexShaft.py).
  let newTurningPart = { name: '', quantity: 1, camType: '', tailstockLengthIn: '', projectId: '' };
  let stepFile = null;
  let submitting = false;

  // Which lathe each turning part's "Queue CAM Job" currently targets -
  // keyed by turning part id. No default, same reasoning as
  // BoxTubesTab.svelte's own boxTubeMachineSelections: silently picking
  // machines[0] would queue a real cut on a machine nobody actually chose.
  let turningMachineSelections = {};
  let queuePickerOpen = false;
  let queuedTurningPartId = '';
  let queueModalPart = null;
  let queueFileName = '';
  let queueFolderPath = '';
  let queueSubmitting = false;
  let cadModalPart = null;
  let renamingPartId = null;
  let renamePartValue = '';
  let editingQuantityId = null;
  let quantityValue = '';
  let recentPartSearch = '';
  $: recentPartSearchTerm = recentPartSearch.trim().toLowerCase();

  let turningListSearch = '';
  $: turningListSearchTerm = turningListSearch.trim().toLowerCase();
  $: turningPartsByCreatedAt = [...turningParts].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  let filterProject = '';
  let filterSeason = '';
  $: projectIds = Array.from(new Set(turningParts.map((part) => part.project_id).filter(Boolean))).sort();
  $: seasonOptions = getAllSeasonBuckets(turningParts);
  $: filteredTurningPartsByCreatedAt = turningPartsByCreatedAt.filter((part) =>
    (!turningListSearchTerm || part.name?.toLowerCase().includes(turningListSearchTerm) || part.project_id?.toLowerCase().includes(turningListSearchTerm))
    && (!filterProject || part.project_id === filterProject)
    && passesSeasonFilter(part.created_at, filterSeason)
  );

  let selectedPartIds = new Set();
  let bulkDeleting = false;
  $: visibleSelectedCount = filteredTurningPartsByCreatedAt.filter((p) => selectedPartIds.has(p.id)).length;
  function toggleSelected(partId) {
    const next = new Set(selectedPartIds);
    if (next.has(partId)) next.delete(partId); else next.add(partId);
    selectedPartIds = next;
  }
  function toggleSelectAll() {
    if (visibleSelectedCount === filteredTurningPartsByCreatedAt.length && filteredTurningPartsByCreatedAt.length > 0) {
      const visibleIds = new Set(filteredTurningPartsByCreatedAt.map((p) => p.id));
      selectedPartIds = new Set([...selectedPartIds].filter((id) => !visibleIds.has(id)));
    } else {
      selectedPartIds = new Set([...selectedPartIds, ...filteredTurningPartsByCreatedAt.map((p) => p.id)]);
    }
  }
  async function handleBulkDelete() {
    const ids = [...selectedPartIds];
    if (!ids.length) return;
    if (!await requestConfirmation({
      title: 'Delete turning stock',
      message: `Delete ${ids.length} selected turning part${ids.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true
    })) return;
    bulkDeleting = true;
    try {
      const removed = await deleteTurningParts(ids);
      const removedSet = new Set(ids);
      turningParts = turningParts.filter((p) => !removedSet.has(p.id));
      selectedPartIds = new Set();
      toastActions.show(`Deleted ${removed} turning part${removed === 1 ? '' : 's'}`);
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete selected turning parts');
    } finally {
      bulkDeleting = false;
    }
  }

  $: queueablePartsByCreatedAt = [...turningParts]
    .filter((part) => part.step_file_name)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  $: recentQueueableParts = recentPartSearchTerm
    ? queueablePartsByCreatedAt.filter((part) => part.name?.toLowerCase().includes(recentPartSearchTerm))
    : queueablePartsByCreatedAt.slice(0, 6);

  function camTypeLabel(camType) {
    return TURNING_CAM_TYPES.find((t) => t.value === camType)?.label || camType;
  }

  async function load(showLoading = true) {
    if (showLoading) loading = true;
    try {
      turningParts = await fetchTurningParts();
      const { turningPartIds } = await fetchCompletedFusionStockIds();
      completedTurningIds = turningPartIds || new Set();
      const { data: machineRows } = await supabase.from('cam_machines').select('*').eq('can_run_turning', true).eq('enabled', true).order('name');
      machines = machineRows || [];
    } catch (e) {
      toastActions.show(e.message || 'Failed to load turning stock');
    } finally {
      loading = false;
    }
  }

  onMount(() => { load(); });

  function handleFileChange(event) {
    stepFile = event.target.files?.[0] || null;
    if (stepFile && !newTurningPart.name.trim()) {
      const derivedName = stepFile.name.replace(/\.(step|stp)$/i, '').trim();
      if (derivedName) newTurningPart = { ...newTurningPart, name: derivedName };
    }
  }

  function cancelAdd() {
    newTurningPart = { name: '', quantity: 1, camType: '', tailstockLengthIn: '', projectId: '' };
    stepFile = null;
    showAddForm = false;
  }

  export function openQueuePicker() {
    queuePickerOpen = true;
    if (!queuedTurningPartId) queuedTurningPartId = turningParts.find((part) => part.step_file_name)?.id || '';
    recentPartSearch = '';
  }

  function closeQueuePicker() {
    queuePickerOpen = false;
    queuedTurningPartId = '';
    recentPartSearch = '';
  }

  // See BoxTubesTab.svelte's matching handler - first Escape clears an
  // active search instead of closing the picker out from under someone
  // still typing; a second Escape (search already empty) closes it.
  function handleQueuePickerKeydown(event) {
    if (!queuePickerOpen || event.key !== 'Escape') return;
    if (recentPartSearch) {
      recentPartSearch = '';
      return;
    }
    closeQueuePicker();
  }

  function selectRecentPart(part) {
    queuedTurningPartId = part.id;
  }

  async function queueTurningCam(turningPart, machineId, fusionFileName, fusionFolderPath) {
    await queueFusionJob({
      fusionJobKind: 'turning',
      turningPartId: turningPart.id,
      machineId,
      requestedBy: user?.id,
      name: `Turning CAM: ${turningPart.name}`,
      fusionFileName: fusionFileName || null,
      fusionFolderPath: fusionFolderPath || null,
      // A turning job is exactly one part from exactly one bar, same as tube
      // stock - a clean 1:1 link.
      partId: turningPart.part_id || null
    });
  }

  async function handleAdd() {
    if (!newTurningPart.name || !newTurningPart.quantity) {
      toastActions.show('Name and quantity are required');
      return;
    }
    if (!newTurningPart.camType) {
      toastActions.show('Choose Spacer or Hex Shaft');
      return;
    }
    if (!stepFile) {
      toastActions.show('A STEP file is required');
      return;
    }
    submitting = true;
    try {
      await createTurningPart({
        name: newTurningPart.name,
        quantity: Number(newTurningPart.quantity),
        camType: newTurningPart.camType,
        tailstockLengthIn: newTurningPart.tailstockLengthIn,
        stepFile,
        createdBy: user?.id,
        projectId: newTurningPart.projectId || null
      });
      cancelAdd();
      await load(false);
      toastActions.show('Turning stock added');
    } catch (e) {
      toastActions.show(e.message || 'Failed to add turning stock');
    } finally {
      submitting = false;
    }
  }

  async function handleDelete(turningPart) {
    if (!await requestConfirmation({ title: 'Delete turning stock', message: `Delete "${turningPart.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      await deleteTurningPart(turningPart.id);
      turningParts = turningParts.filter((p) => p.id !== turningPart.id);
      if (selectedPartIds.has(turningPart.id)) {
        const next = new Set(selectedPartIds);
        next.delete(turningPart.id);
        selectedPartIds = next;
      }
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete turning stock');
    }
  }

  function startRename(turningPart) {
    renamingPartId = turningPart.id;
    renamePartValue = turningPart.name;
  }

  function cancelRename() {
    renamingPartId = null;
    renamePartValue = '';
  }

  async function saveRename(turningPart) {
    try {
      const updated = await renameTurningPart(turningPart.id, renamePartValue);
      turningParts = turningParts.map((p) => p.id === turningPart.id ? updated : p);
      cancelRename();
    } catch (error) {
      toastActions.show(error.message || 'Failed to rename turning stock');
    }
  }

  function startEditQuantity(turningPart) {
    editingQuantityId = turningPart.id;
    quantityValue = String(turningPart.quantity);
  }

  function cancelEditQuantity() {
    editingQuantityId = null;
    quantityValue = '';
  }

  async function saveQuantity(turningPart) {
    const quantity = Number(quantityValue);
    if (!Number.isInteger(quantity) || quantity < 0) {
      toastActions.show('Quantity must be a whole number, zero or more');
      return;
    }
    try {
      const updated = await updateTurningPartQuantity(turningPart.id, quantity);
      turningParts = turningParts.map((p) => p.id === turningPart.id ? updated : p);
      cancelEditQuantity();
    } catch (error) {
      toastActions.show(error.message || 'Failed to update quantity');
    }
  }

  async function handleInstallCad(turningPart) {
    try {
      const url = await installFusionPartCad(turningPart.step_file_name);
      window.open(url, '_blank');
    } catch (error) {
      toastActions.show(error.message || 'Failed to download STEP file');
    }
  }

  let attachStepModalPart = null;
  let attachStepFile = null;
  let attachingStep = false;

  function openAttachStepModal(turningPart) {
    attachStepModalPart = turningPart;
    attachStepFile = null;
  }

  function closeAttachStepModal() {
    if (attachingStep) return;
    attachStepModalPart = null;
    attachStepFile = null;
  }

  async function saveAttachStep() {
    if (!attachStepFile) return toastActions.show('Choose a STEP file first');
    attachingStep = true;
    try {
      const updated = await updateTurningPartStepFile(attachStepModalPart.id, attachStepFile);
      turningParts = turningParts.map((item) => (item.id === updated.id ? updated : item));
      toastActions.show('STEP file saved');
      attachStepModalPart = null;
      attachStepFile = null;
    } catch (error) {
      toastActions.show(error.message || 'Failed to save STEP file');
    } finally {
      attachingStep = false;
    }
  }

  async function handleQueue(turningPart) {
    if (!turningPart.step_file_name) {
      toastActions.show('This turning part has no STEP file attached - add one before queuing');
      return;
    }
    const machineId = turningMachineSelections[turningPart.id];
    if (!machineId) {
      toastActions.show('Choose a lathe before queueing');
      return;
    }
    queueModalPart = turningPart;
    queueFileName = turningPart.name.replace(/\s+/g, '');
    queueFolderPath = '';
    closeQueuePicker();
  }

  function closeQueueModal() {
    if (queueSubmitting) return;
    queueModalPart = null;
    queueFileName = '';
    queueFolderPath = '';
  }

  async function confirmQueue() {
    if (!queueModalPart) return;
    const machineId = turningMachineSelections[queueModalPart.id];
    queueSubmitting = true;
    try {
      await queueTurningCam(queueModalPart, machineId, queueFileName, queueFolderPath);
      toastActions.show('Queued for the Fusion Runner');
      queueModalPart = null;
      queueFileName = '';
      queueFolderPath = '';
    } catch (e) {
      toastActions.show(e.message || 'Failed to queue job');
    } finally {
      queueSubmitting = false;
    }
  }
</script>

<svelte:window on:keydown={handleQueuePickerKeydown} />

{#if loading}
  <p>Loading turning stock...</p>
{:else}
  {#if canManage}
  <div class="tab-actions">
    <button class="btn btn-primary" on:click={() => (showAddForm = !showAddForm)}>
      <Plus size={16} /> Add Turning Stock
    </button>
  </div>
  {/if}

  {#if showAddForm && canManage}
    <div class="card">
      <div class="cam-list-header">
        <h3>New Turning Stock</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" aria-label="Close without adding turning stock" on:click={cancelAdd}><X size={16} /></button>
      </div>
      <p class="cam-form-hint">A bar of round or hex stock waiting to be sent to the lathe's Fusion CAM.</p>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="tp-name">Name</label>
          <input id="tp-name" class="form-input" bind:value={newTurningPart.name} placeholder="e.g. Gearbox Spacer" />
        </div>
        <div class="form-group">
          <label class="form-label" for="tp-step">STEP file</label>
          <input id="tp-step" type="file" accept=".step,.stp" class="form-input" on:change={handleFileChange} />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="tp-cam-type">CAM type</label>
          <select id="tp-cam-type" class="form-select" bind:value={newTurningPart.camType}>
            <option value="">Choose...</option>
            {#each TURNING_CAM_TYPES as camType}<option value={camType.value}>{camType.label}</option>{/each}
          </select>
          <p class="cam-form-hint">Which lathe CAM program to run - picks the operations, not just a label.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="tp-quantity">Quantity</label>
          <input id="tp-quantity" type="number" min="1" class="form-input" bind:value={newTurningPart.quantity} />
        </div>
      </div>
      <div class="form-row form-row-final">
        <div class="form-group">
          <label class="form-label" for="tp-tailstock">Tailstock length, inches (optional)</label>
          <input id="tp-tailstock" type="number" min="0" step="0.01" class="form-input" bind:value={newTurningPart.tailstockLengthIn} placeholder="Auto-detected from the part" />
        </div>
        <div class="form-group">
          <label class="form-label" for="tp-project-id">Project ID (optional)</label>
          <input id="tp-project-id" class="form-input" bind:value={newTurningPart.projectId} />
        </div>
      </div>
      <div class="cam-list-actions">
        <button class="btn btn-primary" disabled={submitting} on:click={handleAdd}>{submitting ? 'Adding...' : 'Add Turning Stock'}</button>
        <button type="button" class="btn btn-secondary" disabled={submitting} on:click={cancelAdd}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if turningParts.length === 0}
    <p class="empty-state">No turning stock yet. Add one above.</p>
  {:else}
    <div class="filters tab-filters">
      <div class="form-group">
        <label class="form-label" for="turning-search">Search</label>
        <input id="turning-search" type="search" class="form-input" placeholder="Search turning stock by name or project..." bind:value={turningListSearch} aria-label="Search turning stock" />
      </div>
      <div class="form-group">
        <label class="form-label" for="turning-project-filter"><Filter size={14} /> Project</label>
        <select id="turning-project-filter" class="form-select" bind:value={filterProject}>
          <option value="">All Projects</option>
          {#each projectIds as pid}<option value={pid}>{pid}</option>{/each}
        </select>
      </div>
      <SeasonFilter options={seasonOptions} bind:value={filterSeason} />
    </div>
    {#if filteredTurningPartsByCreatedAt.length === 0}
      <p class="empty-state">No turning stock matches "{turningListSearch}".</p>
    {/if}
    {#if canManage && filteredTurningPartsByCreatedAt.length > 0}
      <div class="bulk-select-bar">
        <label class="bulk-select-all">
          <input
            type="checkbox"
            checked={visibleSelectedCount > 0 && visibleSelectedCount === filteredTurningPartsByCreatedAt.length}
            indeterminate={visibleSelectedCount > 0 && visibleSelectedCount < filteredTurningPartsByCreatedAt.length}
            on:change={toggleSelectAll}
          />
          {visibleSelectedCount > 0 ? `${visibleSelectedCount} selected` : 'Select all'}
        </label>
        {#if visibleSelectedCount > 0}
          <button type="button" class="btn btn-ghost btn-sm" disabled={bulkDeleting} on:click={handleBulkDelete}>
            <Trash2 size={14} /> {bulkDeleting ? 'Deleting...' : `Delete ${visibleSelectedCount} selected`}
          </button>
        {/if}
      </div>
    {/if}
    <div class="cam-list">
      {#each filteredTurningPartsByCreatedAt as turningPart (turningPart.id)}
        <div class="card cam-list-item">
          <div class="cam-list-header">
            <span class="cam-list-header-left">
              {#if canManage}
                <input type="checkbox" class="bulk-select-checkbox" checked={selectedPartIds.has(turningPart.id)} on:change={() => toggleSelected(turningPart.id)} aria-label={`Select ${turningPart.name}`} />
              {/if}
              {#if renamingPartId === turningPart.id}
                <span class="rename-control">
                  <RotateCcw size={16} />
                  <input class="form-input rename-input" bind:value={renamePartValue} on:keydown={(event) => { if (event.key === 'Enter') saveRename(turningPart); if (event.key === 'Escape') cancelRename(); }} />
                  <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveRename(turningPart)}><Check size={14} /></button>
                  <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelRename}><X size={14} /></button>
                </span>
              {:else}
                <span class="rename-control">
                  <strong><RotateCcw size={16} /> {turningPart.name}</strong>
                  {#if canManage}
                    <button type="button" class="btn btn-ghost btn-sm" title="Rename" on:click={() => startRename(turningPart)}><Pencil size={13} /></button>
                  {/if}
                </span>
              {/if}
            </span>
            <span class="cam-list-header-right">
              <span class="tag">{camTypeLabel(turningPart.cam_type).toUpperCase()}</span>
              {#if completedTurningIds.has(turningPart.id)}
                <span class="tag tag-completed"><Check size={13} /> Completed</span>
              {:else}
                <span class="tag tag-pending">Pending</span>
              {/if}
            </span>
          </div>
          <p class="cam-form-hint">
            {#if editingQuantityId === turningPart.id}
              <span class="rename-control quantity-control">
                Quantity:
                <input type="number" min="0" step="1" class="form-input rename-input quantity-input" bind:value={quantityValue} on:keydown={(event) => { if (event.key === 'Enter') saveQuantity(turningPart); if (event.key === 'Escape') cancelEditQuantity(); }} />
                <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveQuantity(turningPart)}><Check size={14} /></button>
                <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelEditQuantity}><X size={14} /></button>
              </span>
            {:else}
              <span class="rename-control quantity-control">
                Quantity: {turningPart.quantity}
                {#if canManage}
                  <button type="button" class="btn btn-ghost btn-sm" title="Edit quantity" on:click={() => startEditQuantity(turningPart)}><Pencil size={13} /></button>
                {/if}
              </span>
            {/if}
            {#if turningPart.tailstock_length_in != null} - tailstock {turningPart.tailstock_length_in}in{/if}
            {#if turningPart.project_id} - project <strong>{turningPart.project_id}</strong>{/if}
            {#if !turningPart.step_file_name} - <em>no STEP file attached</em>{/if}
            {#if turningPart.created_at} - added {formatPacificDateTime(turningPart.created_at)}{/if}
          </p>
          <div class="cam-list-actions">
            {#if turningPart.step_file_name}
              <button class="btn btn-secondary btn-sm" on:click={() => (cadModalPart = turningPart)}><RotateCcw size={14} /> View CAD</button>
              <button class="btn btn-secondary btn-sm" on:click={() => handleInstallCad(turningPart)}><Download size={14} /> Install CAD</button>
            {/if}
            {#if canManage}
              <button class="btn btn-secondary btn-sm" on:click={() => openAttachStepModal(turningPart)}><Upload size={14} /> {turningPart.step_file_name ? 'Replace STEP' : 'Attach STEP'}</button>
              <button class="btn btn-ghost btn-sm" on:click={() => handleDelete(turningPart)}><Trash2 size={14} /> Delete</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}

{#if cadModalPart}
  <div class="modal-backdrop" on:click|self={() => (cadModalPart = null)} role="button" tabindex="0"
       on:keydown={(event) => { if (event.key === 'Escape') cadModalPart = null; }}>
    <div class="modal cad-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>CAD Preview - {cadModalPart.name}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={() => (cadModalPart = null)}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <CadViewer part={null} stepFileName={cadModalPart.step_file_name} />
        <p class="cam-form-hint">Drag to rotate &middot; scroll to zoom &middot; right-drag to pan</p>
      </div>
    </div>
  </div>
{/if}

{#if attachStepModalPart}
  <div class="modal-overlay" role="presentation" on:click={closeAttachStepModal}>
    <div class="modal" role="dialog" aria-labelledby="attach-turning-step-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="attach-turning-step-title">{attachStepModalPart.step_file_name ? 'Replace' : 'Attach'} STEP file - {attachStepModalPart.name}</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeAttachStepModal}><X size={16} /></button>
      </div>
      <div class="modal-body">
        {#if attachStepModalPart.step_file_name}
          <p class="cam-form-hint">This part already has a STEP file. Choosing a new one replaces it - the old file is not automatically removed from storage.</p>
        {/if}
        <div class="form-group">
          <label class="form-label" for="attach-turning-step-input">STEP file</label>
          <input id="attach-turning-step-input" type="file" accept=".step,.stp" class="form-input" on:change={(e) => (attachStepFile = e.currentTarget.files?.[0] || null)} />
        </div>
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeAttachStepModal}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={attachingStep || !attachStepFile} on:click={saveAttachStep}><Upload size={14} /> {attachingStep ? 'Saving...' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}

{#if canManage && queuePickerOpen}
  <div class="modal-overlay" role="presentation" on:click={closeQueuePicker}>
    <div class="modal queue-picker-modal" role="dialog" aria-labelledby="turning-queue-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="turning-queue-title">Send Turning Stock to Fusion CAM</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueuePicker}>×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="turning-queue-part">Turning stock</label>
            <select id="turning-queue-part" class="form-select" bind:value={queuedTurningPartId}>
              <option value="">Choose turning stock...</option>
              {#each turningParts.filter((part) => part.step_file_name) as part}
                <option value={part.id}>{part.name} ({camTypeLabel(part.cam_type)}, Qty {part.quantity})</option>
              {/each}
            </select>
          </div>
        </div>
        {#if queueablePartsByCreatedAt.length}
          <div class="recent-queue-picker">
            <div class="recent-queue-header">
              <span class="form-label">{recentPartSearchTerm ? 'Search results' : 'Recent turning stock'}</span>
              <input type="search" class="form-input recent-queue-search" placeholder="Search turning stock by name..." bind:value={recentPartSearch} aria-label="Search recent turning stock by name" />
            </div>
            {#if recentQueueableParts.length}
              <div class="recent-queue-grid">
                {#each recentQueueableParts as part}
                  {@const isSelected = String(queuedTurningPartId) === String(part.id)}
                  <button type="button" class="recent-queue-button" class:selected={isSelected} aria-pressed={isSelected} title={part.name} on:click={() => selectRecentPart(part)}>
                    <span class="recent-queue-name">{#if isSelected}<Check size={12} />{/if}{part.name}</span>
                    <span class="recent-queue-detail">{camTypeLabel(part.cam_type)}</span>
                  </button>
                {/each}
              </div>
            {:else}
              <p class="cam-form-hint">No turning stock matches "{recentPartSearch}".</p>
            {/if}
          </div>
        {/if}
        {#if queuedTurningPartId}
          {@const part = turningParts.find((item) => item.id === queuedTurningPartId)}
          {#if part}
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="turning-queue-machine">Lathe</label>
                <select id="turning-queue-machine" class="form-select" bind:value={turningMachineSelections[part.id]}>
                  <option value="">Choose a lathe...</option>
                  {#each machines as machine}<option value={machine.id}>{machine.name}</option>{/each}
                </select>
                <p class="cam-form-hint">Uses Fusion's own generic turning tools automatically - nothing else to pick here yet.</p>
              </div>
            </div>
          {/if}
        {/if}
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeQueuePicker}>Cancel</button>
        {#if queuedTurningPartId}
          {@const part = turningParts.find((item) => item.id === queuedTurningPartId)}
          <button class="btn btn-primary" type="button" disabled={!part || !turningMachineSelections[part.id]} on:click={() => handleQueue(part)}><Send size={14} /> Queue CAM Job</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if queueModalPart}
  <div class="modal-overlay" role="presentation" on:click={closeQueueModal}>
    <div class="modal queue-modal" role="dialog" aria-labelledby="turning-queue-modal-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="turning-queue-modal-title">Queue "{queueModalPart.name}"</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueueModal}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <p class="cam-form-hint">This saves a new Fusion document for the turning job. Name it, or skip it for a name generated from the job id.</p>
        <div class="form-group">
          <label class="form-label" for="turning-queue-file-name">Fusion file name (optional)</label>
          <input id="turning-queue-file-name" class="form-input" value={queueFileName} on:input={(event) => (queueFileName = event.currentTarget.value.replace(/\s+/g, ''))} placeholder="e.g. GearboxSpacer" />
          <p class="cam-form-hint">No spaces - this becomes the saved document's name in Fusion's Data Panel.</p>
        </div>
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeQueueModal}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={queueSubmitting} on:click={confirmQueue}><Send size={14} /> {queueSubmitting ? 'Queueing...' : 'Queue Job'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tab-actions { margin-bottom: 1rem; }
  .tab-filters { margin-bottom: 1rem; --filters-columns: 2fr 1fr 1fr; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-row-final { padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .form-row .form-group { flex: 1; min-width: 160px; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .rename-control { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .rename-input { padding: 0.2rem 0.4rem; height: auto; width: auto; min-width: 10rem; }
  .cam-list-header-left { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .cam-list-header-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
  .bulk-select-checkbox { width: 1rem; height: 1rem; flex-shrink: 0; cursor: pointer; }
  .bulk-select-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0.75rem; margin-bottom: 0.6rem; border: 1px solid var(--border); border-radius: var(--radius-md, 10px); background: var(--surface-2, #f7f7f5); flex-wrap: wrap; }
  .bulk-select-all { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; font-weight: 500; color: var(--text-muted); cursor: pointer; }
  .bulk-select-all input { width: 1rem; height: 1rem; cursor: pointer; }
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
  .recent-queue-button { transition: border-color 0.15s, background 0.15s, box-shadow 0.15s; }
  .recent-queue-button:hover, .recent-queue-button:focus-visible { border-color: var(--accent); background: var(--surface); outline: none; }
  .recent-queue-button.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--primary));
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .recent-queue-name, .recent-queue-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-queue-name { font-weight: 600; font-size: 0.8rem; display: flex; align-items: center; gap: 0.25rem; }
  .recent-queue-detail { color: var(--text-muted); font-size: 0.72rem; }
  @media (max-width: 640px) { .recent-queue-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
