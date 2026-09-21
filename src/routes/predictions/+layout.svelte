<script>
  import { tick } from 'svelte';
  import { page } from '$app/stores';
  import { Radio, ArrowLeftCircle, Trophy } from 'lucide-svelte';
  import { MOCK_ELO, MOCK_EVENT } from '$lib/predictionMarketV2Mock.js';

  // TODO(backend): replace with a real fetch of hub_settings-scoped events
  // (971/9584 only, per the plan doc's event-scope decision) and the
  // signed-in user's real Elo from GET /api/prediction-market-v2/dashboard.
  const elo = MOCK_ELO;
  const event = MOCK_EVENT;

  const TABS = [
    { href: '/predictions', label: 'Dashboard', exact: true },
    { href: '/predictions/alliance-draft', label: 'Alliance Draft' },
    { href: '/predictions/mine', label: 'My Predictions' },
    { href: '/predictions/matches', label: 'Matches' },
    { href: '/predictions/leaderboard', label: 'Leaderboard' }
  ];

  $: path = $page.url.pathname;
  $: isTabActive = (tab) => (tab.exact ? path === tab.href : path.startsWith(tab.href));
  $: activeIndex = TABS.findIndex(isTabActive);

  // The underline slides to the active tab rather than just appearing there
  // - measuring the real tab element (bind:this) instead of hardcoding
  // widths, since each label is a different length.
  let tabEls = [];
  let indicatorLeft = 0;
  let indicatorWidth = 0;

  async function positionIndicator() {
    await tick();
    const el = tabEls[activeIndex];
    if (el) {
      indicatorLeft = el.offsetLeft;
      indicatorWidth = el.offsetWidth;
    }
  }

  $: activeIndex, positionIndicator();
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
</svelte:head>

