<script>
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { Search, Trophy, X } from 'lucide-svelte';
  import { competitionNavChildren, competitionTabDescription } from '$lib/competitionTabs.js';

  // The tiles come from the same resolved nav the header builds (see
  // +layout.svelte, which populates this store), so a surface the user has
  // removed from their Competition folder - or one their permissions hide -
  // does not show up here either.
  $: tabs = $competitionNavChildren.map((tab) => ({ ...tab, description: competitionTabDescription(tab.key) }));

  let query = '';
  let searchInput;

  $: needle = query.trim().toLowerCase();
  $: visibleTabs = needle
    ? tabs.filter((tab) => `${tab.label} ${tab.description}`.toLowerCase().includes(needle))
    : tabs;

  // "/" to search and Enter to open the only remaining match is the whole
  // point of putting a search box on a launcher - it turns fourteen tiles
  // into two keystrokes without reaching for the mouse.
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

<svelte:head><title>Competition</title></svelte:head>

<div class="competition-page">
  <header class="competition-header">
    <div class="competition-title">
      <Trophy size={26} />
      <div>
        <h1>Competition</h1>
        <p>Every scouting and competition surface, in one place.</p>
      </div>
    </div>

    <div class="competition-search">
      <Search size={16} />
      <input
        bind:this={searchInput}
        bind:value={query}
        type="search"
        placeholder="Search competition tools&hellip;"
        aria-label="Search competition tools"
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
    <div class="competition-empty">
      <Trophy size={40} />
      <h3>No competition tabs available</h3>
      <p>Your account does not have access to any competition surfaces yet.</p>
    </div>
  {:else if !visibleTabs.length}
    <div class="competition-empty">
      <Search size={40} />
      <h3>Nothing matches &ldquo;{query}&rdquo;</h3>
      <p>Try a shorter search, or press Escape to clear it.</p>
    </div>
  {:else}
    <div class="competition-grid">
      {#each visibleTabs as tab (tab.key)}
        <a class="competition-card" href={tab.href}>
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
  .competition-page {
    width: 100vw;
    margin-left: calc(50% - 50vw);
    margin-right: calc(50% - 50vw);
    padding: var(--space-5) var(--space-6) var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-height: calc(100vh - 7rem);
  }

  .competition-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    flex-wrap: wrap;
  }

  .competition-title { display: flex; align-items: center; gap: var(--space-4); }
  .competition-title :global(svg) { color: var(--brand-gold-strong); flex-shrink: 0; }
  .competition-title h1 { margin: 0; line-height: 1.1; }
  .competition-title p { margin: 4px 0 0; color: var(--text-secondary); font-size: var(--font-sm); }

  .competition-search {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    min-width: min(360px, 100%);
    background: var(--primary);
    border: 1px solid var(--border);
    transition: border-color 0.1s ease;
  }
  .competition-search:focus-within { border-color: var(--brand-gold-strong); }
  .competition-search :global(svg) { color: var(--text-muted); flex-shrink: 0; }
  .competition-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    padding: 0.7rem 0;
    color: inherit;
    font: inherit;
  }
  .competition-search input:focus { outline: none; }
  .competition-search input::-webkit-search-cancel-button { display: none; }
  .competition-search kbd {
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
     display. */
  .competition-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    grid-auto-rows: minmax(132px, 1fr);
    gap: var(--space-4);
    align-content: stretch;
  }

  .competition-card {
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
  .competition-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
    border-left-color: var(--brand-gold-strong);
    transform: translateY(-2px);
  }
  .competition-card:focus-visible {
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

  .competition-card h4 {
    margin: 0;
    color: var(--secondary);
    font-size: var(--font-lg);
    line-height: 1.2;
  }
  .competition-card p {
    margin: 0;
    color: var(--neutral-500);
    font-size: var(--font-sm);
    line-height: 1.45;
  }

  .competition-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    color: var(--text-muted);
    text-align: center;
  }
  .competition-empty h3 { margin: var(--space-2) 0 0; color: var(--text); }
  .competition-empty p { margin: 0; }

  @media (max-width: 768px) {
    .competition-page {
      width: auto;
      margin: 0;
      padding: var(--space-4) 0;
      min-height: 0;
    }
    .competition-grid { grid-template-columns: 1fr; grid-auto-rows: auto; }
    .competition-search { min-width: 100%; }
    .competition-search kbd { display: none; }
  }
</style>
