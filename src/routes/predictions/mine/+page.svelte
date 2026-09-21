<script>
  import { MOCK_MY_PICKS, findMockMatch } from '$lib/predictionMarketV2Mock.js';

  // TODO(backend): GET /api/prediction-market-v2/my-predictions
  $: open = MOCK_MY_PICKS.filter((p) => !p.locked);
  $: settled = MOCK_MY_PICKS.filter((p) => p.locked);
  $: wins = settled.filter((p) => p.result === 'won').length;
  $: losses = settled.filter((p) => p.result === 'lost').length;
  $: netElo = settled.reduce((sum, p) => sum + p.elo_delta, 0);
</script>

<svelte:head><title>My Predictions — Prediction Market</title></svelte:head>

<div class="pm-page-header">
  <h1>My Predictions</h1>
  <span class="pm-page-sub">{settled.length} scored &middot; {wins}-{losses} &middot; {netElo >= 0 ? '+' : ''}{netElo} Elo net</span>
</div>

<section class="pm-panel">
  <div class="pm-panel-header"><h2>Open Picks</h2></div>
  {#if open.length}
    <div class="pm-table-scroll">
      <table class="pm-table">
        <colgroup>
          <col class="pm-col-match" />
          <col class="pm-col-pick" />
        </colgroup>
        <thead>
          <tr><th>Match</th><th>My Pick</th><th class="pm-num">Model Prob. at Pick</th><th></th></tr>
        </thead>
        <tbody>
          {#each open as p}
            {@const m = findMockMatch(p.match_key)}
            <tr>
              <td class="pm-match-key">{p.match_key.toUpperCase()}</td>
              <td><span class="pm-side-chip pm-side-{p.side}">{p.side}</span></td>
              <td class="pm-num pm-mono">{Math.round(p.model_probability_at_pick * 100)}%</td>
              <td class="pm-action-col"><a href="/predictions/matches/{p.match_key}" class="pm-link">View match</a></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="pm-empty">No open predictions right now - head to Matches to make one.</p>
  {/if}
</section>

<section class="pm-panel">
  <div class="pm-panel-header"><h2>Settled Picks</h2></div>
  <div class="pm-table-scroll">
    <table class="pm-table">
      <colgroup>
        <col class="pm-col-match" />
        <col class="pm-col-pick" />
      </colgroup>
      <thead>
        <tr><th>Match</th><th>My Pick</th><th>Result</th><th class="pm-num">Elo Change</th></tr>
      </thead>
      <tbody>
        {#each settled as p}
          <tr>
            <td class="pm-match-key">{p.match_key.toUpperCase()}</td>
            <td><span class="pm-side-chip pm-side-{p.side}">{p.side}</span></td>
            <td><span class="pm-result-chip" class:pm-result-won={p.result === 'won'} class:pm-result-lost={p.result === 'lost'}>{p.result}</span></td>
            <td class="pm-num pm-mono" class:pm-elo-pos={p.elo_delta > 0} class:pm-elo-neg={p.elo_delta < 0}>{p.elo_delta >= 0 ? '+' : ''}{p.elo_delta}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  .pm-page-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1.1rem; flex-wrap: wrap; }
  .pm-page-header h1 { margin: 0; font-family: var(--pm-font-mono); font-size: 1.3rem; }
  .pm-page-sub { color: var(--pm-muted); font-size: 0.82rem; font-family: var(--pm-font-mono); }

  .pm-panel { background: var(--pm-surface); border: 1px solid var(--pm-border); margin-bottom: 1.25rem; }
  .pm-panel-header { padding: 0.75rem 1.1rem; border-bottom: 1px solid var(--pm-border); background: var(--pm-surface-raised); }
  .pm-panel-header h2 { margin: 0; font-family: var(--pm-font-mono); font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }

  .pm-table-scroll { overflow-x: auto; }
  .pm-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: fixed; }
  .pm-col-match { width: 140px; }
  .pm-col-pick { width: 140px; }
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
  .pm-num { text-align: right; font-variant-numeric: tabular-nums; }
  .pm-mono { font-family: var(--pm-font-mono); }
  .pm-match-key { font-family: var(--pm-font-mono); font-weight: 600; }
  .pm-action-col { text-align: right; }
  .pm-link { color: var(--pm-accent); text-decoration: none; font-size: 0.8rem; }
  .pm-link:hover { text-decoration: underline; }

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

  .pm-result-chip { display: inline-block; padding: 0.15rem 0.55rem; font-size: 0.72rem; text-transform: capitalize; background: var(--pm-border-soft); color: var(--pm-muted); }
  .pm-result-won { background: var(--pm-green-soft); color: var(--pm-green); }
  .pm-result-lost { background: var(--pm-red-soft); color: var(--pm-red); }

  .pm-elo-pos { color: var(--pm-green); }
  .pm-elo-neg { color: var(--pm-red); }

  .pm-empty { padding: 1.1rem; color: var(--pm-muted); font-size: 0.85rem; margin: 0; }
</style>
