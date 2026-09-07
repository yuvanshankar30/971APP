<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { supabase } from '$lib/supabase.js';
  import { fetchParts, createPart, deletePart, renamePart, updatePartQuantity, fetchPartCategories, installFusionPartCad } from '$lib/fusionCam.js';
  import { groupFusionParts } from '$autocam/fusion/grouping.js';
  import { fetchStepMeshes } from '$lib/stepMeshLoader.js';
  import { extractRoutingContoursFromMeshes } from '$autocam/stepProfile.js';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import { Plus, Trash2, Package, Pencil, Check, X, Sparkles, Box, Download } from 'lucide-svelte';

  export let user;
  export let canManage;
  export let onViewPlates = () => {};
  // Deep link from Manufacturing's "Open Fusion CAM" button (see
  // /autocam/fusion/+page.svelte) - the id of a public.parts row to
  // pre-fill the Add Part form from: name, STEP file (carried over, not
  // re-uploaded), and a depth estimate read straight off that STEP file's
  // geometry. Material/thickness is deliberately left for the user to pick
  // and cross-check against the detected depth - see handlePrefill below.
  export let initialManufacturingPartId = null;

  let parts = [];
  let categories = [];
  let groupByStock = true;
  $: stockGroups = groupByStock
    ? groupFusionParts(parts, categories)
    : [{ key: 'all', parts }];
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
  let editingQuantityId = null;
  let quantityValue = '';

  // State for the "Open Fusion CAM" deep-link prefill - see
  // initialManufacturingPartId and applyManufacturingPrefill below.
  let prefillApplied = false;
  let stepCarriedOverFrom = null;
  let detectingDepth = false;
  let detectedDepthInches = null;

  async function loadManufacturingParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('id, name, project_id, workflow, file_name, file_url')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.warn('Could not load manufacturing requests to link:', error.message);
      return;
    }
    manufacturingParts = data || [];
  }

  // Same file_url convention manufacture/+page.svelte's own
  // getStepFileName/getFileMeta use - a JSON blob { step_file, ... } for
  // router parts, with file_name kept as a plain-string fallback for
  // backward compat (see manufacture/create/+page.svelte's insert).
  function manufacturingStepFileName(mp) {
    if (!mp) return null;
    try {
      const meta = JSON.parse(mp.file_url);
      if (meta?.step_file) return meta.step_file;
    } catch {}
    if (mp.file_name && /\.(step|stp)$/i.test(mp.file_name)) return mp.file_name;
    return null;
  }

  // Direct invariant: "if a part is linked to a manufacturing request, it
  // should have the same step file" - so once a link with a real STEP file
  // is picked, the manual STEP picker is disabled rather than left as a
  // soft, overridable suggestion (see handleFileChange). Only true when the
  // linked request actually HAS a resolvable STEP file - a request with no
  // STEP of its own has nothing to enforce, so the manual picker stays
  // available for that case rather than leaving the part stuck with none.
  $: manufacturingHasStepFile = !!manufacturingStepFileName(
    manufacturingParts.find((mp) => mp.id === newPart.manufacturingPartId)
  );

  // Best-effort carry-over of the linked request's STEP file (so the user
  // doesn't have to re-download-then-re-upload it) and a depth estimate read
  // straight off its geometry (extractRoutingContoursFromMeshes's own
  // thickness - the same measure CadViewer.svelte's bounding-box readout and
  // the routing G-code generator both already trust). Neither is required
  // for the form to work - a part with no STEP, or geometry this extractor
  // can't parse (not a flat routed profile), just skips that part quietly.
  async function applyManufacturingPrefill(linkedPart) {
    newPart = {
      ...newPart,
      name: newPart.name || linkedPart.name || '',
      manufacturingPartId: linkedPart.id
    };
    if (!newPart.fusionFileName) {
      const derived = (linkedPart.name || '').trim().replace(/\s+/g, '');
      if (derived) newPart.fusionFileName = derived;
    }
    showAddForm = true;

    const stepPath = manufacturingStepFileName(linkedPart);
    if (!stepPath) return;

    try {
      const { data: blob, error: downloadError } = await supabase.storage
        .from('manufacturing-files')
        .download(stepPath);
      if (downloadError || !blob) throw downloadError || new Error('Empty download');
      stepFile = new File([blob], stepPath.split('/').pop(), { type: blob.type || 'application/step' });
      stepCarriedOverFrom = linkedPart.name;
    } catch (e) {
      console.warn('Could not carry over the linked request\'s STEP file:', e.message || e);
    }

    detectingDepth = true;
    try {
      const meshes = await fetchStepMeshes(stepPath);
      const { thickness } = extractRoutingContoursFromMeshes(meshes);
      detectedDepthInches = thickness;
    } catch (e) {
      console.warn('Could not estimate depth from this STEP file:', e.message || e);
    } finally {
      detectingDepth = false;
    }
  }

  // Picking a request from the dropdown carries its STEP file over too,
  // not just arriving via the "Open Fusion CAM" deep link. A part linked to
  // a manufacturing request is meant to BE that request's part, so it
  // should already have that request's STEP file - previously the carry-over
  // only ran on the deep-link path, so linking a request by hand left the
  // file picker empty and the same STEP had to be downloaded from the
  // request and re-uploaded here by hand.
  //
  // A file the user chose themselves is never replaced: only a carried-over
  // file (stepCarriedOverFrom) or an empty picker is filled in, so
  // re-pointing the link can't silently swap out a deliberate upload.
  async function handleManufacturingLinkChange() {
    const selectedId = newPart.manufacturingPartId;
    if (!selectedId) {
      // Unlinking clears a file that only came from the previous link -
      // leaving it attached would quietly ship the wrong geometry.
      if (stepCarriedOverFrom) {
        stepFile = null;
        stepCarriedOverFrom = null;
        detectedDepthInches = null;
      }
      return;
    }
    const linkedPart = manufacturingParts.find((mp) => mp.id === selectedId);
    if (!linkedPart) return;
    // Direct invariant: "if a part is linked to a manufacturing request, it
    // should have the same step file." A manual pick made BEFORE choosing
    // this link no longer wins - linking always carries the request's own
    // file over, same as manufacturingHasStepFile disables the picker
    // going forward. Only skipped when the linked request has no STEP file
    // of its own to carry over (manufacturingStepFileName returns null) -
    // there is nothing to enforce, so whatever manual file is already
    // picked is left alone rather than being cleared for no replacement.
    if (!manufacturingStepFileName(linkedPart) && stepFile && !stepCarriedOverFrom) return;
    await applyManufacturingPrefill(linkedPart);
  }

  // Runs once, as soon as both the deep-link target and the manufacturing
  // parts list it needs to be found in are available. Falls back to a
  // direct fetch if the request isn't among the most-recent 200 (the
  // dropdown's own cap) - a deep link can point at an older request.
  $: if (!prefillApplied && canManage && initialManufacturingPartId && manufacturingParts.length) {
    prefillApplied = true;
    const linkedPart = manufacturingParts.find((mp) => mp.id === initialManufacturingPartId);
    if (linkedPart) {
      applyManufacturingPrefill(linkedPart);
    } else {
      supabase
        .from('parts')
        .select('id, name, project_id, workflow, file_name, file_url')
        .eq('id', initialManufacturingPartId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error || !data) {
            console.warn('Could not load the linked manufacturing request:', error?.message);
            return;
          }
          manufacturingParts = [data, ...manufacturingParts];
          applyManufacturingPrefill(data);
        });
    }
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
    // Direct invariant: "if a part is linked to a manufacturing request, it
    // should have the same step file" - not a soft suggestion a manual pick
    // can silently override. The file input is disabled in the markup
    // whenever a link with a real STEP file is selected (see
    // manufacturingHasStepFile below); this guard is defense in depth for
    // an event that fires anyway (a disabled input's change handler should
    // never run, but nothing here should trust that from the DOM alone).
    if (manufacturingHasStepFile) return;
    stepFile = event.target.files?.[0] || null;
    stepCarriedOverFrom = null; // user picked their own file - the carry-over hint no longer applies
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
    // Came from the "Open Fusion CAM" deep link (see initialManufacturingPartId)?
    // Adding the part is only step one of that flow - jump straight to the
    // Plates tab, pre-filtered to this part's own stock category, so nesting
    // it onto a plate is the very next thing the user does, not a separate
    // hunt through the Plates tab afterward.
    const cameFromDeepLink = prefillApplied && newPart.manufacturingPartId === initialManufacturingPartId;
    try {
      const created = await createPart({
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
      stepCarriedOverFrom = null;
      detectedDepthInches = null;
      showAddForm = false;
      await load(false);
      if (cameFromDeepLink) {
        toastActions.show('Part added - now nest it onto a plate below');
        onViewPlates(created.category_id);
      } else {
        toastActions.show('Part added');
      }
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

  function startEditQuantity(part) {
    editingQuantityId = part.id;
    quantityValue = String(part.original_quantity);
  }

  function cancelEditQuantity() {
    editingQuantityId = null;
    quantityValue = '';
  }

  async function saveQuantity(part) {
    const parsed = Number(quantityValue);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toastActions.show('Quantity must be a whole number, zero or more');
      return;
    }
    if (parsed === part.original_quantity) {
      cancelEditQuantity();
      return;
    }
    try {
      const updated = await updatePartQuantity(part.id, parsed);
      parts = parts.map((p) => (p.id === part.id ? { ...p, ...updated } : p));
      cancelEditQuantity();
    } catch (e) {
      toastActions.show(e.message || 'Failed to update quantity');
    }
  }

  function categoryLabel(cat) {
    if (!cat) return 'Unknown';
    const material = cat.cam_materials?.name || 'Material';
    return `${material} - ${cat.thickness}"`;
  }

  // View CAD / Install CAD - fetchParts already selects fusion_parts.*, so
  // step_file_name is on the row directly here, unlike JobQueueTab.svelte
  // (a Fusion job's own step_file_name is always null; it has to resolve
  // this through its linked part instead - see fetchFusionPartStepFiles).
  let cadModalPart = null;

  async function handleInstallCad(part) {
    try {
      const url = await installFusionPartCad(part.step_file_name);
      window.open(url, '_blank');
    } catch (e) {
      toastActions.show(e.message || 'Failed to download STEP file');
    }
  }
</script>

{#if loading}
  <p>Loading parts...</p>
{:else}
  {#if canManage}
  <div class="tab-actions">
    <button class="btn btn-primary" on:click={() => (showAddForm = !showAddForm)}>
      <Plus size={16} /> Add Part
    </button>
  </div>

  {/if}
  {#if showAddForm && canManage}
    <div class="card">
      <h3>New Part</h3>
      <p class="cam-form-hint">A named quantity of stock waiting to be nested onto a plate - not yet assigned to one.</p>
      {#if newPart.manufacturingPartId && prefillApplied}
        <p class="prefill-banner">
          <Sparkles size={14} /> Pre-filled from the linked manufacturing request - check material/thickness below before saving.
        </p>
      {/if}
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
          {#if detectingDepth}
            <p class="cam-form-hint">Estimating depth from the CAD file...</p>
          {:else if detectedDepthInches != null}
            <p class="cam-form-hint depth-hint">
              Detected depth from CAD: <strong>{detectedDepthInches.toFixed(detectedDepthInches < 0.1 ? 4 : 3)}"</strong> - pick the material/thickness that matches.
            </p>
          {/if}
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
          <label class="form-label" for="part-step">STEP file {manufacturingHasStepFile ? '(from linked request)' : '(optional)'}</label>
          <input
            id="part-step"
            type="file"
            accept=".step,.stp"
            class="form-input"
            disabled={manufacturingHasStepFile}
            on:change={handleFileChange}
          />
          {#if manufacturingHasStepFile}
            <p class="cam-form-hint">Locked to the linked request's own STEP file - a linked part always has the same file. Unlink the request above to upload a different one.</p>
          {:else if stepCarriedOverFrom}
            <p class="cam-form-hint">Carried over from "{stepCarriedOverFrom}" - pick a different file above to replace it.</p>
          {/if}
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
          <select id="part-manufacturing-link" class="form-select" bind:value={newPart.manufacturingPartId} on:change={handleManufacturingLinkChange}>
            <option value="">Not linked to a request</option>
            {#each manufacturingParts as mp}
              <option value={mp.id}>{mp.name}{mp.project_id ? ` (${mp.project_id})` : ''}</option>
            {/each}
          </select>
          <p class="cam-form-hint">Traces this stock back to the real request it's for - leave unlinked for ad-hoc/prototype stock. Linking one carries its STEP file over automatically.</p>
        </div>
      </div>
      <button class="btn btn-primary" disabled={submitting} on:click={handleAdd}>{submitting ? 'Adding...' : 'Add Part'}</button>
    </div>
  {/if}

  {#if parts.length === 0}
    <p class="empty-state">No parts yet. Add one above.</p>
  {:else}
    <label class="group-toggle">
      <input type="checkbox" bind:checked={groupByStock} /> Group by material / thickness
    </label>
    {#if groupByStock}
      <p class="cam-form-hint">Stock groups help plan a shared plate. Fit and spacing are checked when Fusion arranges the parts.</p>
    {/if}
    {#each stockGroups as group (group.key)}
      <section class="stock-group">
        {#if groupByStock}
          <div class="cam-list-header group-header">
            <div>
              <h3>{group.category ? categoryLabel(group.category) : 'Stock category unavailable'}</h3>
              <p class="cam-form-hint">{group.parts.length} part types · {group.remainingQuantity} remaining to nest</p>
            </div>
            {#if group.categoryId}
              <button type="button" class="btn btn-secondary btn-sm" on:click={() => onViewPlates(group.categoryId)}>View matching plates</button>
            {/if}
          </div>
        {/if}
      <div class="cam-list">
        {#each group.parts as part (part.id)}
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
              {#if editingQuantityId === part.id}
                <span class="rename-control quantity-control">
                  Total needed:
                  <input
                    type="number"
                    min="0"
                    step="1"
                    class="form-input rename-input quantity-input"
                    bind:value={quantityValue}
                    on:keydown={(e) => { if (e.key === 'Enter') saveQuantity(part); if (e.key === 'Escape') cancelEditQuantity(); }}
                  />
                  <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveQuantity(part)}><Check size={14} /></button>
                  <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelEditQuantity}><X size={14} /></button>
                </span>
              {:else}
                <span class="rename-control quantity-control">
                  {part.original_quantity} needed total - {part.quantity} still need a plate
                  {#if part.original_quantity - part.quantity > 0}
                    ({part.original_quantity - part.quantity} already on a plate)
                  {/if}
                  {#if canManage}
                    <button type="button" class="btn btn-ghost btn-sm" title="Edit total quantity needed" on:click={() => startEditQuantity(part)}><Pencil size={13} /></button>
                  {/if}
                </span>
              {/if}
              {#if part.epic} - {part.epic}{/if}
              {#if part.ticket} - {part.ticket}{/if}
              {#if part.parts} - linked to <strong>{part.parts.name}</strong>{/if}
              {#if part.fusion_file_name} - Fusion file name: <strong>{part.fusion_file_name}</strong>{/if}
            </p>
            <div class="cam-list-actions">
              {#if part.step_file_name}
                <button class="btn btn-secondary btn-sm" on:click={() => (cadModalPart = part)}>
                  <Box size={14} /> View CAD
                </button>
                <button class="btn btn-secondary btn-sm" on:click={() => handleInstallCad(part)}>
                  <Download size={14} /> Install CAD
                </button>
              {/if}
              {#if canManage}
                <button class="btn btn-ghost btn-sm" on:click={() => handleDelete(part)}>
                  <Trash2 size={14} /> Delete
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
      </section>
    {/each}
  {/if}
{/if}

{#if cadModalPart}
  <div class="modal-backdrop" on:click|self={() => (cadModalPart = null)} role="button" tabindex="0"
       on:keydown={(e) => { if (e.key === 'Escape') (cadModalPart = null); }}>
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

<style>
  .cad-modal { width: min(900px, 94vw); }
  .cad-modal .modal-body { min-height: 60vh; }
  .group-toggle { display: flex; align-items: center; gap: 0.5rem; }
  .stock-group { margin-top: 1rem; }
  .group-header { flex-wrap: wrap; margin-bottom: 0.75rem; }
  .group-header h3 { margin: 0; }
  .tab-actions { margin-bottom: 1rem; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-row .form-group { flex: 1; min-width: 160px; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .rename-control { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .rename-input { padding: 0.2rem 0.4rem; height: auto; width: auto; min-width: 10rem; }
  .quantity-control { display: inline-flex; }
  .quantity-input { min-width: 4rem; width: 4rem; }
  .cam-list-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
  .depth-hint strong { color: var(--text, #111); }
  .prefill-banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--accent, #2563eb);
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }
</style>