<div class="pm-shell">
  <header class="pm-topbar">
    <div class="pm-topbar-left">
      <a href="/predictions" class="pm-brand">
        <span class="pm-brand-name">Prediction Market</span>
      </a>
      <div class="pm-event-picker">
        <span class="pm-event-key">{event.event_key}</span>
        <span class="pm-event-name">{event.name}</span>
      </div>
    </div>

    <nav class="pm-tabs" aria-label="Prediction Market sections">
      {#each TABS as tab, i}
        <a href={tab.href} class="pm-tab" class:active={isTabActive(tab)} bind:this={tabEls[i]}>{tab.label}</a>
      {/each}
      <span class="pm-tab-indicator" style="left:{indicatorLeft}px; width:{indicatorWidth}px"></span>
    </nav>

    <div class="pm-topbar-right">
      <span class="pm-elo-badge" title="Your current Elo rating">
        <Trophy size={13} />
        {elo.elo} Elo
      </span>
      <a href="/" class="pm-icon-link pm-return-link" title="Return to Spartans Hub"><ArrowLeftCircle size={16} /> Return to SpartansHub</a>
    </div>
  </header>

  <main class="pm-content">
    <slot />
  </main>
</div>

<style>
  /* ============================================================
     Design tokens - scoped to .pm-shell (not :root), so this dark
     terminal/cockpit theme never leaks into the rest of Spartans Hub.
     Direct instruction: this section does not follow the shared design
     system, and is intentionally a single committed dark world rather
     than something that adapts to the site's own light/dark toggle -
     see artifact-design guidance on a page that "deliberately commits to
     one visual world."

     Palette: near-black cockpit ground, a warm amber signature accent
     (the "confidence/model" color - distinct from the red/blue alliance
     colors, which are semantic, not the accent), green for a correct
     call. Type: IBM Plex Mono for data/headers (the terminal character),
     IBM Plex Sans for longer body text - a real designed pair, not an
     Inter/Space Grotesk default.
     ============================================================ */
  .pm-shell {
    --pm-bg: #0a0d13;
    --pm-surface: #12161f;
    --pm-surface-raised: #171d29;
    --pm-border: #242b3d;
    --pm-border-soft: #1a2030;
    --pm-text: #e9ecf4;
    --pm-muted: #7c879b;
    --pm-accent: #f2b33d;
    --pm-accent-soft: rgba(242, 179, 61, 0.14);
    --pm-red: #f2495c;
    --pm-red-soft: rgba(242, 73, 92, 0.14);
    --pm-blue: #4c8dff;
    --pm-blue-soft: rgba(76, 141, 255, 0.14);
    --pm-green: #35d07f;
    --pm-green-soft: rgba(53, 208, 127, 0.14);
    --pm-font-mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    --pm-font-sans: 'IBM Plex Sans', -apple-system, 'Segoe UI', sans-serif;

    min-height: 100vh;
    background: var(--pm-bg);
    color: var(--pm-text);
    font-family: var(--pm-font-sans);
    display: flex;
    flex-direction: column;
  }

  .pm-topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.65rem 1.25rem;
    background: var(--pm-surface);
    border-bottom: 1px solid var(--pm-border);
  }

  .pm-topbar-left { display: flex; align-items: center; gap: 1.25rem; min-width: 0; }

  .pm-brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--pm-text);
    font-family: var(--pm-font-mono);
    font-weight: 600;
    font-size: 0.95rem;
    white-space: nowrap;
  }

  .pm-event-picker {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.25rem 0.65rem;
    background: var(--pm-surface-raised);
    border: 1px solid var(--pm-border);
    font-family: var(--pm-font-mono);
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .pm-event-key { color: var(--pm-accent); font-weight: 600; text-transform: uppercase; }
  .pm-event-name { color: var(--pm-muted); }

  .pm-tabs {
    position: relative;
    display: flex;
    gap: 0.25rem;
    flex: 1;
    overflow-x: auto;
  }
  .pm-tab {
    padding: 0.5rem 0.85rem;
    color: var(--pm-muted);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 500;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    transition: color 0.12s ease;
  }
  .pm-tab:hover { color: var(--pm-text); }
  .pm-tab.active { color: var(--pm-accent); }

  /* The underline itself - one shared element that slides to whichever tab
     is active, instead of each tab drawing its own static border. */
  .pm-tab-indicator {
    position: absolute;
    bottom: 0;
    height: 2px;
    background: var(--pm-accent);
    transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .pm-topbar-right { display: flex; align-items: center; gap: 0.9rem; flex-shrink: 0; }
  .pm-elo-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    background: var(--pm-accent-soft);
    color: var(--pm-accent);
    font-family: var(--pm-font-mono);
    font-size: 0.78rem;
    font-weight: 600;
  }
  .pm-icon-link {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--pm-muted);
    text-decoration: none;
    font-size: 0.82rem;
    transition: color 0.12s ease;
  }
  .pm-icon-link:hover { color: var(--pm-text); }
  .pm-return-link {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--pm-border);
    background: var(--pm-surface-raised);
    white-space: nowrap;
  }
  .pm-return-link:hover { border-color: var(--pm-accent); }

  .pm-content {
    flex: 1;
    padding: 1.5rem 2rem;
    width: 100%;
  }

  /* The shared site stylesheet sets h1-h4 { color: var(--secondary) } for
     its own light/dark themes - that token isn't part of this shell's
     palette, so every heading under .pm-shell rendered as a near-invisible
     dim color against the near-black background. Needs :global because
     each page's <style> is scoped to that component and can't otherwise
     reach into app.css's rule; ".pm-shell h1" outscopes the bare "h1". */
  :global(.pm-shell h1),
  :global(.pm-shell h2),
  :global(.pm-shell h3),
  :global(.pm-shell h4) {
    color: var(--pm-text);
  }

  @media (max-width: 900px) {
    .pm-topbar { flex-wrap: wrap; gap: 0.75rem; }
    .pm-tabs { order: 3; width: 100%; }
    .pm-event-picker { display: none; }
  }
</style>
