<script>
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { Layers, Package, Box, ListChecks, SlidersHorizontal, BookOpen, HelpCircle, Send, RotateCcw, Zap, X, Wrench, Plus, Filter } from 'lucide-svelte';
  import PartsTab from './PartsTab.svelte';
  import BoxTubesTab from './BoxTubesTab.svelte';
  import JobQueueTab from './JobQueueTab.svelte';
  import StockCategoriesTab from './StockCategoriesTab.svelte';
  import TurningTab from './TurningTab.svelte';
  import AtcSlotConfig from '$autocam/components/AtcSlotConfig.svelte';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';

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

  // Add button + Search/Project/Season filters used to live inside each of
  // Parts/Tube Stock/Turning's own toolbar, repeated three times - moved up
  // here onto the shared tab bar (direct instruction) so there's one Add
  // button and one filter row instead of three near-identical copies, and
  // it visually merges into the same bar as the Parts/Tube Stock/Turning
  // tabs themselves rather than floating as its own separate box below.
  // Each tab still owns its actual list/filtering logic - these are bound
  // straight through to whichever tab is active (see the template below).
  let search = '';
  let filterProject = '';
  let filterSeason = '';
  let projectIds = [];
  let seasonOptions = [];
  const TOOLBAR_CONFIG = {
    parts: { addLabel: 'Add Part', searchPlaceholder: 'Search parts by name, project, or material...' },
    'box-tubes': { addLabel: 'Add Tube Stock', searchPlaceholder: 'Search tube stock by name or project...' },
    turning: { addLabel: 'Add Turning Stock', searchPlaceholder: 'Search turning stock by name or project...' }
  };
  $: toolbarConfig = TOOLBAR_CONFIG[activeTab] || null;

  function handleAddClick() {
    if (activeTab === 'parts') partsTabRef?.openAddForm();
    else if (activeTab === 'box-tubes') boxTubesTabRef?.openAddForm();
    else if (activeTab === 'turning') turningTabRef?.openAddForm();
  }

  function setActiveTab(tab) {
    // Each tab's own list/filters are independent - starting fresh on
    // every switch matches what already happened before this moved up
    // here, since {#if activeTab === ...} below destroys and remounts the
    // previous tab's component (and its now-lifted state) either way.
    search = '';
    filterProject = '';
    filterSeason = '';
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
  <div class="page-actions">
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

<div class="tab-nav-bar">
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
  {#if toolbarConfig}
    <div class="cam-list-toolbar">
      {#if canManage}
        <div class="tab-actions">
          <button type="button" class="btn btn-primary" on:click={handleAddClick}>
            <Plus size={16} /> {toolbarConfig.addLabel}
          </button>
        </div>
      {/if}
      <div class="filters tab-filters">
        <div class="form-group">
          <label class="form-label" for="fusion-tab-search">Search</label>
          <input
            id="fusion-tab-search"
            type="search"
            class="form-input"
            placeholder={toolbarConfig.searchPlaceholder}
            bind:value={search}
            aria-label="Search"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="fusion-tab-project-filter"><Filter size={14} /> Project</label>
          <select id="fusion-tab-project-filter" class="form-select" bind:value={filterProject}>
            <option value="">All Projects</option>
            {#each projectIds as pid}<option value={pid}>{pid}</option>{/each}
          </select>
        </div>
        <SeasonFilter options={seasonOptions} bind:value={filterSeason} />
      </div>
    </div>
  {/if}
</div>

{#if activeTab === 'parts'}
  <PartsTab
    bind:this={partsTabRef} {user} {canManage} {initialManufacturingPartId}
    bind:partsListSearch={search} bind:filterProject bind:filterSeason bind:projectIds bind:seasonOptions
  />
{:else if activeTab === 'stock-categories'}
  <StockCategoriesTab {canManage} />
{:else if activeTab === 'box-tubes'}
  <BoxTubesTab
    bind:this={boxTubesTabRef} {user} {canManage}
    bind:boxTubesListSearch={search} bind:filterProject bind:filterSeason bind:projectIds bind:seasonOptions
  />
{:else if activeTab === 'turning'}
  <TurningTab
    bind:this={turningTabRef} {user} {canManage}
    bind:turningListSearch={search} bind:filterProject bind:filterSeason bind:projectIds bind:seasonOptions
  />
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
  /* .cam-list-toolbar/.tab-actions/.tab-filters below come from here - the
     Add button + filters row used to live inside each of Parts/Tube
     Stock/Turning's own <style> (which already @imports this), now it
     lives up here instead since the row itself moved up to this shell. */
  @import '../fusion/_autocam-shared.css';

  /* This page used to redefine the site's own --background/--accent/etc.
     custom properties to force a black/blue/gold look
     regardless of which Spartans Hub theme (light/dark/modern/legacy) was
     actually selected. That's reversed
     now: this page should look like the rest of Spartans Hub, using
     whatever theme the user has picked, the same way /autocam's own page
     already does (compare its .page-header/tab structure - no page-scoped
     theme override there either). Only page-specific LAYOUT rules remain
     below; all colors now come from the real site tokens in src/app.css. */

  /* .page-header/.page-actions are the same global classes Manufacturing
     (src/routes/manufacture/+page.svelte) uses for its own header actions -
     reused directly here instead of the bespoke header-guide-links rule
     this page used to define. The tab bar itself reverted back to this
     page's own underline-tab style below (Manufacturing's .subtabs pill
     look didn't render cleanly for a <button>-based switcher - see the
     reverted attempt's own history). Kept as an underline style on redesign
     too, just tightened up - a heavier active state (bold label + a thicker
     accent rule) and a hairline separator so the row reads as one connected
     bar rather than floating buttons above the page content. */
  .page-header h1 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  /* One horizontal row - tabs, Add button, and filters all inline, instead
     of the tabs stacked above a second Add-button/filters row. .tab-nav
     and .cam-list-toolbar are each already their own internal flex row
     (tab buttons; Add button + filter fields), so laying THIS wrapper out
     as a row too, with those two as its only two flex items, is enough to
     put everything on one line without restructuring either of them. */
  .tab-nav-bar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    margin: var(--space-4) 0 var(--space-6);
    padding: 0 var(--space-3);
    overflow-x: auto;
  }
  .tab-nav-bar .cam-list-toolbar {
    flex: 1 1 auto;
    flex-wrap: nowrap;
    align-items: center;
    border: none;
    border-radius: 0;
    margin: 0;
    padding: var(--space-2) 0;
    background: none;
  }
  .tab-nav {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-shrink: 0;
    margin: 0;
  }
  .tab-nav button {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: var(--space-3) var(--space-3);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
    font-size: 0.9rem;
    font-weight: 500;
    transition: color 0.12s ease, background-color 0.12s ease, border-color 0.12s ease;
  }
  .tab-nav button:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .tab-nav button.active {
    background: none;
    color: var(--accent-strong);
    font-weight: 700;
    border-bottom-color: var(--accent);
  }
  .quick-queue-choice-modal { width: min(420px, 92vw); }
  .quick-queue-choice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-top: var(--space-3); }
  .quick-queue-choice-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text);
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 0.12s ease, background-color 0.12s ease;
  }
  .quick-queue-choice-button:hover, .quick-queue-choice-button:focus-visible {
    border-color: var(--accent-strong);
    background: var(--surface-1);
    outline: none;
  }
</style>
