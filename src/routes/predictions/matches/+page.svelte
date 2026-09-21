<script>
  import { Search } from 'lucide-svelte';
  import { MOCK_MATCHES } from '$lib/predictionMarketV2Mock.js';

  // TODO(backend): GET /api/prediction-market-v2/matches?event_key=...
  let query = '';
  $: needle = query.trim().toLowerCase();
  $: filtered = MOCK_MATCHES.filter((m) => !needle || m.match_key.includes(needle) || [...m.red_teams, ...m.blue_teams].some((t) => t.includes(needle)));

  const STATUS_LABEL = { upcoming: 'Upcoming', complete: 'Final' };
</script>

<svelte:head><title>Matches — Prediction Market</title></svelte:head>

<div class="pm-page-header">
  <h1>Matches</h1>
  <div class="pm-search">
    <Search size={14} />
    <input type="search" placeholder="Search match or team…" bind:value={query} />
  </div>
</div>

<section class="pm-panel">
  <div class="pm-table-scroll">
    <table class="pm-table">
      <thead>
        <tr>
          <th>Match</th>
          <th>Red</th>
          <th>Blue</th>
          <th class="pm-num">Model (Red)</th>
          <th>My Pick</th>
          <th>Status</th>
          <th class="pm-action-col"></th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as m}
          <tr>
            <td class="pm-match-key"><a href="/predictions/matches/{m.match_key}">{m.match_key.toUpperCase()}</a></td>
            <td class="pm-alliance-red pm-mono">{m.red_teams.join(' · ')}</td>
            <td class="pm-alliance-blue pm-mono">{m.blue_teams.join(' · ')}</td>
            <td class="pm-num pm-model">{Math.round(m.model_probability_red * 100)}%</td>
            <td>
              {#if m.my_pick}
                <span class="pm-side-chip pm-side-{m.my_pick}">{m.my_pick}</span>
              {:else}
                <span class="pm-muted-text">—</span>
              {/if}
            </td>
            <td>
              <span class="pm-status-chip" class:pm-status-live={m.status === 'upcoming'}>{STATUS_LABEL[m.status]}</span>
            </td>
            <td class="pm-action-col"><a href="/predictions/matches/{m.match_key}" class="pm-btn pm-btn-accent">{m.my_pick ? 'View' : 'Predict'}</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if !filtered.length}
      <p class="pm-empty">No matches match "{query}".</p>
    {/if}
  </div>
</section>

<style>
  .pm-page-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.1rem; flex-wrap: wrap; }
  .pm-page-header h1 { margin: 0; font-family: var(--pm-font-mono); font-size: 1.3rem; }
  .pm-search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    background: var(--pm-surface);
    border: 1px solid var(--pm-border);
    color: var(--pm-muted);
    min-width: 260px;
  }
  .pm-search input { flex: 1; background: none; border: none; color: var(--pm-text); font: inherit; outline: none; }

  .pm-panel { background: var(--pm-surface); border: 1px solid var(--pm-border); }
  .pm-table-scroll { overflow-x: auto; }
  .pm-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .pm-table th {
    text-align: left;
    padding: 0.6rem 1.1rem;
    color: var(--pm-muted);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    border-bottom: 1px solid var(--pm-border);
  }
  .pm-table td { padding: 0.65rem 1.1rem; border-bottom: 1px solid var(--pm-border-soft); }
  .pm-table tbody tr:last-child td { border-bottom: none; }
  .pm-table tbody tr:hover { background: var(--pm-surface-raised); }
  .pm-num { text-align: right; font-family: var(--pm-font-mono); font-variant-numeric: tabular-nums; }
  .pm-mono { font-family: var(--pm-font-mono); font-size: 0.78rem; }
  .pm-match-key a { color: var(--pm-text); text-decoration: none; font-family: var(--pm-font-mono); font-weight: 600; }
  .pm-match-key a:hover { color: var(--pm-accent); }
  .pm-alliance-red { color: var(--pm-red); }
  .pm-alliance-blue { color: var(--pm-blue); }
  .pm-model { color: var(--pm-accent); font-weight: 600; }
  .pm-action-col { text-align: right; }
  .pm-muted-text { color: var(--pm-muted); }

  .pm-side-chip {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    font-family: var(--pm-font-mono);
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .pm-side-red { background: var(--pm-red-soft); color: var(--pm-red); }
  .pm-side-blue { background: var(--pm-blue-soft); color: var(--pm-blue); }

  .pm-status-chip {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    font-size: 0.72rem;
    background: var(--pm-border-soft);
    color: var(--pm-muted);
  }
  .pm-status-chip.pm-status-live { background: var(--pm-green-soft); color: var(--pm-green); }

  .pm-btn-accent {
    display: inline-block;
    padding: 0.4rem 0.85rem;
    background: var(--pm-accent);
    color: #16130a;
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 600;
    transition: filter 0.12s ease, transform 0.12s ease;
  }
  .pm-btn-accent:hover { filter: brightness(1.1); transform: translateY(-1px); }

  .pm-empty { padding: 1.5rem 1.1rem; color: var(--pm-muted); font-size: 0.85rem; margin: 0; }
</style>
