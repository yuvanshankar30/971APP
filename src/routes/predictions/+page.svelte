<script>
  import { onMount } from 'svelte';
  import { Activity, Candy, Coins, Flame, RefreshCw, Scale, TrendingUp, Trophy, X } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { getAuthHeader, supabase } from '$lib/supabase.js';
  import { isMatchPlayed, matchLabel } from '$lib/matchProjection.js';
  import {
    STARTING_BALANCE,
    ANONYMOUS_MARKET_PARTICIPANT_ID,
    availableBalance,
    balanceHistoryForUser,
    isTestMarketKey,
    myBetForMatch,
    oddsHistoryForMatch,
    poolForMatch,
    summarizeStandings
  } from '$lib/predictionMarket.js';
  import { fetchWithCache } from '$lib/offlineCache.js';

  let eventKey = '';
  let loading = true;
  let error = '';
  let warning = '';

  let matches = [];
  let bets = [];
  let userId = null;
  let userNames = new Map();
  let leaderboardOverrides = [];

  let drafts = {}; // match_key -> { side, stake }
  let saving = {};
  let saveMessage = {};

  const RANK_MEDAL = ['gold', 'silver', 'bronze'];
  const teamNumber = (teamKey) => String(teamKey || '').replace(/^frc/i, '');
  const points = (value) => `${Number(value || 0).toLocaleString([], { maximumFractionDigits: 2 })} pts`;
  const matchLabelFor = (matchKey) => {
    const match = matches.find((item) => item.key === matchKey);
    return match ? matchLabel(match) : matchKey;
  };

  // Turns a plain array of numbers into an SVG <polyline> points string, the
  // same tiny inline-chart approach used elsewhere in the app rather than
  // pulling in a charting library for what's just a handful of short lines.
  function sparklinePoints(values, width = 100, height = 28, pad = 3) {
    if (!values.length) return '';
    if (values.length === 1) return `${pad},${(height / 2).toFixed(1)} ${width - pad},${(height / 2).toFixed(1)}`;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const step = (width - pad * 2) / (values.length - 1);
    return values
      .map((value, index) => {
        const x = pad + index * step;
        const y = pad + (1 - (value - min) / range) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  $: standings = summarizeStandings(bets, leaderboardOverrides);
  $: candyLeader = standings[0] || null;
  $: myBalance = availableBalance(bets, userId);
  $: myStandingRow = standings.find((row) => row.userId === userId) || null;
  $: myRank = standings.findIndex((row) => row.userId === userId) + 1;
  $: upcomingMatches = matches.filter((match) => !isMatchPlayed(match));

  $: myResolvedBets = bets.filter((bet) => bet.created_by === userId && bet.resolved_at).sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)));
  $: liveBets = bets.filter((bet) => !isTestMarketKey(bet.match_key));
  $: myBalanceHistory = balanceHistoryForUser(bets, userId);
  $: myBalanceValues = myBalanceHistory.map((point) => point.balance);
  // Where STARTING_BALANCE itself falls on the chart's y-axis (viewBox
  // height 160, 10px top/bottom pad - see the balance-chart svg below), so a
  // faint reference line can show "even" without a separate legend.
  $: balanceSparklineBaselineY = (() => {
    if (myBalanceValues.length < 2) return 80;
    const min = Math.min(...myBalanceValues);
    const max = Math.max(...myBalanceValues);
    const range = max - min || 1;
    return 10 + (1 - (STARTING_BALANCE - min) / range) * (160 - 20);
  })();

  // Market-wide pulse: total action so far, and which upcoming match the
  // crowd is most torn on (closest to a 50/50 split) vs. most piled onto -
  // the same "hot market" signal a real prediction market's homepage leads
  // with, not just a per-match number you'd only see by opening it.
  $: totalStaked = liveBets.reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
  $: upcomingPools = upcomingMatches
    .map((match) => ({ match, pool: poolForMatch(bets, match.key) }))
    .filter((row) => row.pool.total > 0);
  $: closestRace = upcomingPools.length
    ? upcomingPools.reduce((closest, row) => Math.abs(row.pool.redShare - 0.5) < Math.abs(closest.pool.redShare - 0.5) ? row : closest)
    : null;
  $: busiestMatch = upcomingPools.length
    ? upcomingPools.reduce((busiest, row) => row.pool.total > busiest.pool.total ? row : busiest)
    : null;

  // Most recent bets across every scout, newest first - the "live activity"
  // feed a dedicated prediction market leads with so the page feels like a
  // moving market rather than a static form.
  $: recentActivity = liveBets
    .slice()
    .sort((a, b) => String(b.placed_at || '').localeCompare(String(a.placed_at || '')))
    .slice(0, 8);

  function displayName(id) {
    if (id === ANONYMOUS_MARKET_PARTICIPANT_ID) return 'A scout';
    if (!id) return 'A scout';
    if (id === userId) return 'You';
    return userNames.get(id) || 'A scout';
  }

  // Pure - `drafts` must be an explicit argument, not read from the
  // enclosing closure, because a Svelte {@const draft = draftFor(match.key)}
  // only re-runs when a variable actually passed into the call changes.
  // The old version read `drafts` (and wrote to it as a side effect) only
  // from closure, so Svelte never saw it as a dependency: clicking "Blue"
  // updated the `drafts` object correctly, but every {@const} that had
  // already rendered for that match never re-evaluated, so the toggle's
  // highlighted side and bound stake value stayed stuck on whatever they
  // showed when the row first mounted - the reported "can't switch to
  // Blue" bug.
  function draftFor(matchKey, draftsMap, betsList, uid) {
    const existing = draftsMap[matchKey];
    if (existing) return existing;
    const mine = myBetForMatch(betsList, matchKey, uid);
    return { side: mine?.side || 'red', stake: mine?.stake ?? '' };
  }

  function setSide(matchKey, side) {
    drafts = { ...drafts, [matchKey]: { ...draftFor(matchKey, drafts, bets, userId), side } };
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
      leaderboardOverrides = response.leaderboard_overrides || [];
      if (response.unavailable) warning = 'The prediction market is unavailable until its migration is applied.';
    } else {
      warning = response?.error || 'Could not load the prediction market.';
    }
  }

  async function loadAll() {
    loading = true;
    error = '';
    warning = '';
    // Schedule barely changes mid-event - cached, so the match list to bet
    // on shows up instantly instead of waiting on a slow link.
    const matchesResult = await fetchWithCache(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`, { cacheKey: `event-matches:${eventKey}:all` }).catch(() => null);
    matches = matchesResult?.success ? matchesResult.data || [] : [];
    if (!matchesResult?.success) warning = matchesResult?.error || 'Could not load the match schedule.';
    await loadBets();
    loading = false;
  }

  async function placeBet(match) {
    const draft = draftFor(match.key, drafts, bets, userId);
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
    <p>Play-point predictions on match outcomes{eventKey ? ` for ${eventKey}` : ''}. Winners split the losing side's points; whoever ends the event with the most points earns the candy.</p>
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
        <strong>{points(candyLeader.balance)}</strong>
      </div>
    </section>
  {/if}

  <section class="stat-row">
    <div class="surface-card stat-tile">
      <span class="text-muted">Your balance</span>
      <strong class="stat-amount" class:positive={myBalance > STARTING_BALANCE} class:negative={myBalance < STARTING_BALANCE}>{points(myBalance)}</strong>
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

  <section class="pulse-row">
    <div class="surface-card pulse-tile">
      <Coins size={16} /><span class="text-muted">Total staked</span><strong>{points(totalStaked)}</strong>
    </div>
    {#if closestRace}
      <div class="surface-card pulse-tile">
        <Scale size={16} /><span class="text-muted">Closest race</span>
        <strong>{matchLabel(closestRace.match)} <span class="text-muted">({Math.round(closestRace.pool.redShare * 100)}/{Math.round(closestRace.pool.blueShare * 100)})</span></strong>
      </div>
    {/if}
    {#if busiestMatch}
      <div class="surface-card pulse-tile">
        <Flame size={16} /><span class="text-muted">Most action</span>
        <strong>{matchLabel(busiestMatch.match)} <span class="text-muted">({busiestMatch.pool.betCount} bets)</span></strong>
      </div>
    {/if}
  </section>

  {#if myBalanceHistory.length > 1}
    <section class="surface-card balance-history-card">
      <h2><TrendingUp size={18} /> Your balance over time</h2>
      <svg class="balance-chart" viewBox="0 0 600 160" preserveAspectRatio="none">
        <line x1="0" y1={balanceSparklineBaselineY} x2="600" y2={balanceSparklineBaselineY} class="sparkline-baseline" />
        <polyline points={sparklinePoints(myBalanceValues, 600, 160, 10)} class:positive={myBalance >= STARTING_BALANCE} class:negative={myBalance < STARTING_BALANCE} />
      </svg>
      <div class="balance-chart-legend">
        <span class="text-muted">Start: {points(STARTING_BALANCE)}</span>
        <span class:positive={myBalance >= STARTING_BALANCE} class:negative={myBalance < STARTING_BALANCE}>Now: {points(myBalance)}</span>
      </div>
    </section>
  {/if}

  {#if recentActivity.length}
    <section class="surface-card activity-feed">
      <h2><Activity size={16} /> Market activity</h2>
      <ul class="activity-list">
        {#each recentActivity as bet (bet.id)}
          <li>
            <span class:alliance-red={bet.side === 'red'} class:alliance-blue={bet.side === 'blue'} class="activity-side">{bet.side}</span>
            <span class="activity-body"><strong>{displayName(bet.created_by)}</strong> staked {points(bet.stake)} on {matchLabelFor(bet.match_key)}</span>
            <span class="text-muted activity-time">{timeAgo(bet.placed_at)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

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
              <td data-label="#" class="mono"><span class="rank-badge" class:medal={index < 3} data-medal={RANK_MEDAL[index]}>{index + 1}</span></td>
              <td data-label="Scout">{displayName(row.userId)}{#if index === 0}<Candy size={14} class="candy-inline" />{/if}</td>
              <td data-label="Balance" class="strong">{points(row.balance)}</td>
              <td data-label="Record">{row.wins}-{row.losses}{row.pushes ? ` (${row.pushes} push)` : ''}</td>
              <td data-label="Pending" class="text-muted">{row.pendingStake ? points(row.pendingStake) : '—'}</td>
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
          {@const draft = draftFor(match.key, drafts, bets, userId)}
          {@const pool = poolForMatch(bets, match.key)}
          {@const history = oddsHistoryForMatch(bets, match.key)}
          <div class="bet-row">
            <div class="bet-row-header">
              <strong>{matchLabel(match)}</strong>
              {#if pool.total > 0}<span class="pool-size text-muted">{pool.betCount} bet{pool.betCount === 1 ? '' : 's'} · {points(pool.total)}</span>{/if}
            </div>
            <div class="odds-row">
              <button type="button" class="odds-side red" class:chosen={draft.side === 'red'} on:click={() => setSide(match.key, 'red')}>
                <span class="odds-pct">{pool.total > 0 ? `${Math.round(pool.redShare * 100)}%` : '—'}</span>
                <span class="odds-teams">{match.alliances?.red?.team_keys?.map(teamNumber).join(' · ')}</span>
              </button>
              <span class="odds-vs">vs</span>
              <button type="button" class="odds-side blue" class:chosen={draft.side === 'blue'} on:click={() => setSide(match.key, 'blue')}>
                <span class="odds-pct">{pool.total > 0 ? `${Math.round(pool.blueShare * 100)}%` : '—'}</span>
                <span class="odds-teams">{match.alliances?.blue?.team_keys?.map(teamNumber).join(' · ')}</span>
              </button>
            </div>
            {#if pool.total > 0}
              <div class="pool-bar">
                <span class="pool-fill" style={`width:${pool.redShare * 100}%`}></span>
              </div>
            {/if}
            {#if history.length > 1}
              <div class="odds-history">
                <span class="text-muted odds-history-label">How the crowd's odds moved over {history.length} bets</span>
                <svg viewBox="0 0 300 70" preserveAspectRatio="none">
                  <line x1="0" y1="35" x2="300" y2="35" class="sparkline-baseline" />
                  <polyline points={sparklinePoints(history.map((point) => point.redShare * 100), 300, 70, 6)} class="odds-history-line" />
                </svg>
              </div>
            {/if}
            <div class="bet-row-form">
              <label class="stake-input">
                <input type="number" min="1" step="1" placeholder="Stake" bind:value={draft.stake} />
                <span>pts</span>
              </label>
              <button class="btn btn-primary btn-sm" disabled={saving[match.key]} on:click={() => placeBet(match)}>{mine ? 'Update' : 'Place bet'}</button>
              {#if mine}
                <button class="icon-button danger" title="Cancel bet" disabled={saving[match.key]} on:click={() => cancelBet(match)}><X size={15} /></button>
              {/if}
              {#if saveMessage[match.key]}<span class="text-muted">{saveMessage[match.key]}</span>{/if}
            </div>
            {#if mine}<p class="my-pick text-muted">Your pick: <span class:alliance-red={mine.side === 'red'} class:alliance-blue={mine.side === 'blue'}>{mine.side}</span> for {points(mine.stake)}</p>{/if}
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
              <td data-label="Match">{matchLabelFor(bet.match_key)}</td>
              <td data-label="Pick" class:alliance-red={bet.side === 'red'} class:alliance-blue={bet.side === 'blue'}>{bet.side}</td>
              <td data-label="Stake">{points(bet.stake)}</td>
              <td data-label="Payout">{points(bet.payout ?? 0)}</td>
              <td data-label="Net" class:positive={bet.payout > bet.stake} class:negative={bet.payout < bet.stake}>{points((bet.payout ?? 0) - bet.stake)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
{/if}

<style>
  h1, h2 { display:flex; align-items:center; gap:var(--gap-2); }

  /* Overall page rhythm: every major section gets real breathing room from
     the one before it, rather than the tight var(--space-3) stack this page
     started with - "more spaced out" was named directly, and a page this
     information-dense needs the extra separation to read as sections rather
     than one long run-on block. */
  .page-header, .candy-banner, .stat-row, .pulse-row, .balance-history-card,
  .activity-feed, .leaderboard, section.surface-card { margin-top:var(--space-5); }
  .page-header { margin-top:0; }

  .candy-banner {
    display:flex; align-items:center; gap:var(--space-4); padding:var(--space-4) var(--space-5);
    border:1px solid var(--border); border-left:3px solid var(--brand-gold-strong, #b8860b);
    background:var(--surface-1);
    color:var(--text);
  }
  .candy-banner :global(svg) { color:var(--brand-gold-strong, #b8860b); flex-shrink:0; }
  .candy-banner.its-you { border-left-color:var(--status-success, #16a34a); }
  .candy-copy { display:flex; flex-direction:column; gap:4px; flex:1; }
  .candy-balance { display:flex; flex-direction:column; gap:4px; text-align:right; }
  .candy-eyebrow { font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
  .candy-name { font-size:1.2rem; }
  :global(.candy-inline) { color:var(--brand-gold-strong, #b8860b); vertical-align:-2px; margin-left:4px; }

  .stat-row { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:var(--space-4); }
  .stat-tile { display:flex; flex-direction:column; gap:6px; padding:var(--space-4); }
  .stat-amount { font-size:1.5rem; }
  .stat-amount.positive { color:var(--status-success, #16a34a); }
  .stat-amount.negative { color:var(--danger, #dc3545); }
  .stat-of { font-size:.85rem; font-weight:400; }

  .pulse-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:var(--space-4); }
  .pulse-tile { display:flex; flex-direction:column; gap:4px; padding:var(--space-3) var(--space-4); }
  .pulse-tile :global(svg) { color:var(--text-muted); margin-bottom:2px; }
  .pulse-tile strong { font-size:.95rem; }

  /* The balance-over-time chart gets its own full-width card and a much
     bigger canvas than the old cramped stat-tile sparkline - "make the
     graph bigger" was named directly, and a 600x160 viewBox stretched
     across the card's full width reads as an actual chart instead of a
     decorative squiggle. */
  .balance-history-card { padding:var(--space-4) var(--space-5) var(--space-5); }
  .balance-chart { width:100%; height:160px; display:block; margin-top:var(--space-3); }
  .balance-chart polyline { fill:none; stroke-width:2.5; stroke:var(--text-muted); }
  .balance-chart polyline.positive { stroke:var(--status-success, #16a34a); }
  .balance-chart polyline.negative { stroke:var(--danger, #dc3545); }
  .balance-chart-legend { display:flex; justify-content:space-between; font-size:.8rem; margin-top:var(--space-2); }
  .sparkline-baseline { stroke:var(--border); stroke-width:1; stroke-dasharray:3 3; }

  .activity-list { list-style:none; margin:var(--space-3) 0 0; padding:0; display:flex; flex-direction:column; }
  .activity-list li { display:flex; align-items:center; gap:var(--space-3); padding:var(--space-3) 0; border-bottom:1px solid var(--border); font-size:.88rem; }
  .activity-list li:last-child { border-bottom:0; }
  .activity-side { text-transform:uppercase; font-size:.68rem; font-weight:800; letter-spacing:.04em; flex-shrink:0; width:2.6rem; }
  .activity-body { flex:1; min-width:0; }
  .activity-time { flex-shrink:0; font-size:.76rem; }

  /* Same "make the graph bigger" treatment for each match's own odds-
     history chart - was a 60x24 icon-sized afterthought, now a full-width
     300x70 chart with its own label above it instead of squeezed beside it. */
  .odds-history { margin:var(--space-1) 0 var(--space-4); }
  .odds-history svg { width:100%; height:70px; display:block; margin-top:6px; }
  .odds-history-line { fill:none; stroke-width:2; stroke:var(--danger, #dc3545); }
  .odds-history-label { font-size:.74rem; }

  tr.leader td { font-weight:700; }
  tr.me { background:var(--surface-2); }
  .rank-badge { display:inline-flex; align-items:center; justify-content:center; min-width:1.6rem; height:1.6rem; border-radius:50%; }
  .rank-badge.medal[data-medal="gold"] { background:color-mix(in srgb, #d4af37 30%, transparent); font-weight:700; }
  .rank-badge.medal[data-medal="silver"] { background:color-mix(in srgb, #a8a8a8 30%, transparent); font-weight:700; }
  .rank-badge.medal[data-medal="bronze"] { background:color-mix(in srgb, #b06a34 30%, transparent); font-weight:700; }

  .alliance-red { color:var(--danger, #dc3545); }
  .alliance-blue { color:var(--brand-blue, #2563eb); }

  .bet-list { display:flex; flex-direction:column; gap:var(--space-4); margin-top:var(--space-3); }
  .bet-row { border:1px solid var(--border); padding:var(--space-4) var(--space-5); }
  .bet-row-header { display:flex; align-items:center; justify-content:space-between; gap:var(--gap-2); flex-wrap:wrap; margin-bottom:var(--space-4); }
  .bet-row-header strong { font-size:1.05rem; }
  .pool-size { font-size:.78rem; }

  /* The market's headline number, the way any dedicated prediction market
     (Polymarket/Kalshi-style) leads with a percentage, not a bar chart -
     the pool-share bar below is a secondary detail, not the main read. */
  .odds-row { display:grid; grid-template-columns:1fr auto 1fr; gap:var(--space-4); align-items:stretch; margin-bottom:var(--space-3); }
  .odds-side {
    display:flex; flex-direction:column; align-items:center; gap:6px;
    padding:var(--space-4); border:1px solid var(--border); background:var(--surface-1);
    font:inherit; cursor:pointer; text-align:center;
  }
  .odds-side:hover { background:var(--surface-2); }
  .odds-side.red.chosen { border-color:var(--danger, #dc3545); background:var(--red-soft); }
  .odds-side.blue.chosen { border-color:var(--brand-blue, #2563eb); background:var(--blue-soft, #e8f1ff); }
  .odds-pct { font-size:var(--font-xl, 1.8rem); font-weight:800; }
  .odds-side.red .odds-pct { color:var(--danger, #dc3545); }
  .odds-side.blue .odds-pct { color:var(--brand-blue, #2563eb); }
  .odds-teams { font-size:.8rem; color:var(--text-secondary); font-weight:600; }
  .odds-vs { align-self:center; color:var(--text-muted); font-size:.78rem; font-weight:700; }

  .pool-bar { height:5px; background:var(--brand-blue, #2563eb); overflow:hidden; margin-bottom:var(--space-4); }
  .pool-fill { display:block; height:100%; background:var(--danger, #dc3545); }

  .bet-row-form { display:flex; align-items:center; gap:var(--space-3); flex-wrap:wrap; margin-top:var(--space-2); }
  .stake-input { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--border); padding:0 .7rem; background:var(--surface-1); }
  .stake-input span { color:var(--text-muted); }
  .stake-input input { border:0; background:none; width:5rem; padding:.55rem 0; color:inherit; font:inherit; }
  .stake-input input:focus { outline:none; }
  .my-pick { margin:var(--space-3) 0 0; font-size:.86rem; }

  .positive { color:var(--status-success, #16a34a); }
  .negative { color:var(--danger, #dc3545); }

  @media (max-width:640px) {
    /* Keep the three stat tiles in one compact row instead of stacking them
       full-width - each is a single short number, and three short numbers
       stacked into three full-height cards was pure wasted scroll for the
       same information a tight row already shows. */
    .stat-row { gap:var(--space-2); }
    .stat-tile { padding:var(--space-2); gap:1px; }
    .stat-tile .text-muted { font-size:.68rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .stat-amount { font-size:1rem; }
    .stat-of { font-size:.72rem; }
    .candy-banner { flex-wrap:wrap; }
    .candy-balance { text-align:left; }
    /* The leaderboard and settled-bets tables become one card per row - a
       data-label attribute on each <td> supplies the printed label since
       the real <th> row is hidden here. */
    .bom-table thead { display:none; }
    .bom-table, .bom-table tbody, .bom-table tr, .bom-table td { display:block; width:100%; }
    .bom-table tr { border:1px solid var(--border); border-radius:var(--radius-lg); margin-bottom:var(--space-2); overflow:hidden; }
    .bom-table td { display:flex; justify-content:space-between; align-items:center; gap:var(--space-3); text-align:right; }
    .bom-table td::before { content:attr(data-label); flex-shrink:0; text-align:left; color:var(--text-muted); font-family:var(--font-mono-stack); font-size:.66rem; text-transform:uppercase; letter-spacing:.08em; }
    /* The leaderboard specifically: two lines per scout (rank/name/balance,
       then record + pending as small muted secondary text) instead of five
       stacked label/value rows - rank was called out as taking too much
       space, and this is the same data at a fifth the height. flex-basis:
       100% on Record is what forces Record+Pending onto their own line
       while Rank/Scout/Balance share the first. */
    .leaderboard .bom-table tr { display:flex; flex-wrap:wrap; align-items:baseline; column-gap:var(--space-2); padding:var(--space-2) var(--space-3); }
    .leaderboard .bom-table td { padding:0; }
    .leaderboard .bom-table td::before { display:none; }
    .leaderboard .bom-table td[data-label="#"] { order:1; }
    .leaderboard .bom-table td[data-label="Scout"] { order:2; flex:1; min-width:0; justify-content:flex-start; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .leaderboard .bom-table td[data-label="Balance"] { order:3; }
    .leaderboard .bom-table td[data-label="Record"] { order:4; flex-basis:100%; justify-content:flex-start; font-size:.72rem; color:var(--text-muted); }
    .leaderboard .bom-table td[data-label="Pending"] { order:5; font-size:.72rem; color:var(--text-muted); }
    .leaderboard .bom-table td[data-label="Pending"]::before { content:"Pending: "; display:inline; font-size:inherit; text-transform:none; letter-spacing:normal; color:inherit; }
  }
</style>
