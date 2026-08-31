<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { page } from '$app/stores';

  let bins = [];
  let partsByBin = {};
  let loading = true;
  let newBinName = '';
  let newBinId = '';
  let creating = false;
   let editingBin = null; // { bin_id, name }
   let editName = '';
   let editId = '';
   let savingEdit = false;

  async function loadBins() {
    const { data, error } = await supabase.from('kitting_bins').select('bin_id, name').order('name', { ascending: true });
    if (!error) bins = data || []; else bins = [];
  }

  async function loadParts() {
    // Load all parts that have a kitting_bin set
    const { data, error } = await supabase
      .from('parts')
      .select('id, name, project_id, quantity, workflow, status, kitting_bin')
      .not('kitting_bin', 'is', null)
      .order('created_at', { ascending: false });
    if (error) { partsByBin = {}; return; }
    const map = {};
    for (const p of data || []) {
      const bin = p.kitting_bin || '';
      if (!map[bin]) map[bin] = [];
      map[bin].push(p);
    }
    partsByBin = map;
  }

  async function createBin() {
    const name = newBinName.trim();
    const bin_id = newBinId.trim();
    if (!name || !bin_id) return;
    creating = true;
    try {
      const { error } = await supabase.from('kitting_bins').insert({ bin_id, name });
      if (error) throw error;
      newBinName = '';
      newBinId = '';
      await loadBins();
    } catch (e) {
      alert('Failed to create bin: ' + (e?.message || e));
    } finally { creating = false; }
  }

  onMount(async () => {
    await loadBins();
    await loadParts();
    loading = false;
  });

  function getBinLabel(id) {
    const b = bins.find(x => x.bin_id === id);
    return b ? `${b.name} (${b.bin_id})` : id;
  }

   function openEdit(b) {
     editingBin = b;
     editName = b.name || '';
     editId = b.bin_id || '';
   }

   function closeEdit() {
     editingBin = null;
     editName = '';
     editId = '';
     savingEdit = false;
   }

   async function saveEdit() {
     if (!editingBin) return;
     const oldId = editingBin.bin_id;
     const newId = (editId || '').trim();
     const newName = (editName || '').trim();
     if (!newId || !newName) { alert('Both Bin ID and name are required'); return; }
     savingEdit = true;
     try {
       if (newId !== oldId) {
         // Ensure no conflict
         const { data: exists, error: e1 } = await supabase.from('kitting_bins').select('bin_id').eq('bin_id', newId).limit(1).maybeSingle();
         if (e1) throw e1;
         if (exists) { alert('Bin ID already exists'); savingEdit = false; return; }
         // Insert new bin
         const { error: insErr } = await supabase.from('kitting_bins').insert({ bin_id: newId, name: newName });
         if (insErr) throw insErr;
         // Update any parts referencing old bin id -> new id
         const { error: updPartsErr } = await supabase.from('parts').update({ kitting_bin: newId, updated_at: new Date().toISOString() }).eq('kitting_bin', oldId);
         if (updPartsErr) throw updPartsErr;
         // Delete old bin
         const { error: delErr } = await supabase.from('kitting_bins').delete().eq('bin_id', oldId);
         if (delErr) throw delErr;
       } else {
         // Just update name
         const { error } = await supabase.from('kitting_bins').update({ name: newName }).eq('bin_id', oldId);
         if (error) throw error;
       }
       await loadBins();
       await loadParts();
       closeEdit();
     } catch (e) {
       alert('Failed to save bin: ' + (e?.message || e));
       savingEdit = false;
     }
   }

   async function deleteBin() {
     if (!editingBin) return;
     if (!await requestConfirmation({ title: 'Delete bin', message: `Delete bin "${editingBin.name} (${editingBin.bin_id})"? This will clear kitting bin on any parts that reference it.`, confirmLabel: 'Delete bin', danger: true })) return;
     savingEdit = true;
     try {
       // Clear parts
       const { error: updPartsErr } = await supabase.from('parts').update({ kitting_bin: null, updated_at: new Date().toISOString() }).eq('kitting_bin', editingBin.bin_id);
       if (updPartsErr) throw updPartsErr;
       const { error: delErr } = await supabase.from('kitting_bins').delete().eq('bin_id', editingBin.bin_id);
       if (delErr) throw delErr;
       await loadBins();
       await loadParts();
       closeEdit();
     } catch (e) {
       alert('Failed to delete bin: ' + (e?.message || e));
       savingEdit = false;
     }
   }
