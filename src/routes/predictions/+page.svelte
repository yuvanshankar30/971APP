<script>
  import { onMount } from 'svelte';
  import { Candy, Coins, RefreshCw, Trophy, X } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { getAuthHeader, supabase } from '$lib/supabase.js';
  import { isMatchPlayed, matchLabel } from '$lib/matchProjection.js';
  import { STARTING_BALANCE, availableBalance, myBetForMatch, poolForMatch, summarizeStandings } from '$lib/predictionMarket.js';

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

  const RANK_MEDAL = ['gold', 'silver', 'bronze'];
  const teamNumber = (teamKey) => String(teamKey || '').replace(/^frc/i, '');
  const money = (value) => `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
  const matchLabelFor = (matchKey) => {
    const match = matches.find((item) => item.key === matchKey);
    return match ? matchLabel(match) : matchKey;
  };

  $: standings = summarizeStandings(bets);
  $: candyLeader = standings[0] || null;
  $: myBalance = availableBalance(bets, userId);
  $: myStandingRow = standings.find((row) => row.userId === userId) || null;
  $: myRank = standings.findIndex((row) => row.userId === userId) + 1;
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

  function setSide(matchKey, side) {
    drafts = { ...drafts, [matchKey]: { ...draftFor(matchKey), side } };
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

  {#if candyLeader}
    <section class="candy-banner" class:its-you={candyLeader.userId === userId}>
      <Candy size={28} />
      <div class="candy-copy">
        <span class="candy-eyebrow">Currently taking the candy</span>
        <strong class="candy-name">{displayName(candyLeader.userId)}</strong>
      </div>
      <div class="candy-balance">
        <span class="candy-eyebrow">Balance</span>
        <strong>{money(candyLeader.balance)}</strong>
      </div>
    </section>
  {/if}

  <section class="stat-row">
    <div class="surface-card stat-tile">
      <span class="text-muted">Your balance</span>
      <strong class="stat-amount" class:positive={myBalance > STARTING_BALANCE} class:negative={myBalance < STARTING_BALANCE}>{money(myBalance)}</strong>
    </div>
    <div class="surface-card stat-tile">
      <span class="text-muted">Record</span>
      <strong class="stat-amount">{myStandingRow ? `${myStandingRow.wins}-${myStandingRow.losses}` : '0-0'}</strong>
    </div>
    <div class="surface-card stat-tile">
      <span class="text-muted">Rank</span>
      <strong class="stat-amount">{myRank || '—'} <span class="text-muted stat-of">/ {standings.length}</span></strong>
    </div>
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
              <td class="mono"><span class="rank-badge" class:medal={index < 3} data-medal={RANK_MEDAL[index]}>{index + 1}</span></td>
              <td>{displayName(row.userId)}{#if index === 0}<Candy size={14} class="candy-inline" />{/if}</td>
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
          {@const pool = poolForMatch(bets, match.key)}
          <div class="bet-row">
            <div class="bet-row-header">
              <strong>{matchLabel(match)}</strong>
              <span class="alliance-chip alliance-red">{match.alliances?.red?.team_keys?.map(teamNumber).join(', ')}</span>
              <span class="text-muted">vs</span>
              <span class="alliance-chip alliance-blue">{match.alliances?.blue?.team_keys?.map(teamNumber).join(', ')}</span>
            </div>
            {#if pool.total > 0}
              <div class="pool-bar" title={`Crowd so far: ${Math.round(pool.redShare * 100)}% red, ${Math.round(pool.blueShare * 100)}% blue over ${pool.betCount} bet${pool.betCount === 1 ? '' : 's'}`}>
                <span class="pool-fill" style={`width:${pool.redShare * 100}%`}></span>
              </div>
            {/if}
            <div class="bet-row-form">
              <div class="side-toggle">
                <button type="button" class="side-btn side-red" class:chosen={draft.side === 'red'} on:click={() => setSide(match.key, 'red')}>Red</button>
                <button type="button" class="side-btn side-blue" class:chosen={draft.side === 'blue'} on:click={() => setSide(match.key, 'blue')}>Blue</button>
              </div>
              <label class="stake-input">
                <span>$</span>
                <input type="number" min="1" step="1" placeholder="Stake" bind:value={draft.stake} />
              </label>
              <button class="btn btn-primary btn-sm" disabled={saving[match.key]} on:click={() => placeBet(match)}>{mine ? 'Update' : 'Place bet'}</button>
              {#if mine}
                <button class="icon-button danger" title="Cancel bet" disabled={saving[match.key]} on:click={() => cancelBet(match)}><X size={15} /></button>
              {/if}
              {#if saveMessage[match.key]}<span class="text-muted">{saveMessage[match.key]}</span>{/if}
            </div>
            {#if mine}<p class="my-pick text-muted">Your pick: <span class:alliance-red={mine.side === 'red'} class:alliance-blue={mine.side === 'blue'}>{mine.side}</span> for {money(mine.stake)}</p>{/if}
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
              <td>{matchLabelFor(bet.match_key)}</td>
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

  .candy-banner {
    display:flex; align-items:center; gap:var(--space-3); margin-top:var(--space-3); padding:var(--space-3) var(--space-4);
    border-radius:var(--radius-lg); border:1px solid color-mix(in srgb, var(--brand-gold-strong, #b8860b) 55%, var(--border));
    background:linear-gradient(135deg, color-mix(in srgb, var(--brand-gold-strong, #b8860b) 16%, transparent), color-mix(in srgb, var(--brand-gold-strong, #b8860b) 4%, transparent));
    color:var(--text);
  }
  .candy-banner :global(svg) { color:var(--brand-gold-strong, #b8860b); flex-shrink:0; }
  .candy-banner.its-you { border-color:color-mix(in srgb, var(--status-success, #16a34a) 55%, var(--border)); background:linear-gradient(135deg, color-mix(in srgb, var(--status-success, #16a34a) 14%, transparent), transparent); }
  .candy-copy { display:flex; flex-direction:column; gap:2px; flex:1; }
  .candy-balance { display:flex; flex-direction:column; gap:2px; text-align:right; }
  .candy-eyebrow { font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
  .candy-name { font-size:1.15rem; }
  :global(.candy-inline) { color:var(--brand-gold-strong, #b8860b); vertical-align:-2px; margin-left:4px; }

  .stat-row { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:var(--space-3); margin-top:var(--space-3); }
  .stat-tile { display:flex; flex-direction:column; gap:4px; }
  .stat-amount { font-size:1.3rem; }
  .stat-amount.positive { color:var(--status-success, #16a34a); }
  .stat-amount.negative { color:var(--status-danger); }
  .stat-of { font-size:.85rem; font-weight:400; }

  .leaderboard { margin-top:var(--space-3); }
  tr.leader td { font-weight:700; }
  tr.me { background:var(--surface-2); }
  .rank-badge { display:inline-flex; align-items:center; justify-content:center; min-width:1.6rem; height:1.6rem; border-radius:50%; }
  .rank-badge.medal[data-medal="gold"] { background:color-mix(in srgb, #d4af37 30%, transparent); font-weight:700; }
  .rank-badge.medal[data-medal="silver"] { background:color-mix(in srgb, #a8a8a8 30%, transparent); font-weight:700; }
  .rank-badge.medal[data-medal="bronze"] { background:color-mix(in srgb, #b06a34 30%, transparent); font-weight:700; }

  .alliance-red { color:var(--status-danger); }
  .alliance-blue { color:var(--brand-blue, #2563eb); }
  .alliance-chip { font-weight:600; }

  .bet-list { display:flex; flex-direction:column; gap:var(--space-2); margin-top:var(--space-2); }
  .bet-row { border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-2) var(--space-3); }
  .bet-row-header { display:flex; align-items:center; gap:var(--gap-2); flex-wrap:wrap; margin-bottom:var(--space-2); }

  .pool-bar { height:6px; border-radius:3px; background:var(--brand-blue, #2563eb); overflow:hidden; margin-bottom:var(--space-2); }
  .pool-fill { display:block; height:100%; background:var(--status-danger); }

  .bet-row-form { display:flex; align-items:center; gap:var(--gap-2); flex-wrap:wrap; }
  .side-toggle { display:inline-flex; border-radius:var(--radius-sm); overflow:hidden; border:1px solid var(--border); }
  .side-btn { padding:.4rem .8rem; border:0; background:var(--surface-1); color:var(--text-muted); font:inherit; font-weight:600; cursor:pointer; }
  .side-btn.side-red.chosen { background:var(--status-danger); color:#fff; }
  .side-btn.side-blue.chosen { background:var(--brand-blue, #2563eb); color:#fff; }
  .stake-input { display:inline-flex; align-items:center; gap:2px; border:1px solid var(--border); border-radius:var(--radius-sm); padding:0 .5rem; background:var(--surface-1); }
  .stake-input span { color:var(--text-muted); }
  .stake-input input { border:0; background:none; width:5rem; padding:.4rem 0; color:inherit; font:inherit; }
  .stake-input input:focus { outline:none; }
  .my-pick { margin:var(--space-2) 0 0; font-size:.85rem; }

  .positive { color:var(--status-success, #16a34a); }
  .negative { color:var(--status-danger); }

  @media (max-width:640px) {
    .stat-row { grid-template-columns:1fr; }
    .candy-banner { flex-wrap:wrap; }
    .candy-balance { text-align:left; }
  }
</style>
