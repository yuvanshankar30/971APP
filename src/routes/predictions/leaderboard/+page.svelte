<script>
  import { Trophy } from 'lucide-svelte';
  import { MOCK_LEADERBOARD, MOCK_ELO } from '$lib/predictionMarketV2Mock.js';

  // TODO(backend): GET /api/prediction-market-v2/leaderboard?event_key=...
  $: ranked = [...MOCK_LEADERBOARD].sort((a, b) => b.elo - a.elo);
  const MEDAL = ['pm-medal-gold', 'pm-medal-silver', 'pm-medal-bronze'];
  // Mock treats the signed-in user as the "Lightning" row - matches MOCK_ELO.
  const MY_USER_ID = 'u2';
</script>

<svelte:head><title>Leaderboard — Prediction Market</title></svelte:head>

<div class="pm-page-header">
  <h1>Leaderboard</h1>
  <span class="pm-page-sub">Elo across every 971/9584 event this season</span>
</div>

<section class="pm-panel">
  <div class="pm-table-scroll">
    <table class="pm-table">
      <thead>
        <tr>
          <th class="pm-rank-col">Rank</th>
          <th>Predictor</th>
          <th class="pm-num">Elo</th>
          <th class="pm-num">Record</th>
          <th class="pm-num">Win %</th>
        </tr>
      </thead>
      <tbody>
        {#each ranked as row, i}
          <tr class:pm-me={row.user_id === MY_USER_ID}>
            <td class="pm-rank-col">
              {#if i < 3}
                <span class="pm-medal {MEDAL[i]}"><Trophy size={12} /> {i + 1}</span>
              {:else}
                <span class="pm-rank-num">{i + 1}</span>
              {/if}
            </td>
            <td class="pm-name-cell">
              {row.name}
              {#if row.user_id === MY_USER_ID}<span class="pm-you-chip">You</span>{/if}
            </td>
            <td class="pm-num pm-elo-cell">{row.elo}</td>
            <td class="pm-num pm-mono">{row.wins}-{row.losses}</td>
            <td class="pm-num pm-mono">{row.wins + row.losses ? Math.round((row.wins / (row.wins + row.losses)) * 100) : 0}%</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<p class="pm-footnote">Your rating: <strong>{MOCK_ELO.elo}</strong> Elo ({MOCK_ELO.elo_delta_event >= 0 ? '+' : ''}{MOCK_ELO.elo_delta_event} this event) &middot; {Math.round(MOCK_ELO.accuracy * 100)}% accuracy across {MOCK_ELO.scored_predictions} scored predictions.</p>

<style>
  .pm-page-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1.1rem; flex-wrap: wrap; }
  .pm-page-header h1 { margin: 0; font-family: var(--pm-font-mono); font-size: 1.3rem; }
  .pm-page-sub { color: var(--pm-muted); font-size: 0.82rem; }

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
  .pm-table tbody tr.pm-me { background: var(--pm-accent-soft); }
  .pm-num { text-align: right; font-variant-numeric: tabular-nums; }
  .pm-mono { font-family: var(--pm-font-mono); }
  .pm-rank-col { width: 4.5rem; }
  .pm-rank-num { font-family: var(--pm-font-mono); color: var(--pm-muted); padding-left: 0.4rem; }

  .pm-medal {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--pm-font-mono);
    font-weight: 700;
    font-size: 0.8rem;
  }
  .pm-medal-gold { color: #f2c14e; }
  .pm-medal-silver { color: #c7cedb; }
  .pm-medal-bronze { color: #d3894f; }

  .pm-name-cell { font-weight: 500; }
  .pm-you-chip {
    margin-left: 0.5rem;
    padding: 0.1rem 0.4rem;
    background: var(--pm-accent-soft);
    color: var(--pm-accent);
    font-size: 0.65rem;
    font-family: var(--pm-font-mono);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .pm-elo-cell { font-family: var(--pm-font-mono); font-weight: 600; color: var(--pm-accent); }

  .pm-footnote { margin-top: 1rem; color: var(--pm-muted); font-size: 0.8rem; }
  .pm-footnote strong { color: var(--pm-text); font-family: var(--pm-font-mono); }
</style>
