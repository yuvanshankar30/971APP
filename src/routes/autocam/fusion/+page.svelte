<script>
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { Layers, Package, Box, ListChecks, SlidersHorizontal, BookOpen, HelpCircle, Send } from 'lucide-svelte';
  import PartsTab from './PartsTab.svelte';
  import BoxTubesTab from './BoxTubesTab.svelte';
  import JobQueueTab from './JobQueueTab.svelte';
  import StockCategoriesTab from './StockCategoriesTab.svelte';

  // Deep link from Manufacturing's "Open Fusion CAM" button
  // (/manufacture's fusionCamHref) - ?tab=parts&manufacturingPart=<id>
  // jumps straight to the Parts tab with that request pre-filled. 'plates'
  // is accepted too and mapped onto 'parts' for old links/bookmarks from
  // before #448 merged the separate Plates tab into this one - a plate's
  // stock category now renders directly under that category's parts here.
  const VALID_TABS = ['parts', 'box-tubes', 'queue', 'stock-categories'];
  const TAB_PATHS = {
    parts: '/autocam/fusion/parts',
    'box-tubes': '/autocam/fusion/tubes',
    queue: '/autocam/fusion/jobs',
    'stock-categories': '/autocam/fusion/stock-categories'
  };
  export let forcedTab = null;
  const requestedTab = $page.url.searchParams.get('tab');
  const normalizedRequestedTab = requestedTab === 'plates' ? 'parts' : requestedTab;
  const initialManufacturingPartId = $page.url.searchParams.get('manufacturingPart') || null;
  const openQueueOnMount = $page.url.searchParams.get('openQueue') === '1';

  let user = null;
  let activeTab = VALID_TABS.includes(forcedTab) ? forcedTab : (VALID_TABS.includes(normalizedRequestedTab) ? normalizedRequestedTab : 'parts');
  // Reference to the mounted PartsTab instance, so the page-level "Send to
  // Fusion CAM" button (see openSendToFusionCam below) can open its queue
  // picker popup from outside the Parts tab - direct instruction: this
  // button belongs up here next to Usage Guide/Runner Setup, not buried
  // per-stock-group inside the parts list.
  let partsTabRef;
  let boxTubesTabRef;

  $: canManage = canManageCamProfiles(user);

  function setActiveTab(tab) {
    goto(TAB_PATHS[tab]);
  }

  // Switches to the Parts tab first if it isn't already active - PartsTab
  // (and partsTabRef) only exists in the DOM while that tab is showing, so
  // openQueuePicker() can't be called until after it mounts. tick() waits
  // for that mount to actually happen before calling it.
  async function openSendToFusionCam() {
    // A tab route already establishes the stock type. Do not make the
    // operator choose it again in an intermediate dialog.
    if (activeTab === 'box-tubes') boxTubesTabRef?.openQueuePicker();
    else if (activeTab === 'parts') partsTabRef?.openQueuePicker();
    else await goto('/autocam/fusion/parts?openQueue=1');
  }

  onMount(() => {
    const unsub = userStore.subscribe((v) => { user = v; });
    (async () => {
      await loadUserFromUUID(supabase);
      if (openQueueOnMount) {
        await tick();
        partsTabRef?.openQueuePicker();
      }
    })();
    return unsub;
  });
</script>

<svelte:head><title>Fusion AutoCAM | Spartans Hub</title></svelte:head>

<div class="page-header">
  <h1><Layers size={28} /> Fusion AutoCAM</h1>
  <div class="header-guide-links">
    {#if canManage}
      <button type="button" class="btn btn-primary btn-sm" on:click={openSendToFusionCam}>
        <Send size={14} /> Send to Fusion CAM
      </button>
    {/if}
    <a class="btn btn-secondary btn-sm" href="/autocam/fusion/usage">
      <HelpCircle size={14} /> Usage Guide
    </a>
    <a class="btn btn-secondary btn-sm" href="/autocam/fusion/setup">
      <BookOpen size={14} /> Runner Setup
    </a>
  </div>
</div>

<nav class="tab-nav" aria-label="Fusion AutoCAM sections">
  <button type="button" class:active={activeTab === 'parts'} on:click={() => setActiveTab('parts')}>
    <Package size={16} /> Parts
  </button>
  <button type="button" class:active={activeTab === 'box-tubes'} on:click={() => setActiveTab('box-tubes')}>
    <Box size={16} /> Tube Stock
  </button>
  <button type="button" class:active={activeTab === 'queue'} on:click={() => setActiveTab('queue')}>
    <ListChecks size={16} /> Jobs
  </button>
  <button type="button" class:active={activeTab === 'stock-categories'} on:click={() => setActiveTab('stock-categories')}>
    <SlidersHorizontal size={16} /> Stock Categories
  </button>
</nav>

{#if activeTab === 'parts'}
  <PartsTab bind:this={partsTabRef} {user} {canManage} {initialManufacturingPartId} />
{:else if activeTab === 'stock-categories'}
  <StockCategoriesTab {canManage} />
{:else if activeTab === 'box-tubes'}
  <BoxTubesTab bind:this={boxTubesTabRef} {user} {canManage} />
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
