<script>
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { Search, ArrowRight } from 'lucide-svelte';
  import { searchSiteRoutes } from '$lib/siteSearch.js';

  export let open = false;
  export let canViewAdmin = false;
  export let canViewScoutingAdmin = false;
  let query = '';
  let input;
  $: results = searchSiteRoutes(query, { canViewAdmin, canViewScoutingAdmin });
  $: if (open) tick().then(() => input?.focus());

  function close() { open = false; query = ''; }
  function choose(result) { close(); goto(result.href); }
  function onKeydown(event) { if (event.key === 'Escape') close(); }
</script>

{#if open}
  <div class="search-shell" role="presentation" on:keydown={onKeydown}>
    <button class="search-backdrop" type="button" aria-label="Close site search" on:click={close}></button>
    <dialog open class="search-dialog" aria-label="Search Spartans Hub">
      <label class="search-input-wrap" for="site-search-input"><Search size={20} /><span class="sr-only">Search Spartans Hub</span>
        <input id="site-search-input" bind:this={input} bind:value={query} placeholder="Search Spartans Hub…" autocomplete="off" />
        <kbd>Esc</kbd>
      </label>
      <div class="search-results" aria-live="polite">
        {#if results.length}
          {#each results as result}
            <button type="button" class="search-result" on:click={() => choose(result)}>
              <span><strong>{result.label}</strong><small>{result.category} · {result.href}</small></span><ArrowRight size={17} />
            </button>
          {/each}
        {:else}
          <p>No pages match “{query}”.</p>
        {/if}
      </div>
    </dialog>
  </div>
{/if}

<style>
  .search-shell { position:fixed; inset:0; z-index:300; display:grid; place-items:start center; padding:12vh var(--space-3) var(--space-3); }
  .search-backdrop { position:absolute; inset:0; border:0; background:rgba(0,0,0,.52); cursor:default; }
  .search-dialog { position:relative; width:min(42rem,100%); margin:0; overflow:hidden; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--surface-1); box-shadow:var(--shadow-lg); }
  .search-input-wrap { display:flex; align-items:center; gap:var(--gap-3); padding:var(--space-3) var(--space-4); border-bottom:1px solid var(--border); color:var(--text-muted); }
  .search-input-wrap input { width:100%; min-width:0; border:0; outline:0; background:transparent; color:var(--text); font:inherit; font-size:1.1rem; }
  kbd { padding:2px 6px; border:1px solid var(--border); border-radius:4px; color:var(--text-muted); font-size:.75rem; }
  .search-results { max-height:min(55vh,30rem); overflow:auto; padding:var(--space-2); }
  .search-results p { margin:var(--space-4); color:var(--text-muted); text-align:center; }
  .search-result { width:100%; display:flex; align-items:center; justify-content:space-between; gap:var(--gap-3); padding:var(--space-3); border:0; border-radius:var(--radius-sm); background:transparent; color:var(--text); text-align:left; cursor:pointer; }
  .search-result:hover, .search-result:focus-visible { background:var(--surface-2); outline:2px solid var(--accent); outline-offset:-2px; }
  .search-result span { display:grid; gap:2px; }.search-result small { color:var(--text-muted); }.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); }
</style>
