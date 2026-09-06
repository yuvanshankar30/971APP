<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { Layers, Package, Box, ListChecks, SlidersHorizontal, BookOpen, HelpCircle } from 'lucide-svelte';
  import PartsTab from './PartsTab.svelte';
  import PlatesTab from './PlatesTab.svelte';
  import BoxTubesTab from './BoxTubesTab.svelte';
  import JobQueueTab from './JobQueueTab.svelte';
  import StockCategoriesTab from './StockCategoriesTab.svelte';

  let user = null;
  let activeTab = 'plates';
  let plateCategoryFilter = '';

  function viewMatchingPlates(categoryId) {
    plateCategoryFilter = categoryId;
    activeTab = 'plates';
  }

  $: canManage = canManageCamProfiles(user);

  function setActiveTab(tab) {
    plateCategoryFilter = '';
    activeTab = tab;
  }

  onMount(() => {
    const unsub = userStore.subscribe((v) => { user = v; });
    (async () => {
      await loadUserFromUUID(supabase);
    })();
    return unsub;
  });
</script>

<svelte:head><title>Fusion CAM | Spartans Hub</title></svelte:head>

<div class="page-header">
  <h1><Layers size={28} /> Fusion CAM</h1>
  <div class="header-guide-links">
    <a class="btn btn-secondary btn-sm" href="/autocam/fusion/usage">
      <HelpCircle size={14} /> Usage Guide
    </a>
    <a class="btn btn-secondary btn-sm" href="/autocam/fusion/setup">
      <BookOpen size={14} /> Runner Setup
    </a>
  </div>
</div>

<nav class="tab-nav" role="tablist" aria-label="Fusion CAM sections">
  <button type="button" class:active={activeTab === 'plates'} on:click={() => setActiveTab('plates')}>
    <Layers size={16} /> Plates
  </button>
  <button type="button" class:active={activeTab === 'parts'} on:click={() => setActiveTab('parts')}>
    <Package size={16} /> Parts
  </button>
  <button type="button" class:active={activeTab === 'box-tubes'} on:click={() => setActiveTab('box-tubes')}>
    <Box size={16} /> Box Tubes
  </button>
  <button type="button" class:active={activeTab === 'queue'} on:click={() => setActiveTab('queue')}>
    <ListChecks size={16} /> Jobs
  </button>
  <button type="button" class:active={activeTab === 'stock-categories'} on:click={() => setActiveTab('stock-categories')}>
    <SlidersHorizontal size={16} /> Stock Categories
  </button>
</nav>

{#if activeTab === 'plates'}
  <PlatesTab {user} {canManage} bind:categoryFilter={plateCategoryFilter} />
{:else if activeTab === 'parts'}
  <PartsTab {user} {canManage} onViewPlates={viewMatchingPlates} />
{:else if activeTab === 'stock-categories'}
  <StockCategoriesTab {canManage} />
{:else if activeTab === 'box-tubes'}
  <BoxTubesTab {user} {canManage} />
{:else if activeTab === 'queue'}
  <JobQueueTab />
{/if}

<style>
  /* This page used to redefine the site's own --background/--accent/etc.
     custom properties to force a black/blue/gold look
     regardless of which Spartans Hub theme (light/dark/modern/legacy) was
     actually selected. That's reversed
     now: this page should look like the rest of Spartans Hub, using
     whatever theme the user has picked, the same way /autocam's own page
     already does (compare its .page-header/tab structure - no page-scoped
     theme override there either). Only page-specific LAYOUT rules remain
     below; all colors now come from the real site tokens in src/app.css. */

  .header-guide-links {
    display: flex;
    gap: 0.5rem;
  }
  .tab-nav {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border);
    margin: 1rem 0 1.5rem;
    overflow-x: auto;
  }
  .tab-nav button {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.6rem 1rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
    font-size: 0.95rem;
    border-radius: 8px 8px 0 0;
    transition: color 0.15s, background 0.15s;
  }
  .tab-nav button:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .tab-nav button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
</style>
