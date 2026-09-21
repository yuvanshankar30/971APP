<script>
  import { onMount } from 'svelte';
  import { Trophy } from 'lucide-svelte';
  import { getAuthHeader, supabase } from '$lib/supabase.js';

  const MEDAL = ['pm-medal-gold', 'pm-medal-silver', 'pm-medal-bronze'];

  let loading = true;
  let error = '';
  let ranked = [];
  let myUserId = null;

  $: myRow = ranked.find((row) => row.user_id === myUserId) || null;

  onMount(async () => {
    const { data } = await supabase.auth.getUser();
    myUserId = data?.user?.id || null;
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/prediction-market-v2/leaderboard', { headers: authHeaders });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Could not load the leaderboard.');
      ranked = Array.isArray(result) ? result : [];
    } catch (cause) {
      error = cause?.message || 'Could not load the leaderboard.';
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head><title>Leaderboard — Prediction Market</title></svelte:head>

<div class="pm-page-header">
  <h1>Leaderboard</h1>
  <span class="pm-page-sub">Elo across every event this season</span>
</div>

<section class="pm-panel">
  {#if loading}
    <p class="pm-empty">Loading…</p>
  {:else if error}
    <p class="pm-empty">{error}</p>
  {:else if !ranked.length}
    <p class="pm-empty">No scored predictions yet.</p>
  {:else}
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
        {#each ranked as row, i (row.user_id)}
          <tr class:pm-me={row.user_id === myUserId}>
            <td class="pm-rank-col">
              {#if i < 3}
                <span class="pm-medal {MEDAL[i]}"><Trophy size={12} /> {i + 1}</span>
              {:else}
                <span class="pm-rank-num">{i + 1}</span>
              {/if}
            </td>
            <td class="pm-name-cell">
              {row.name}
              {#if row.user_id === myUserId}<span class="pm-you-chip">You</span>{/if}
            </td>
            <td class="pm-num pm-elo-cell">{Math.round(row.elo)}</td>
            <td class="pm-num pm-mono">{row.wins}-{row.losses}</td>
            <td class="pm-num pm-mono">{row.wins + row.losses ? Math.round((row.wins / (row.wins + row.losses)) * 100) : 0}%</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {/if}
</section>

{#if myRow}
  <p class="pm-footnote">Your rating: <strong>{Math.round(myRow.elo)}</strong> Elo &middot; {myRow.wins}-{myRow.losses} ({myRow.wins + myRow.losses ? Math.round((myRow.wins / (myRow.wins + myRow.losses)) * 100) : 0}% accuracy) across {myRow.wins + myRow.losses} scored predictions.</p>
{/if}

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
  .pm-table th.pm-num { text-align: right; }
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
