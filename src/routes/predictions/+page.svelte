<script>
  import { onMount } from 'svelte';
  import { Coins, RefreshCw, Trophy, X } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { getAuthHeader, supabase } from '$lib/supabase.js';
  import { isMatchPlayed, matchLabel } from '$lib/matchProjection.js';
  import { STARTING_BALANCE, availableBalance, myBetForMatch, summarizeStandings } from '$lib/predictionMarket.js';

  let eventKey = '';
  let loading = true;
  let error = '';
  let warning = '';

  let matches = [];
  let bets = [];
  let userId = null;
  let userNames = new Map();

  let drafts = {}; // match_key -> { side, stake }
  let saving = {};
  let saveMessage = {};

  const teamNumber = (teamKey) => String(teamKey || '').replace(/^frc/i, '');
  const money = (value) => `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;

  $: standings = summarizeStandings(bets);
  $: myBalance = availableBalance(bets, userId);
  $: myStandingRow = standings.find((row) => row.userId === userId) || null;
  $: upcomingMatches = matches.filter((match) => !isMatchPlayed(match));
  $: myResolvedBets = bets.filter((bet) => bet.created_by === userId && bet.resolved_at).sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)));

  function displayName(id) {
    if (!id) return 'Unknown scout';
    if (id === userId) return 'You';
    return userNames.get(id) || 'A scout';
  }

  function draftFor(matchKey) {
    if (!drafts[matchKey]) {
      const mine = myBetForMatch(bets, matchKey, userId);
      drafts = { ...drafts, [matchKey]: { side: mine?.side || 'red', stake: mine?.stake ?? '' } };
    }
    return drafts[matchKey];
  }

  async function loadUserNames() {
    const { data } = await supabase.from('user_profiles').select('id, full_name, email');
    const map = new Map();
    (data || []).forEach((row) => map.set(row.id, row.full_name || row.email || row.id));
    userNames = map;
  }

  async function loadBets() {
    if (!eventKey) return;
    const authHeaders = await getAuthHeader();
    const response = await fetch(`/api/prediction-market?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders })
      .then((res) => res.json())
      .catch(() => null);
    if (response?.success) {
      bets = response.data || [];
      if (response.unavailable) warning = 'The prediction market is unavailable until its migration is applied.';
    } else {
      warning = response?.error || 'Could not load the prediction market.';
    }
  }

  async function loadAll() {
    loading = true;
    error = '';
    warning = '';
    const matchesResult = await fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`).then((res) => res.json()).catch(() => null);
    matches = matchesResult?.success ? matchesResult.data : [];
    if (!matchesResult?.success) warning = matchesResult?.error || 'Could not load the match schedule.';
    await loadBets();
    loading = false;
  }

  async function placeBet(match) {
    const draft = draftFor(match.key);
    saving = { ...saving, [match.key]: true };
    saveMessage = { ...saveMessage, [match.key]: '' };
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/prediction-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action: 'bet', event_key: eventKey, match_key: match.key, side: draft.side, stake: draft.stake })
      });
      const result = await response.json();
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Could not place bet.');
      await loadBets();
      saveMessage = { ...saveMessage, [match.key]: 'Bet placed.' };
    } catch (cause) {
      saveMessage = { ...saveMessage, [match.key]: cause?.message || 'Could not place bet.' };
    } finally {
      saving = { ...saving, [match.key]: false };
    }
  }

  async function cancelBet(match) {
    const mine = myBetForMatch(bets, match.key, userId);
    if (!mine) return;
    saving = { ...saving, [match.key]: true };
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/prediction-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action: 'cancel', id: mine.id })
      });
      const result = await response.json();
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Could not cancel bet.');
      await loadBets();
      drafts = { ...drafts, [match.key]: { side: 'red', stake: '' } };
      saveMessage = { ...saveMessage, [match.key]: 'Cancelled.' };
    } catch (cause) {
      saveMessage = { ...saveMessage, [match.key]: cause?.message || 'Could not cancel bet.' };
    } finally {
      saving = { ...saving, [match.key]: false };
    }
  }

  onMount(async () => {
    const { data } = await supabase.auth.getUser();
    userId = data?.user?.id || null;
    await loadUserNames();
    eventKey = await fetchActiveScoutingEventKey();
    if (!eventKey) { loading = false; return; }
    await loadAll();
  });
</script>

<svelte:head><title>Prediction Market</title></svelte:head>

<div class="page-header">
  <div class="header-content">
    <h1><Coins size={22} /> Prediction Market</h1>
    <p>Play-money bets on match outcomes{eventKey ? ` for ${eventKey}` : ''}. Winners split the losing side's stakes; whoever ends the event with the most money earns the candy.</p>
  </div>
  {#if eventKey}
    <button class="btn btn-sm" on:click={loadAll} disabled={loading}><RefreshCw size={14} /> Refresh</button>
  {/if}
</div>

{#if loading}
  <p class="text-muted">Loading the prediction market...</p>
{:else if !eventKey}
  <div class="empty-state"><Coins size={40} /><h3>No active scouting event</h3><p>Set one in <a href="/scouting-admin">Scouting Admin</a>.</p></div>
{:else if error}
  <div class="error-container"><p>{error}</p></div>
{:else}
  {#if warning}<p class="text-muted">⚠ {warning}</p>{/if}

  <section class="surface-card balance-card">
    <div><span class="text-muted">Your balance</span><strong class="balance-amount">{money(myBalance)}</strong></div>
    <div><span class="text-muted">Record</span><strong>{myStandingRow ? `${myStandingRow.wins}-${myStandingRow.losses}` : '0-0'}</strong></div>
    <div><span class="text-muted">Rank</span><strong>{standings.findIndex((row) => row.userId === userId) + 1 || '—'} / {standings.length}</strong></div>
  </section>

  <section class="surface-card leaderboard">
    <h2><Trophy size={18} /> Leaderboard</h2>
    {#if !standings.length}
      <p class="text-muted">No bets placed yet - be the first.</p>
    {:else}
      <table class="bom-table">
        <thead><tr><th>#</th><th>Scout</th><th>Balance</th><th>Record</th><th>Pending</th></tr></thead>
        <tbody>
          {#each standings as row, index (row.userId)}
            <tr class:leader={index === 0} class:me={row.userId === userId}>
              <td class="mono">{index + 1}</td>
              <td>{displayName(row.userId)}</td>
              <td class="strong">{money(row.balance)}</td>
              <td>{row.wins}-{row.losses}{row.pushes ? ` (${row.pushes} push)` : ''}</td>
              <td class="text-muted">{row.pendingStake ? money(row.pendingStake) : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <section class="surface-card">
    <h2>Upcoming matches</h2>
    {#if !upcomingMatches.length}
      <p class="text-muted">No upcoming matches to bet on right now.</p>
    {:else}
      <div class="bet-list">
        {#each upcomingMatches as match (match.key)}
          {@const mine = myBetForMatch(bets, match.key, userId)}
          {@const draft = draftFor(match.key)}
          <div class="bet-row">
            <div class="bet-row-header">
              <strong>{matchLabel(match)}</strong>
              <span class="alliance-red">{match.alliances?.red?.team_keys?.map(teamNumber).join(', ')}</span>
              <span class="text-muted">vs</span>
              <span class="alliance-blue">{match.alliances?.blue?.team_keys?.map(teamNumber).join(', ')}</span>
            </div>
            <div class="bet-row-form">
              <select class="form-input" bind:value={draft.side}>
                <option value="red">Red</option>
                <option value="blue">Blue</option>
              </select>
              <input class="form-input" type="number" min="1" step="1" placeholder="Stake" bind:value={draft.stake} />
              <button class="btn btn-primary btn-sm" disabled={saving[match.key]} on:click={() => placeBet(match)}>{mine ? 'Update' : 'Place bet'}</button>
              {#if mine}
                <button class="icon-button danger" title="Cancel bet" disabled={saving[match.key]} on:click={() => cancelBet(match)}><X size={15} /></button>
              {/if}
              {#if saveMessage[match.key]}<span class="text-muted">{saveMessage[match.key]}</span>{/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if myResolvedBets.length}
    <section class="surface-card">
      <h2>Your settled bets</h2>
      <table class="bom-table">
        <thead><tr><th>Match</th><th>Pick</th><th>Stake</th><th>Payout</th><th>Net</th></tr></thead>
        <tbody>
          {#each myResolvedBets as bet (bet.id)}
            <tr>
              <td>{bet.match_key}</td>
              <td class:alliance-red={bet.side === 'red'} class:alliance-blue={bet.side === 'blue'}>{bet.side}</td>
              <td>{money(bet.stake)}</td>
              <td>{money(bet.payout ?? 0)}</td>
              <td class:positive={bet.payout > bet.stake} class:negative={bet.payout < bet.stake}>{money((bet.payout ?? 0) - bet.stake)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
{/if}

<style>
  h1, h2 { display:flex; align-items:center; gap:var(--gap-2); }
  .balance-card { display:flex; gap:var(--space-5); margin-top:var(--space-3); }
  .balance-card > div { display:flex; flex-direction:column; gap:2px; }
  .balance-amount { font-size:1.4rem; }
  .leaderboard, .balance-card { margin-top:var(--space-3); }
  tr.leader td { font-weight:700; }
  tr.me { background:var(--surface-2); }
  .alliance-red { color:var(--status-danger); }
  .alliance-blue { color:var(--brand-blue, #2563eb); }
  .bet-list { display:flex; flex-direction:column; gap:var(--space-2); margin-top:var(--space-2); }
  .bet-row { border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-2) var(--space-3); }
  .bet-row-header { display:flex; align-items:center; gap:var(--gap-2); flex-wrap:wrap; margin-bottom:var(--space-2); }
  .bet-row-form { display:flex; align-items:center; gap:var(--gap-2); flex-wrap:wrap; }
  .bet-row-form select, .bet-row-form input { width:auto; max-width:120px; }
  .positive { color:var(--status-success, #16a34a); }
  .negative { color:var(--status-danger); }
</style>
