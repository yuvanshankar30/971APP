<script>
  import { getAuthHeader, supabase } from '$lib/supabase.js';
  import { pmEventKey } from '$lib/stores/predictionMarketEvent.js';

  // Predicting alliance selection order ahead of eliminations - captains are
  // the top-ranked teams (rank order stands in for seed, same as real FRC
  // alliance selection), picks are this user's guess at who they'll take.
  let loading = true;
  let error = '';
  let captains = [];
  let pickByCaptain = new Map();
  let myUserId = null;

  let draftPick = '';
  let selectedCaptain = '';
  $: if (!selectedCaptain && captains.length) selectedCaptain = captains[0];

  async function loadDraft(eventKey) {
    if (!eventKey) { loading = false; return; }
    loading = true;
    error = '';
    try {
      const { data } = await supabase.auth.getUser();
      myUserId = data?.user?.id || null;
      const authHeaders = await getAuthHeader();
      const [rankingsResponse, picksResponse] = await Promise.all([
        fetch(`/api/tba/event-rankings?event_key=${encodeURIComponent(eventKey)}`).then((res) => res.json()),
        fetch(`/api/prediction-market-v2/alliance-draft?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((res) => res.json())
      ]);
      if (!rankingsResponse?.success) throw new Error(rankingsResponse?.error || 'Could not load event rankings.');
      if (picksResponse?.error) throw new Error(picksResponse.error);
      captains = (rankingsResponse.data?.rankings || []).slice(0, 8).map((row) => row.team_key);
      selectedCaptain = captains[0] || '';
      const picks = Array.isArray(picksResponse) ? picksResponse : [];
      pickByCaptain = new Map(picks.filter((p) => p.user_id === myUserId).map((p) => [p.predicted_captain, p]));
    } catch (cause) {
      error = cause?.message || 'Could not load the alliance draft.';
    } finally {
      loading = false;
    }
  }

  $: loadDraft($pmEventKey);

  let saving = false;
  async function submitPick() {
    const predictedPick = draftPick.trim();
    if (!predictedPick || !selectedCaptain || saving) return;
    saving = true;
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/prediction-market-v2/alliance-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ event_key: $pmEventKey, predicted_captain: selectedCaptain, predicted_pick: predictedPick, pick_round: 1 })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Could not save your prediction.');
      draftPick = '';
      await loadDraft($pmEventKey);
    } catch (cause) {
      error = cause?.message || 'Could not save your prediction.';
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>Alliance Draft — Prediction Market</title></svelte:head>

<div class="pm-page-header">
  <h1>Alliance Draft</h1>
  <span class="pm-page-sub">{$pmEventKey?.toUpperCase() || ''} &middot; predict who each captain takes in round 1</span>
</div>

{#if loading}
  <p class="pm-empty">Loading…</p>
{:else if error}
  <p class="pm-empty">{error}</p>
{:else if !captains.length}
  <p class="pm-empty">No rankings published for this event yet - check back once qualification matches begin.</p>
{:else}
<section class="pm-panel pm-predict-panel">
  <div class="pm-panel-header"><h2>Make a Prediction</h2></div>
  <form class="pm-predict-form" on:submit|preventDefault={submitPick}>
    <label class="pm-field">
      <span>Captain (seed)</span>
      <select bind:value={selectedCaptain}>
        {#each captains as seed, i}
          <option value={seed}>Seed {i + 1} &middot; {seed}</option>
        {/each}
      </select>
    </label>
    <label class="pm-field">
      <span>Predicted 1st pick</span>
      <input type="text" placeholder="Team key, e.g. frc254" bind:value={draftPick} />
    </label>
    <button type="submit" class="pm-btn-accent" disabled={saving}>Save Prediction</button>
  </form>
</section>

<section class="pm-panel">
  <div class="pm-panel-header"><h2>Seed Order &amp; My Picks</h2></div>
  <div class="pm-table-scroll">
    <table class="pm-table">
      <thead>
        <tr><th class="pm-seed-col">Seed</th><th>Captain</th><th>Predicted Pick</th><th>Status</th></tr>
      </thead>
      <tbody>
        {#each captains as seed, i}
          {@const pick = pickByCaptain.get(seed)}
          <tr>
            <td class="pm-seed-col pm-mono">{i + 1}</td>
            <td class="pm-mono pm-captain">{seed}</td>
            <td class="pm-mono">{pick ? pick.predicted_pick : '—'}</td>
            <td>
              {#if !pick}
                <span class="pm-muted-text">No prediction yet</span>
              {:else if pick.resolved_at}
                <span class="pm-status-chip" class:pm-status-locked={!pick.correct}>{pick.correct ? 'Correct' : 'Incorrect'}</span>
              {:else}
                <span class="pm-status-chip">Predicted</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
{/if}

<style>
  .pm-page-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1.1rem; flex-wrap: wrap; }
  .pm-page-header h1 { margin: 0; font-family: var(--pm-font-mono); font-size: 1.3rem; }
  .pm-page-sub { color: var(--pm-muted); font-size: 0.82rem; }

  .pm-panel { background: var(--pm-surface); border: 1px solid var(--pm-border); margin-bottom: 1.25rem; }
  .pm-panel-header { padding: 0.75rem 1.1rem; border-bottom: 1px solid var(--pm-border); background: var(--pm-surface-raised); }
  .pm-panel-header h2 { margin: 0; font-family: var(--pm-font-mono); font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }

  .pm-predict-form { display: flex; align-items: flex-end; gap: 1rem; padding: 1.1rem; flex-wrap: wrap; }
  .pm-field { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.78rem; color: var(--pm-muted); flex: 1; min-width: 160px; }
  .pm-field select, .pm-field input {
    padding: 0.5rem 0.6rem;
    background: var(--pm-surface-raised);
    border: 1px solid var(--pm-border);
    color: var(--pm-text);
    font: inherit;
    font-family: var(--pm-font-mono);
  }
  .pm-field select:focus, .pm-field input:focus { outline: none; border-color: var(--pm-accent); }

  .pm-btn-accent {
    padding: 0.55rem 1.1rem;
    background: var(--pm-accent);
    color: #16130a;
    border: none;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.12s ease, transform 0.12s ease;
  }
  .pm-btn-accent:hover { filter: brightness(1.1); transform: translateY(-1px); }

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
  .pm-seed-col { width: 4rem; }
  .pm-mono { font-family: var(--pm-font-mono); }
  .pm-captain { font-weight: 600; }
  .pm-muted-text { color: var(--pm-muted); font-size: 0.8rem; }

  .pm-status-chip { display: inline-block; padding: 0.15rem 0.55rem; font-size: 0.72rem; background: var(--pm-green-soft); color: var(--pm-green); }
  .pm-status-chip.pm-status-locked { background: var(--pm-border-soft); color: var(--pm-muted); }

  @media (max-width: 640px) {
    .pm-predict-form { flex-direction: column; align-items: stretch; }
  }
</style>
