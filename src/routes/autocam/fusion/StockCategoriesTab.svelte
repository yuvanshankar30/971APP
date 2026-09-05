<script>
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { supabase } from '$lib/supabase.js';
  import { createPartCategory, fetchPartCategories } from '$lib/fusionCam.js';
  import { Plus, SlidersHorizontal } from 'lucide-svelte';

  export let canManage;

  let categories = [];
  let materials = [];
  let loading = true;
  let submitting = false;
  let selectedMaterialId = '';
  let newMaterialName = '';
  let thickness = '';

  async function load() {
    loading = true;
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
      await load();
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
        <button class="btn btn-primary" type="button" disabled={submitting} on:click={handleAdd}>
          <Plus size={16} /> {submitting ? 'Adding...' : 'Add Stock Category'}
        </button>
      {:else}
        <p class="permission-note">Ask a CAM manager to add a material/thickness category.</p>
      {/if}
    </section>

    <section class="card category-list-card">
      <h2>Available Categories</h2>
      {#if categories.length}
        <div class="category-list">
          {#each categories as category}
            <span class="tag">{categoryLabel(category)}</span>
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
  .category-list { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  @media (max-width: 640px) {
    .form-group, .thickness-group { flex-basis: 100%; }
  }
</style>
