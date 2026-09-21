<script>
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { Search, X } from 'lucide-svelte';

  // Generic tile-launcher, factored out of /competition's own page (the
  // first folder that outgrew a dropdown - fourteen entries is past what a
  // hover menu can show usefully). Any folder can get the same "press this
  // one home-page card, land on a searchable grid of everything inside it"
  // treatment by passing its own icon/title/tabs here, instead of the top
  // nav's own dropdown behavior for that folder (which this component has
  // nothing to do with - see the route that mounts this, not this file).
  export let icon; // component, e.g. Trophy
  export let title;
  export let subtitle;
  export let tabs = []; // [{ key, label, href, icon, description }]
  export let searchPlaceholder = 'Search…';
  export let emptyTitle = 'Nothing available';
  export let emptyBody = 'Your account does not have access to any surfaces here yet.';

  let query = '';
  let searchInput;

  $: needle = query.trim().toLowerCase();
  $: visibleTabs = needle
    ? tabs.filter((tab) => `${tab.label} ${tab.description || ''}`.toLowerCase().includes(needle))
    : tabs;

  // "/" to search and Enter to open the only remaining match is the whole
  // point of putting a search box on a launcher - it turns many tiles into
  // two keystrokes without reaching for the mouse.
  function handleWindowKeydown(event) {
    if (event.key === '/' && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput?.focus();
    }
  }

  function handleSearchKeydown(event) {
    if (event.key === 'Escape') {
      query = '';
      searchInput?.blur();
      return;
    }
    if (event.key === 'Enter' && visibleTabs.length) {
      goto(visibleTabs[0].href);
    }
  }

  onMount(() => window.addEventListener('keydown', handleWindowKeydown));
  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleWindowKeydown);
  });
</script>

<svelte:head><title>{title}</title></svelte:head>

<div class="hub-page">
  <header class="hub-header">
    <div class="hub-title">
      <svelte:component this={icon} size={26} />
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </div>

    <div class="hub-search">
      <Search size={16} />
      <input
        bind:this={searchInput}
        bind:value={query}
        type="search"
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        on:keydown={handleSearchKeydown}
      />
      {#if query}
        <button type="button" class="search-clear" aria-label="Clear search" on:click={() => { query = ''; searchInput?.focus(); }}>
          <X size={14} />
        </button>
      {:else}
        <kbd>/</kbd>
      {/if}
    </div>
  </header>

  {#if !tabs.length}
    <div class="hub-empty">
      <svelte:component this={icon} size={40} />
      <h3>{emptyTitle}</h3>
      <p>{emptyBody}</p>
    </div>
  {:else if !visibleTabs.length}
    <div class="hub-empty">
      <Search size={40} />
      <h3>Nothing matches &ldquo;{query}&rdquo;</h3>
      <p>Try a shorter search, or press Escape to clear it.</p>
    </div>
  {:else}
    <div class="hub-grid">
      {#each visibleTabs as tab (tab.key)}
        <a class="hub-card" href={tab.href}>
          <span class="card-icon"><svelte:component this={tab.icon} size={20} /></span>
          <h4>{tab.label}</h4>
          {#if tab.description}<p>{tab.description}</p>{/if}
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Full-bleed: this is a launcher, so it escapes the shared page
     container's max-width and fills the viewport rather than sitting in a
     narrow column with two thirds of the screen empty below it. */
  .hub-page {
    width: 100vw;
    margin-left: calc(50% - 50vw);
    margin-right: calc(50% - 50vw);
    padding: var(--space-5) var(--space-6) var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-height: calc(100vh - 7rem);
  }

  .hub-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    flex-wrap: wrap;
  }

  .hub-title { display: flex; align-items: center; gap: var(--space-4); }
  .hub-title :global(svg) { color: var(--brand-gold-strong); flex-shrink: 0; }
  .hub-title h1 { margin: 0; line-height: 1.1; }
  .hub-title p { margin: 4px 0 0; color: var(--text-secondary); font-size: var(--font-sm); }

  .hub-search {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    min-width: min(360px, 100%);
    background: var(--primary);
    border: 1px solid var(--border);
    transition: border-color 0.1s ease;
  }
  .hub-search:focus-within { border-color: var(--brand-gold-strong); }
  .hub-search :global(svg) { color: var(--text-muted); flex-shrink: 0; }
  .hub-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    padding: 0.7rem 0;
    color: inherit;
    font: inherit;
  }
  .hub-search input:focus { outline: none; }
  .hub-search input::-webkit-search-cancel-button { display: none; }
  .hub-search kbd {
    flex-shrink: 0;
    border: 1px solid var(--border);
    padding: 1px 6px;
    font-family: var(--font-mono-stack);
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .search-clear {
    display: flex;
    align-items: center;
    border: 0;
    background: none;
    padding: 2px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .search-clear:hover { color: var(--text); }

  /* flex:1 + auto-rows:1fr is what actually fills the screen: the grid
     takes all the leftover height and its rows share it evenly, instead of
     every card collapsing to its text height and leaving a dead zone. The
     minmax floor keeps cards from stretching absurdly tall on a big
     display.

     auto-fit, not auto-fill: with few tiles (a 3-item folder like CAD),
     auto-fill still reserves empty column tracks up to the container width
     and leaves them empty - real, confirmed dead space to the right of the
     last card. auto-fit collapses those empty tracks instead, so the
     existing cards' own 1fr stretches to fill the row. */
  .hub-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    grid-auto-rows: minmax(132px, 1fr);
    gap: var(--space-4);
    align-content: stretch;
  }

  .hub-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--primary);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    padding: var(--space-4) var(--space-5);
    text-decoration: none;
    color: inherit;
    transition: border-color 0.12s ease, background-color 0.12s ease, transform 0.12s ease;
  }
  .hub-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
    border-left-color: var(--brand-gold-strong);
    transform: translateY(-2px);
  }
  .hub-card:focus-visible {
    outline: 2px solid var(--brand-gold-strong);
    outline-offset: 2px;
  }

  /* The icon lives in its own fixed-size chip rather than having padding
     applied straight to the svg - with border-box sizing that padding ate
     the glyph down to a few pixels and every tile rendered a tiny speck. */
  .card-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
    flex-shrink: 0;
  }

  .hub-card h4 {
    margin: 0;
    color: var(--secondary);
    font-size: var(--font-lg);
    line-height: 1.2;
  }
  .hub-card p {
    margin: 0;
    color: var(--neutral-500);
    font-size: var(--font-sm);
    line-height: 1.45;
  }

  .hub-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    color: var(--text-muted);
    text-align: center;
  }
  .hub-empty h3 { margin: var(--space-2) 0 0; color: var(--text); }
  .hub-empty p { margin: 0; }

  @media (max-width: 768px) {
    .hub-page {
      width: auto;
      margin: 0;
      padding: var(--space-4) 0;
      min-height: 0;
    }
    .hub-grid { grid-template-columns: 1fr; grid-auto-rows: auto; }
    .hub-search { min-width: 100%; }
    .hub-search kbd { display: none; }
  }
</style>
