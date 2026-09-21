<script>
  import { page } from '$app/stores';
  import { ArrowLeft, Share2 } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { pmEventKey } from '$lib/stores/predictionMarketEvent.js';

  $: matchKey = $page.params.matchKey;

  let loading = true;
  let error = '';
  let saving = false;
  let localDetail = null;
  let selectedSide = null;

  async function loadDetail(key) {
    if (!key) return;
    loading = true;
    error = '';
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch(`/api/prediction-market-v2/matches/${encodeURIComponent(key)}`, { headers: authHeaders });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Could not load this match.');
      localDetail = result;
      selectedSide = result.my_pick;
    } catch (cause) {
      error = cause?.message || 'Could not load this match.';
    } finally {
      loading = false;
    }
  }

  $: loadDetail(matchKey);

  async function pick(side) {
    if (saving || selectedSide === side) return;
    saving = true;
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/prediction-market-v2/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ event_key: $pmEventKey, match_key: matchKey, side })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Could not save your prediction.');
      await loadDetail(matchKey);
    } catch (cause) {
      error = cause?.message || 'Could not save your prediction.';
    } finally {
      saving = false;
    }
  }

  // Simple, real SVG line chart - no library, drawn to an explicit scale
  // (0-100% vertical) with labeled ticks, per the plan's own visual bar.
  const CHART_W = 640;
  const CHART_H = 220;
  const PAD = { top: 16, right: 16, bottom: 28, left: 40 };
  $: points = localDetail?.elo_history_series || [];
  $: xStep = (CHART_W - PAD.left - PAD.right) / Math.max(1, points.length - 1);
  function xFor(i) { return PAD.left + i * xStep; }
  function yFor(p) { return PAD.top + (1 - p) * (CHART_H - PAD.top - PAD.bottom); }
  $: modelPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.model_prob)}`).join(' ');
  $: communityPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.community_prob)}`).join(' ');
  const tickLabel = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? t : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
</script>

<svelte:head><title>{matchKey?.toUpperCase()} — Prediction Market</title></svelte:head>

<a href="/predictions/matches" class="pm-back"><ArrowLeft size={14} /> Back to Matches</a>

<div class="pm-detail-header">
  <h1>{matchKey?.toUpperCase()}</h1>
  <button type="button" class="pm-icon-btn" title="Share prediction card"><Share2 size={14} /> Share prediction card</button>
</div>

