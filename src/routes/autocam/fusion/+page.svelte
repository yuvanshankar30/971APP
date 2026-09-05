<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { Layers, Package, Box, ListChecks, SlidersHorizontal } from 'lucide-svelte';
  import PartsTab from './PartsTab.svelte';
  import PlatesTab from './PlatesTab.svelte';
  import BoxTubesTab from './BoxTubesTab.svelte';
  import JobQueueTab from './JobQueueTab.svelte';
  import StockCategoriesTab from './StockCategoriesTab.svelte';

  let user = null;
  let activeTab = 'plates';

  $: canManage = canManageCamProfiles(user);

  function setActiveTab(tab) {
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
</div>
<p class="page-subtitle">
  Real 3-axis milling via Fusion 360's own CAM engine - a separate pipeline from the code-based
  <a href="/autocam">AutoCAM</a> turning/routing generator, for parts that need genuine contoured toolpaths a
  flat 2.5D profile can't represent. Nest parts onto plates or queue box-tube jobs here; a Fusion 360 Runner
  (see <code>valor6800-autocam-runner-setup.md</code>) claims queued jobs and reports G-code back.
</p>

<nav class="tab-nav" role="tablist" aria-label="Fusion CAM sections">
  <button type="button" class:active={activeTab === 'plates'} on:click={() => setActiveTab('plates')}>
    <Layers size={16} /> Plates
  </button>
  <button type="button" class:active={activeTab === 'parts'} on:click={() => setActiveTab('parts')}>
    <Package size={16} /> Parts
  </button>
  <button type="button" class:active={activeTab === 'stock-categories'} on:click={() => setActiveTab('stock-categories')}>
    <SlidersHorizontal size={16} /> Stock Categories
  </button>
  <button type="button" class:active={activeTab === 'box-tubes'} on:click={() => setActiveTab('box-tubes')}>
    <Box size={16} /> Box Tubes
  </button>
  <button type="button" class:active={activeTab === 'queue'} on:click={() => setActiveTab('queue')}>
    <ListChecks size={16} /> Job Queue
  </button>
</nav>

{#if activeTab === 'plates'}
  <PlatesTab {user} {canManage} />
{:else if activeTab === 'parts'}
  <PartsTab {user} {canManage} />
{:else if activeTab === 'stock-categories'}
  <StockCategoriesTab {canManage} />
{:else if activeTab === 'box-tubes'}
  <BoxTubesTab {user} {canManage} />
{:else if activeTab === 'queue'}
  <JobQueueTab />
{/if}

<style>
  /* This page used to redefine the site's own --background/--accent/etc.
     custom properties to force Valor 6800 AutoCAM's black/blue/gold look
     regardless of which Spartans Hub theme (light/dark/modern/legacy) was
     actually selected - a deliberate "restyle like the vendored original"
     decision at the time (see autocam/fusion/README.md). That's reversed
     now: this page should look like the rest of Spartans Hub, using
     whatever theme the user has picked, the same way /autocam's own page
     already does (compare its .page-header/tab structure - no page-scoped
     theme override there either). Only page-specific LAYOUT rules remain
     below; all colors now come from the real site tokens in src/app.css. */

  .page-subtitle a {
    color: var(--accent);
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
