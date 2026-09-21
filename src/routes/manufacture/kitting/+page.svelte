<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { page } from '$app/stores';

  let loading = true;
  let items = [];
  let errorMsg = '';

  async function loadKitting() {
    try {
      const { data, error } = await supabase
        .from('kitting')
        .select('id, name, project_id, requester, quantity, status, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

      if (error) throw error;
      items = data || [];
    } catch (e) {
      errorMsg = e?.message || String(e);
      items = [];
    }
  }

  async function markKitted(id) {
    try {
      const { error } = await supabase
        .from('kitting')
        .update({ status: 'kitted', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      await loadKitting();
    } catch (e) {
      alert('Failed to mark as kitted: ' + (e?.message || e));
    }
  }

  onMount(async () => {
    await loadKitting();
    loading = false;
  });
</script>

<svelte:head><title>Kitting</title></svelte:head>

<div class="page-header">
  <h1>Kitting</h1>
  <div class="page-actions">
    <a href="/manufacture" class="btn btn-secondary">Back</a>
  </div>
</div>

<div class="subtabs subtabs-tight">
  <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
  <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
  <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
  <a href="/manufacture/kitting" class:active={$page.url.pathname === '/manufacture/kitting'}>Kitting</a>
  <a href="/manufacture/files" class:active={$page.url.pathname === '/manufacture/files'}>Files</a>
</div>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}
  {#if errorMsg}
    <div class="card"><p class="text-error">Error: {errorMsg}</p></div>
  {/if}
  <div class="table-container">
    <table class="table">
      <thead>
        <tr>
          <th>Part</th>
          <th>Project</th>
          <th>Requester</th>
          <th>Qty</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {#if (items || []).length === 0}
          <tr><td colspan="5" class="text-muted">No items to kit.</td></tr>
        {:else}
          {#each items as it}
            <tr>
              <td class="strong">{it.name}</td>
              <td class="mono">{it.project_id}</td>
              <td>{it.requester}</td>
              <td class="mono">x{it.quantity || 1}</td>
              <td>
                <button class="btn btn-primary btn-sm" on:click={() => markKitted(it.id)}>Kit</button>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  <div class="mobile-kitting-list">
    {#if (items || []).length === 0}
      <div class="card"><p class="text-muted">No items to kit.</p></div>
    {:else}
      {#each items as it}
        <div class="card mobile-kitting-card">
          <div><strong>{it.name}</strong></div>
          <div class="mono">{it.project_id}</div>
          <div class="text-muted">{it.requester}</div>
          <div class="mono">x{it.quantity || 1}</div>
          <button class="btn btn-primary btn-sm" on:click={() => markKitted(it.id)}>Kit</button>
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  /* Same fix as /manufacture's ToDo/Completed pages: the sub-tabs used to
     sit right above whatever card follows, but with their own separate
     bottom margin stacked on top of that card's own top margin - a dead
     gap between two independently-margined blocks. */
  .subtabs-tight {
    margin: 0 0 var(--space-3);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .mobile-kitting-list {
    display: none;
  }

  .mobile-kitting-card {
    display: grid;
    gap: var(--gap-2);
  }

  @media (max-width: 768px) {
    .table-container {
      display: none;
    }

    .mobile-kitting-list {
      display: grid;
      gap: var(--gap-3);
    }
  }
</style>