{#if loading}
  <p class="pm-empty">Loading match…</p>
{:else if error}
  <p class="pm-empty">{error}</p>
{:else if localDetail}
<div class="pm-alliance-grid">
  <button type="button" class="pm-alliance-card pm-alliance-card-red" disabled={saving} class:selected={selectedSide === 'red'} on:click={() => pick('red')}>
    <span class="pm-alliance-label">Red Alliance</span>
    <strong class="pm-alliance-prob">{Math.round(localDetail.model_probability_red * 100)}%</strong>
    <span class="pm-alliance-teams">{localDetail.red_teams.join(', ')}</span>
    <span class="pm-alliance-status">{selectedSide === 'red' ? 'Selected' : 'Predict Red'}</span>
  </button>
  <button type="button" class="pm-alliance-card pm-alliance-card-blue" disabled={saving} class:selected={selectedSide === 'blue'} on:click={() => pick('blue')}>
    <span class="pm-alliance-label">Blue Alliance</span>
    <strong class="pm-alliance-prob">{Math.round((1 - localDetail.model_probability_red) * 100)}%</strong>
    <span class="pm-alliance-teams">{localDetail.blue_teams.join(', ')}</span>
    <span class="pm-alliance-status">{selectedSide === 'blue' ? 'Selected' : 'Predict Blue'}</span>
  </button>
</div>

<section class="pm-panel pm-community-panel">
  <div class="pm-panel-header"><h2>Community Predictions</h2></div>
  <div class="pm-community-stats">
    <div><strong class="pm-num-red">{localDetail.community_breakdown.red}</strong><span>Red</span></div>
    <div><strong>{Math.round(localDetail.model_probability_red * 100) - localDetail.community_breakdown.red}</strong><span>vs model</span></div>
    <div><strong>{localDetail.community_breakdown.total}</strong><span>Total</span></div>
    <div><strong class="pm-num-blue">{localDetail.community_breakdown.blue}</strong><span>Blue</span></div>
  </div>
  {#if localDetail.my_pick}
    <p class="pm-frozen-note">Model probability when you predicted: {Math.round((localDetail.model_probability_at_my_pick ?? 0.5) * 100)}% for {localDetail.my_pick === 'red' ? 'Red' : 'Blue'}. Later model changes update the graph, not your saved prediction.</p>
  {/if}
</section>

<section class="pm-panel">
  <div class="pm-panel-header"><h2>Model and Community Predictions Over Time</h2></div>
  <div class="pm-chart-wrap">
    {#if points.length}
    <svg viewBox="0 0 {CHART_W} {CHART_H}" role="img" aria-label="Model and community win probability for Red, over time">
      {#each [0, 0.25, 0.5, 0.75, 1] as tick}
        <line x1={PAD.left} x2={CHART_W - PAD.right} y1={yFor(tick)} y2={yFor(tick)} class="pm-grid-line" />
        <text x={PAD.left - 8} y={yFor(tick) + 4} class="pm-chart-tick" text-anchor="end">{Math.round(tick * 100)}%</text>
      {/each}
      {#each points as p, i}
        <text x={xFor(i)} y={CHART_H - 8} class="pm-chart-tick" text-anchor="middle">{tickLabel(p.t)}</text>
      {/each}
      <path d={communityPath} class="pm-chart-line pm-chart-line-community" />
      <path d={modelPath} class="pm-chart-line pm-chart-line-model" />
      {#each points as p, i}
        <circle cx={xFor(i)} cy={yFor(p.model_prob)} r="3" class="pm-chart-dot pm-chart-dot-model" />
        <circle cx={xFor(i)} cy={yFor(p.community_prob)} r="3" class="pm-chart-dot pm-chart-dot-community" />
      {/each}
    </svg>
    <div class="pm-chart-legend">
      <span><i class="pm-legend-swatch pm-legend-model"></i> Model</span>
      <span><i class="pm-legend-swatch pm-legend-community"></i> Community</span>
    </div>
    {:else}
      <p class="pm-empty">No predictions yet for this match.</p>
    {/if}
  </div>
</section>
{/if}

<style>
  .pm-back { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--pm-accent); text-decoration: none; font-size: 0.82rem; margin-bottom: 1rem; }
  .pm-back:hover { text-decoration: underline; }

  .pm-detail-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.1rem; flex-wrap: wrap; }
  .pm-detail-header h1 { margin: 0; font-family: var(--pm-font-mono); font-size: 1.4rem; }
  .pm-icon-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.75rem;
    background: var(--pm-surface);
    border: 1px solid var(--pm-border);
    color: var(--pm-text);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .pm-icon-btn:hover { border-color: var(--pm-accent); color: var(--pm-accent); }

  .pm-alliance-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--pm-border); border: 1px solid var(--pm-border); margin-bottom: 1.25rem; }
  .pm-alliance-card {
    background: var(--pm-surface);
    border: none;
    padding: 1.1rem 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    text-align: left;
    cursor: pointer;
    color: var(--pm-text);
    font: inherit;
    transition: background-color 0.12s ease;
  }
  .pm-alliance-card-red { border-left: 3px solid var(--pm-red); }
  .pm-alliance-card-blue { border-left: 3px solid var(--pm-blue); }
  .pm-alliance-card:hover { background: var(--pm-surface-raised); }
  .pm-alliance-card.selected.pm-alliance-card-red { background: var(--pm-red-soft); }
  .pm-alliance-card.selected.pm-alliance-card-blue { background: var(--pm-blue-soft); }
  .pm-alliance-label { color: var(--pm-muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .pm-alliance-prob { font-family: var(--pm-font-mono); font-size: 2rem; font-variant-numeric: tabular-nums; }
  .pm-alliance-teams { font-family: var(--pm-font-mono); font-size: 0.78rem; color: var(--pm-muted); }
  .pm-alliance-status { margin-top: 0.4rem; font-size: 0.78rem; font-weight: 600; }
  .pm-alliance-card-red .pm-alliance-status { color: var(--pm-red); }
  .pm-alliance-card-blue .pm-alliance-status { color: var(--pm-blue); }

  .pm-panel { background: var(--pm-surface); border: 1px solid var(--pm-border); margin-bottom: 1.25rem; }
  .pm-panel-header { padding: 0.75rem 1.1rem; border-bottom: 1px solid var(--pm-border); background: var(--pm-surface-raised); }
  .pm-panel-header h2 { margin: 0; font-family: var(--pm-font-mono); font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }

  .pm-community-stats { display: grid; grid-template-columns: repeat(4, 1fr); text-align: center; padding: 1.1rem; }
  .pm-community-stats strong { display: block; font-family: var(--pm-font-mono); font-size: 1.4rem; }
  .pm-community-stats span { color: var(--pm-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .pm-num-red { color: var(--pm-red); }
  .pm-num-blue { color: var(--pm-blue); }
  .pm-frozen-note { margin: 0 1.1rem 1.1rem; padding: 0.7rem 0.9rem; background: var(--pm-accent-soft); color: var(--pm-accent); font-size: 0.78rem; }

  .pm-chart-wrap { padding: 1.1rem; }
  .pm-chart-wrap svg { width: 100%; height: auto; display: block; }
  .pm-grid-line { stroke: var(--pm-border); stroke-width: 1; }
  .pm-chart-tick { fill: var(--pm-muted); font-size: 9px; font-family: var(--pm-font-mono); }
  .pm-chart-line { fill: none; stroke-width: 2; }
  .pm-chart-line-model { stroke: var(--pm-accent); }
  .pm-chart-line-community { stroke: var(--pm-blue); stroke-dasharray: 4 3; }
  .pm-chart-dot-model { fill: var(--pm-accent); }
  .pm-chart-dot-community { fill: var(--pm-blue); }
  .pm-chart-legend { display: flex; gap: 1rem; margin-top: 0.6rem; font-size: 0.78rem; color: var(--pm-muted); }
  .pm-legend-swatch { display: inline-block; width: 10px; height: 10px; margin-right: 0.35rem; vertical-align: middle; }
  .pm-legend-model { background: var(--pm-accent); }
  .pm-legend-community { background: var(--pm-blue); }

  .pm-empty { color: var(--pm-muted); font-size: 0.85rem; margin-bottom: 1rem; }

  @media (max-width: 640px) {
    .pm-alliance-grid { grid-template-columns: 1fr; }
    .pm-community-stats { grid-template-columns: repeat(2, 1fr); gap: 0.75rem; }
  }
</style>
