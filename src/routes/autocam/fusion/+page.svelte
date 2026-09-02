<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canManageCamProfiles } from '$lib/permissions.js';
  import { Layers, Package, Box, ListChecks } from 'lucide-svelte';
  import PartsTab from './PartsTab.svelte';
  import PlatesTab from './PlatesTab.svelte';
  import BoxTubesTab from './BoxTubesTab.svelte';
  import JobQueueTab from './JobQueueTab.svelte';

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

<div class="fusion-cam-theme">
  <div class="page-header">
    <h1 class="valor-heading"><Layers size={28} /> Fusion CAM</h1>
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
  {:else if activeTab === 'box-tubes'}
    <BoxTubesTab {user} {canManage} />
  {:else if activeTab === 'queue'}
    <JobQueueTab />
  {/if}
</div>

<style>
  /* Valor 6800 AutoCAM color language, scoped to this page only (per an
     explicit "restyle, don't duplicate their whole sidebar shell" decision -
     see autocam/fusion/README.md). Values pulled directly from the vendored
     original's own design tokens: autocam/fusion/_upstream/app/globals.css
     (page colors, accent blue, button treatment) and
     autocam/fusion/_upstream/app/dashboard/layout.module.css (gold accent,
     surface tones). This app's entire .btn/.card/.form-input/.tag system is
     already built on CSS custom properties (see src/app.css's :root and
     [data-theme="modern-dark"] blocks) - redefining those same tokens here,
     scoped to .fusion-cam-theme, re-skins every shared component this page
     already uses without duplicating their rules or touching the rest of
     the site. Custom properties inherit down the DOM by default, so this
     cascades into PlatesTab/PartsTab/BoxTubesTab/JobQueueTab automatically. */
  .fusion-cam-theme {
    --background: #000000;
    --primary: #141414;
    --secondary: #f0f6fc;
    --card: #141414;
    --surface-1: #141414;
    --surface-2: #1c1c1c;
    --surface-3: #22272e;
    --text: #c9d1d9;
    --text-secondary: #9aa1a9;
    --text-muted: #9aa1a9;
    --muted: #9aa1a9;
    --muted-bg: #1c1c1c;
    --border: #3d444d;
    --divider: #3d444d;
    --accent: #2f81f7;
    --accent-strong: #1f6feb;
    --accent-subtle: rgba(47, 129, 247, 0.12);
    --on-primary: #ffffff;

    --success: #2ea043;
    --danger: #f85149;
    --info: #2f81f7;
    --warning: #e6dd5e;

    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 10px;
    --shadow-sm: 0 1px 0 rgba(31, 35, 40, 0.2), 0 8px 24px rgba(1, 4, 9, 0.5);
    --shadow-lg: 0 4px 8px rgba(31, 35, 40, 0.24), 0 12px 28px rgba(1, 4, 9, 0.55);

    /* Buttons: Valor's own accent-blue treatment, not this app's default
       gold-on-hover convention (--btn-hover-bg-default normally points at
       --brand-gold-base site-wide - overridden here so it doesn't fight
       the blue accent Valor actually uses for primary actions). */
    --btn-bg-default: var(--accent);
    --btn-color-default: #ffffff;
    --btn-border-default: var(--accent);
    --btn-hover-bg-default: var(--accent-strong);
    --btn-hover-color-default: #ffffff;
    --btn-hover-border-default: var(--accent-strong);
    --btn-radius-default: 8px;
    --btn-focus-ring: rgba(56, 139, 253, 0.35);
    --btn-disabled-opacity: 0.6;

    background: var(--background);
    color: var(--text);
    padding: 1rem;
    border-radius: 12px;
  }

  /* Valor's signature gold text-gradient treatment on their brand mark -
     see .textGradient in the vendored globals.css. */
  .valor-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    /* Was a hardcoded off-white -> acid-yellow gradient clipped to the text,
       a colour pair the rest of the app never uses and which ignored the
       theme entirely. Plain brand gold reads the same emphasis without it. */
    color: var(--brand-gold-strong);
  }

  .fusion-cam-theme :global(.card),
  .fusion-cam-theme :global(.surface-card),
  .fusion-cam-theme :global(.panel) {
    transition: box-shadow 160ms ease, transform 160ms ease;
  }
  .fusion-cam-theme :global(.card:hover),
  .fusion-cam-theme :global(.surface-card:hover) {
    transform: translateY(-2px);
    box-shadow: var(--shadow-lg);
  }

  /* Valor's category pills are fully rounded, not the site's default
     --radius-sm rectangular tag. */
  .fusion-cam-theme :global(.tag) {
    border-radius: 999px;
  }

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
    background: rgba(255, 255, 255, 0.04);
  }
  .tab-nav button.active {
    color: #e6dd5e;
    border-bottom-color: #e6dd5e;
  }
</style>