</script>

<svelte:head><title>Bins</title></svelte:head>

<div class="page-header">
  <h1>Bins</h1>
  <div class="page-actions">
    <a href="/manufacture" class="btn btn-secondary">Back</a>
  </div>
  
</div>
<div class="subtabs">
  <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
  <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
  <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
  <a href="/manufacture/post-processing" class:active={$page.url.pathname === '/manufacture/post-processing'}>Post Processing</a>
  <a href="/manufacture/bins" class:active={$page.url.pathname === '/manufacture/bins'}>Bins</a>
</div>

<div class="card">
  <h2 style="margin: 0 0 0.75rem 0; font-size: 1rem;">Create Bin</h2>
  <div class="create-bin">
    <input class="form-input" placeholder="Bin name" bind:value={newBinName} />
    <input class="form-input" placeholder="Bin ID" bind:value={newBinId} />
    <button class="btn btn-primary" on:click={createBin} disabled={creating || !newBinName.trim() || !newBinId.trim()}>Add Bin</button>
  </div>
</div>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}
  <div class="table-container">
    <table class="table">
      <thead><tr><th>Bin</th><th>Parts</th></tr></thead>
      <tbody>
        {#if bins.length === 0}
          <tr><td colspan="2" class="text-muted">No bins yet. Create one above.</td></tr>
        {/if}
        {#each bins as b}
            <tr on:click={() => openEdit(b)} style="cursor: pointer;">
              <td class="mono">{b.name} <span class="text-muted">({b.bin_id})</span></td>
            <td>
              {#if (partsByBin[b.bin_id] || []).length === 0}
                <span class="text-muted">No parts</span>
              {:else}
                <ul class="parts-list">
                  {#each partsByBin[b.bin_id] as p}
                    <li>
                      <strong>{p.name}</strong>
                      <span class="mono">{p.project_id}</span>
                      <span class="tag">x{p.quantity || 1}</span>
                      <span class="tag">{p.workflow}</span>
                      <span class="tag">{p.status}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}



{#if editingBin}
  <div class="modal-backdrop" role="button" tabindex="0" aria-label="Close dialog" on:click={closeEdit} on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'Escape') closeEdit(); }}>
  <div class="modal" role="dialog" aria-modal="true" tabindex="0" style="--modal-width: 420px;" on:click|stopPropagation on:keydown={(e) => { if (e.key === 'Escape') closeEdit(); }}>
      <h3>Edit Bin</h3>
      <div style="display:flex;flex-direction:column;gap:0.5rem;">
        <label>Bin Name
          <input class="form-input" bind:value={editName} />
        </label>
        <label>Bin ID
          <input class="form-input mono" bind:value={editId} />
        </label>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.75rem;">
        <button class="btn btn-primary" on:click={saveEdit} disabled={savingEdit}>Save</button>
        <button class="btn" on:click={closeEdit} disabled={savingEdit}>Cancel</button>
        <button class="btn btn-danger" on:click={deleteBin} disabled={savingEdit}>Delete</button>
      </div>
    </div>
  </div>
  
{/if}

<style>
  .create-bin { display: flex; gap: 0.5rem; }
  .create-bin .form-input { max-width: 200px; }
  .parts-list { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 0.5rem; }
  .parts-list li { display: inline-flex; align-items: center; gap: 0.5rem; }
  .tag { border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; font-size: 0.75rem; }

  @media (max-width: 768px) {
    .create-bin {
      flex-direction: column;
    }

    .create-bin .form-input {
      max-width: none;
    }

    .parts-list li {
      width: 100%;
      flex-wrap: wrap;
      gap: 0.35rem;
    }
  }
</style>
