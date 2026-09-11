<script>
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { Layers, Package, Box, ListChecks, SlidersHorizontal, BookOpen, HelpCircle, Send, RotateCcw, Zap, X, Wrench } from 'lucide-svelte';
  import PartsTab from './PartsTab.svelte';
  import BoxTubesTab from './BoxTubesTab.svelte';
  import JobQueueTab from './JobQueueTab.svelte';
  import StockCategoriesTab from './StockCategoriesTab.svelte';
  import TurningTab from './TurningTab.svelte';
  import AtcSlotConfig from '$autocam/components/AtcSlotConfig.svelte';

  // Deep link from Manufacturing's "Open Fusion CAM" button
  // (/manufacture's fusionCamHref) - ?tab=parts&manufacturingPart=<id>
  // jumps straight to the Parts tab with that request pre-filled. 'plates'
  // is accepted too and mapped onto 'parts' for old links/bookmarks from
  // before #448 merged the separate Plates tab into this one - a plate's
  // stock category now renders directly under that category's parts here.
  const VALID_TABS = ['parts', 'box-tubes', 'turning', 'queue', 'stock-categories'];
  const TAB_PATHS = {
    parts: '/autocam/fusion/parts',
    'box-tubes': '/autocam/fusion/tubes',
    turning: '/autocam/fusion/turning',
    queue: '/autocam/fusion/jobs',
    'stock-categories': '/autocam/fusion/stock-categories'
  };
  export let forcedTab = null;
  const requestedTab = $page.url.searchParams.get('tab');
  const normalizedRequestedTab = requestedTab === 'plates' ? 'parts' : requestedTab;
  const initialManufacturingPartId = $page.url.searchParams.get('manufacturingPart') || null;
  const openQueueOnMount = $page.url.searchParams.get('openQueue') === '1';
  // 'parts' or 'box-tubes' - set when Quick Queue's Plate/Tube choice sent
  // the operator to a different tab route than the one they started on
  // (see chooseQuickQueue below); read once on the fresh page load that
  // navigation lands on, same pattern as openQueueOnMount above.
  const quickQueueKindOnMount = $page.url.searchParams.get('quickQueue');

  let user = null;
  let activeTab = VALID_TABS.includes(forcedTab) ? forcedTab : (VALID_TABS.includes(normalizedRequestedTab) ? normalizedRequestedTab : 'parts');
  // Reference to the mounted PartsTab instance, so the page-level "Send to
  // Fusion CAM" button (see openSendToFusionCam below) can open its queue
  // picker popup from outside the Parts tab - direct instruction: this
  // button belongs up here next to Usage Guide/Runner Setup, not buried
  // per-stock-group inside the parts list.
  let partsTabRef;
  let boxTubesTabRef;
  let turningTabRef;
  // "Quick Queue": add a brand new part/tube and queue it in one flow,
  // instead of the normal two separate steps (add stock, then separately
  // find and queue it). This page-level button only needs to ask Plate vs
  // Tube; PartsTab/BoxTubesTab's own openQuickQueue() reuses their
  // existing New Part/Tube form and, on save, chains straight into their
  // existing queue picker (router/tool/mode, then the same naming/location
  // popup Send to Fusion CAM already uses) - no new queueing UI here.
  let quickQueueChoiceOpen = false;

  // ATC Slots entry point - lives here (next to Send to Fusion CAM) rather
  // than only on the /autocam admin page, since that's a Machine Profiles
  // admin surface an operator queueing jobs day to day never visits, while
  // this page is exactly where they'd notice a picker missing a tool.
  let atcTools = [];
  let atcMachineId = null;
  let atcMachineName = '';
  let showAtcModal = false;

  async function loadAtcMachine() {
    const { data } = await supabase.from('cam_tools').select('*').eq('enabled', true);
    atcTools = data || [];
    if (!atcTools.some((t) => t.tool_number != null)) return;
    const { data: machine } = await supabase.from('cam_machines').select('id, name').eq('name', 'New Router').maybeSingle();
    if (machine) { atcMachineId = machine.id; atcMachineName = machine.name; }
  }

  function openAtcModal() {
    if (!atcMachineId) return;
    showAtcModal = true;
  }

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
    else if (activeTab === 'turning') turningTabRef?.openQueuePicker();
    else await goto('/autocam/fusion/parts?openQueue=1');
  }

  function openQuickQueueChoice() {
    quickQueueChoiceOpen = true;
  }

  // kind is 'parts' or 'box-tubes'. Unlike Send to Fusion CAM (which reuses
  // whatever's already on screen), Quick Queue's whole point is adding
  // something new, so the operator picks the kind here rather than it
  // being implied by the current tab - a goto is needed whenever that
  // differs from the tab already showing, same reasoning as
  // openSendToFusionCam's own tab-switch case.
  async function chooseQuickQueue(kind) {
    quickQueueChoiceOpen = false;
    if (kind === 'box-tubes') {
      if (activeTab === 'box-tubes') boxTubesTabRef?.openQuickQueue();
      else await goto('/autocam/fusion/tubes?quickQueue=box-tubes');
    } else {
      if (activeTab === 'parts') partsTabRef?.openQuickQueue();
      else await goto('/autocam/fusion/parts?quickQueue=parts');
    }
  }

  onMount(() => {
    const unsub = userStore.subscribe((v) => { user = v; });
    loadAtcMachine();
    (async () => {
      await loadUserFromUUID(supabase);
      if (openQueueOnMount) {
        await tick();
        partsTabRef?.openQueuePicker();
      }
      if (quickQueueKindOnMount === 'box-tubes') {
        await tick();
        boxTubesTabRef?.openQuickQueue();
      } else if (quickQueueKindOnMount === 'parts') {
        await tick();
        partsTabRef?.openQuickQueue();
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
      <button type="button" class="btn btn-secondary btn-sm" on:click={openQuickQueueChoice}>
        <Zap size={14} /> Quick Queue
      </button>
      <button type="button" class="btn btn-primary btn-sm" on:click={openSendToFusionCam}>
        <Send size={14} /> Send to Fusion CAM
      </button>
      {#if atcMachineId}
        <button type="button" class="btn btn-secondary btn-sm" on:click={openAtcModal}>
          <Wrench size={14} /> ATC Slots
        </button>
      {/if}
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
  <button type="button" class:active={activeTab === 'turning'} on:click={() => setActiveTab('turning')}>
    <RotateCcw size={16} /> Turning
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
{:else if activeTab === 'turning'}
  <TurningTab bind:this={turningTabRef} {user} {canManage} />
{:else if activeTab === 'queue'}
  <JobQueueTab />
{/if}

{#if quickQueueChoiceOpen}
  <div class="modal-overlay" role="presentation" on:click={() => (quickQueueChoiceOpen = false)}>
    <div class="modal quick-queue-choice-modal" role="dialog" aria-labelledby="quick-queue-choice-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="quick-queue-choice-title">Quick Queue</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={() => (quickQueueChoiceOpen = false)}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <p class="cam-form-hint">What are you adding? Fill it in, then choose a router and tool to queue it right away.</p>
        <div class="quick-queue-choice-grid">
          <button type="button" class="quick-queue-choice-button" on:click={() => chooseQuickQueue('parts')}>
            <Package size={22} />
            <span>Plate</span>
          </button>
          <button type="button" class="quick-queue-choice-button" on:click={() => chooseQuickQueue('box-tubes')}>
            <Box size={22} />
            <span>Tube</span>
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<AtcSlotConfig
  bind:open={showAtcModal}
  machineId={atcMachineId}
  machineName={atcMachineName}
  tools={atcTools}
  userId={user?.id || null}
  on:applied={loadAtcMachine}
  on:toolsChanged={loadAtcMachine}
/>

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
  .quick-queue-choice-modal { width: min(420px, 92vw); }
  .quick-queue-choice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.75rem; }
  .quick-queue-choice-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.25rem 0.75rem;
    background: var(--surface-2, #f7f7f5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 10px);
    color: var(--text);
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .quick-queue-choice-button:hover, .quick-queue-choice-button:focus-visible {
    border-color: var(--accent);
    background: var(--surface);
    outline: none;
  }
</style>
