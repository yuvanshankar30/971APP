<script>
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { supabase } from '$lib/supabase.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { createPartCategory, deletePartCategory, fetchPartCategories } from '$lib/fusionCam.js';
  import { Plus, SlidersHorizontal, Trash2, AlertTriangle } from 'lucide-svelte';

  export let canManage;

  let categories = [];
  let materials = [];
  let loading = true;
  let submitting = false;
  let deletingId = null;
  let selectedMaterialId = '';
  let newMaterialName = '';
  let thickness = '';

  // Mirrors templateTools.py's _material_aliases() keyword groups exactly -
  // that function is what a real Fusion job uses to pick cutting feeds and
  // speeds for a material, matching on substrings of the material's name
  // (not a separate field). A name that matches none of these has no way
  // to resolve a preset: _choose_preset() raises and the job fails outright
  // the moment it tries to cut, not when this material was added - so this
  // tab needs to warn about that gap right here, before anyone nests a
  // part against it and only finds out days later in Fusion.
  const KNOWN_MATERIAL_KEYWORDS = [
    'aluminum', 'aluminium', '6061', 'al', 'alu', 'alum',
    'polycarb', 'lexan', 'pc',
    'mdf', 'acrylic', 'srpp', 'wood', 'plywood', 'birch',
    'delrin', 'acetal', 'nylon'
  ];

  function isReviewedMaterialName(name) {
    const lower = (name || '').trim().toLowerCase();
    if (!lower) return true; // nothing typed yet - not a warning-worthy state
    if (KNOWN_MATERIAL_KEYWORDS.some((keyword) => lower.includes(keyword) || lower === keyword)) return true;
    // "poly" counts too, except "propylene" - same carve-out as the Python
    // side (Polypropylene isn't actually a reviewed material there either).
    if (lower.includes('poly') && !lower.includes('propylene')) return true;
    return false;
  }

  $: newMaterialUnreviewed = newMaterialName.trim() && !isReviewedMaterialName(newMaterialName);

  // showLoading=false for refreshes after an action (add/etc.) - flipping
  // loading back to true mid-interaction replaced the whole list with a
  // loading state and back, a jarring flash for what should be a quiet
  // re-fetch. Only the initial mount needs it.
  async function load(showLoading = true) {
    if (showLoading) loading = true;
    try {
      const [loadedCategories, materialResult] = await Promise.all([
        fetchPartCategories(),
        supabase.from('cam_materials').select('id, name, enabled').order('name')
      ]);
      if (materialResult.error) throw materialResult.error;
      categories = loadedCategories;
      materials = materialResult.data || [];
    } catch (error) {
      toastActions.show(error.message || 'Failed to load stock categories');
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function handleAdd() {
    const parsedThickness = Number(thickness);
    const materialName = newMaterialName.trim();
    if ((!selectedMaterialId && !materialName) || !Number.isFinite(parsedThickness) || parsedThickness <= 0) {
      toastActions.show('Choose or name a material and enter a positive thickness');
      return;
    }

    submitting = true;
    try {
      let materialId = selectedMaterialId;
      if (materialName) {
        const existing = materials.find((material) => material.name.trim().toLowerCase() === materialName.toLowerCase());
        if (existing) {
          materialId = existing.id;
        } else {
          const { data, error } = await supabase
            .from('cam_materials')
            .insert({ name: materialName, enabled: true })
            .select('id')
            .single();
          if (error) throw error;
          materialId = data.id;
        }
      }
      await createPartCategory({ materialId, thickness: parsedThickness });
      selectedMaterialId = '';
      newMaterialName = '';
      thickness = '';
      await load(false);
      toastActions.show('Stock category added');
    } catch (error) {
      toastActions.show(error.message || 'Failed to add stock category');
    } finally {
      submitting = false;
    }
  }

  function categoryLabel(category) {
    return `${category.cam_materials?.name || 'Material'} - ${category.thickness}\"`;
  }

  function categoryUnreviewed(category) {
    return !isReviewedMaterialName(category.cam_materials?.name);
  }

  async function handleDelete(category) {
    if (!await requestConfirmation({
      title: 'Delete stock category',
      message: `Delete "${categoryLabel(category)}"? Any part or plate still using it will fail to save.`,
      confirmLabel: 'Delete',
      danger: true
    })) return;
    deletingId = category.id;
    try {
      await deletePartCategory(category.id);
      categories = categories.filter((c) => c.id !== category.id);
      toastActions.show('Stock category deleted');
    } catch (error) {
      toastActions.show(error.message || 'Failed to delete stock category - it may still be in use by a part or plate');
    } finally {
      deletingId = null;
    }
  }
</script>

{#if loading}
  <p>Loading stock categories...</p>
{:else}
  <div class="setup-layout">
    <section class="card setup-card">
      <div class="section-heading">
        <SlidersHorizontal size={18} />
        <div>
          <h2>Stock Categories</h2>
          <p>Parts and plates can only be nested when their material and true thickness match.</p>
        </div>
      </div>

      {#if canManage}
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="existing-material">Existing material</label>
            <select id="existing-material" class="form-select" bind:value={selectedMaterialId} disabled={Boolean(newMaterialName.trim())}>
              <option value="">Select a material...</option>
              {#each materials.filter((material) => material.enabled !== false) as material}
                <option value={material.id}>{material.name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="new-material">Or add material</label>
            <input id="new-material" class="form-input" bind:value={newMaterialName} placeholder="e.g. Aluminum 6061" disabled={Boolean(selectedMaterialId)} />
          </div>
          <div class="form-group thickness-group">
            <label class="form-label" for="stock-thickness">True thickness (in)</label>
            <input id="stock-thickness" class="form-input" type="number" min="0.001" step="0.001" bind:value={thickness} placeholder="0.125" />
          </div>
        </div>
        {#if newMaterialUnreviewed}
          <p class="unreviewed-warning">
            <AlertTriangle size={14} />
            "{newMaterialName}" doesn't match a material Fusion has real cutting data for yet (aluminum, polycarbonate/Lexan,
            acrylic, MDF, SRPP, wood/plywood, Delrin/acetal, nylon). You can still add it, but any job that tries to cut this
            stock will fail until someone adds feed/speed presets for it in the CAM templates.
          </p>
        {/if}
        <button class="btn btn-secondary" type="button" disabled={submitting} on:click={handleAdd}>
          <Plus size={16} /> {submitting ? 'Adding...' : 'Add Stock Category'}
        </button>
      {:else}
        <p class="permission-note">Ask a CAM manager to add a material/thickness category.</p>
      {/if}
    </section>

    <section class="card category-list-card">
      <h2>Available Categories</h2>
      {#if categories.length}
        <div class="cam-list">
          {#each categories as category (category.id)}
            <div class="cam-list-item">
              <div class="cam-list-item-main">
                <span class="tag">{categoryLabel(category)}</span>
                {#if categoryUnreviewed(category)}
                  <span class="tag tag-warning" title="No reviewed feed/speed presets for this material yet - jobs against it will fail in Fusion">
                    <AlertTriangle size={12} /> No cutting data yet
                  </span>
                {/if}
              </div>
              {#if canManage}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  disabled={deletingId === category.id}
                  title="Delete this stock category"
                  on:click={() => handleDelete(category)}
                >
                  <Trash2 size={14} />
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty-state">No stock categories yet.</p>
      {/if}
    </section>
  </div>
{/if}

<style>
  .setup-layout { display: grid; gap: 1rem; }
  .setup-card, .category-list-card { padding: 1rem; }
  .section-heading { display: flex; align-items: flex-start; gap: 0.65rem; margin-bottom: 1rem; }
  .section-heading h2, .category-list-card h2 { margin: 0; font-size: var(--font-lg); }
  .section-heading p, .permission-note, .empty-state { margin: 0.2rem 0 0; color: var(--text-muted); }
  .form-row { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-group { flex: 1 1 12rem; min-width: 0; }
  .thickness-group { flex-basis: 9rem; }
  .unreviewed-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    background: var(--yellow-subtle, rgba(234, 179, 8, 0.12));
    color: var(--yellow-strong, #854d0e);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 0 0 0.75rem;
  }
  .unreviewed-warning :global(svg) { flex-shrink: 0; margin-top: 0.15rem; }
  .cam-list { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-3); }
  .cam-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color 0.12s ease;
  }
  .cam-list-item:hover { border-color: var(--accent-strong); }
  .cam-list-item-main { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  @media (max-width: 640px) {
    .form-group, .thickness-group { flex-basis: 100%; }
  }
</style>
