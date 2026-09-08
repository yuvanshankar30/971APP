<script>
  import { onMount, tick } from 'svelte';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { Layers, Package, Box, ListChecks, SlidersHorizontal, BookOpen, HelpCircle, Send, X } from 'lucide-svelte';
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
  const requestedTab = $page.url.searchParams.get('tab');
  const normalizedRequestedTab = requestedTab === 'plates' ? 'parts' : requestedTab;
  const initialManufacturingPartId = $page.url.searchParams.get('manufacturingPart') || null;

  let user = null;
  let activeTab = VALID_TABS.includes(normalizedRequestedTab) ? normalizedRequestedTab : 'parts';
  // Reference to the mounted PartsTab instance, so the page-level "Send to
  // Fusion CAM" button (see openSendToFusionCam below) can open its queue
  // picker popup from outside the Parts tab - direct instruction: this
  // button belongs up here next to Usage Guide/Runner Setup, not buried
  // per-stock-group inside the parts list.
  let partsTabRef;
  let boxTubesTabRef;
  let sendPickerOpen = false;
  let sendPickerKind = 'plates';

  $: canManage = canManageCamProfiles(user);

  function setActiveTab(tab) {
    activeTab = tab;
  }

  // Switches to the Parts tab first if it isn't already active - PartsTab
  // (and partsTabRef) only exists in the DOM while that tab is showing, so
  // openQueuePicker() can't be called until after it mounts. tick() waits
  // for that mount to actually happen before calling it.
  function openSendToFusionCam() {
    // One queue entry point for every stock type. Plates are the normal
    // workflow, so retain them as the default regardless of the active tab.
    sendPickerKind = 'plates';
    sendPickerOpen = true;
  }

  async function continueToQueuePicker() {
    const tubeStock = sendPickerKind === 'tubes';
    sendPickerOpen = false;
    const targetTab = tubeStock ? 'box-tubes' : 'parts';
    if (activeTab !== targetTab) {
      activeTab = targetTab;
      await tick();
    }
    if (tubeStock) boxTubesTabRef?.openQueuePicker();
    else partsTabRef?.openQueuePicker();
  }

  onMount(() => {
    const unsub = userStore.subscribe((v) => { user = v; });
    (async () => {
      await loadUserFromUUID(supabase);
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

<nav class="tab-nav" role="tablist" aria-label="Fusion CAM sections">
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

{#if canManage && sendPickerOpen}
  <div class="modal-overlay" role="presentation" on:click={() => (sendPickerOpen = false)}>
    <div class="modal send-kind-modal" role="dialog" aria-labelledby="send-kind-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="send-kind-title">Send to Fusion CAM</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" aria-label="Close" on:click={() => (sendPickerOpen = false)}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label" for="send-stock-kind">Stock type</label>
          <select id="send-stock-kind" class="form-select" bind:value={sendPickerKind}>
            <option value="plates">Plates</option>
            <option value="tubes">Tube stock</option>
          </select>
        </div>
      </div>
      <div class="modal-footer-actions">
        <button type="button" class="btn btn-ghost" on:click={() => (sendPickerOpen = false)}>Cancel</button>
        <button type="button" class="btn btn-primary" on:click={continueToQueuePicker}><Send size={14} /> Continue</button>
      </div>
    </div>
  </div>
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
  .send-kind-modal { --modal-width: 28rem; }
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
