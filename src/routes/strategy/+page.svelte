<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { AlertTriangle, CalendarClock, ClipboardList, MapPinned, RefreshCw, Route, Target, Users } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { toastActions } from '$lib/toast.js';
  import { fetchActiveScoutingEventKey, fetchAvailableScoutingEvents } from '$lib/scoutingEvent.js';
  import { buildStrategyRows, strategyTotals } from '$lib/strategyScouting.js';
  import { buildPowerRankings } from '$lib/scoutingStats.js';
  import { isMatchPlayed, matchLabel, projectMatch } from '$lib/matchProjection.js';
  import { formatPacificTimeWithZone } from '$lib/timezone.js';
  import { buildStrategySchedule } from '$lib/strategySchedule.js';
  import { buildTestMarketMatch } from '$lib/predictionMarket.js';
  import { fetchWithCache } from '$lib/offlineCache.js';
  import { FRC_TEAMS } from '$lib/permissions.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';
  import MatchScoutReport from '$lib/components/MatchScoutReport.svelte';
  import MatchDetailPanel from '$lib/components/MatchDetailPanel.svelte';

  const OUR_TEAM_KEY = `frc${FRC_TEAMS.TEAM_971}`;
  const matchHasOurTeam = (match) =>
    (match?.alliances?.red?.team_keys || []).includes(OUR_TEAM_KEY) ||
    (match?.alliances?.blue?.team_keys || []).includes(OUR_TEAM_KEY);

  let eventKey = '';
  let selectedEventKey = null;
  let availableEvents = [];
  let report = null;
  let scheduledMatches = [];
  let eventTeams = [];
  let matchesWarning = '';
  let teamsWarning = '';
  let officialByTeam = new Map();
  // The practice/test market row depends on eventTeams, which can land
  // after scheduledMatches does now that both come from independent
  // cache-then-network fetches - deriving matches reactively (instead of
  // rebuilding it once inline, mid-load) keeps it correct regardless of
  // which of the two callbacks fires first.
  $: matches = [buildTestMarketMatch(resolvedEventKey, eventTeams), ...scheduledMatches];
  let loadedEventKey = '';
  let loading = true;
  let error = '';
  let teamSearch = '';
  let selectedTeamKey = '';
  let view = 'teams'; // 'teams' | 'matches'
  let sortColumn = null;
  let sortDir = 'asc';
  let sendingToPicklist = false;

  $: resolvedEventKey = selectedEventKey || eventKey;
  $: rows = buildStrategyRows(report?.data || {}, eventTeams);
  $: rankedRows = [...rows].sort((a, b) => {
    const firstRank = officialByTeam.get(a.teamNumber)?.rank;
    const secondRank = officialByTeam.get(b.teamNumber)?.rank;
    if (firstRank == null && secondRank == null) return Number(a.teamNumber) - Number(b.teamNumber);
    if (firstRank == null) return 1;
    if (secondRank == null) return -1;
    return firstRank - secondRank;
  });
  $: totals = strategyTotals(rows);
  $: filteredRows = rankedRows.filter((row) => row.teamNumber.includes(teamSearch.trim()) || row.pitEntry?.robot_archetype?.toLowerCase().includes(teamSearch.trim().toLowerCase()));
  // Column headers double as a sortable pre-picklist: sorting the team board
  // and sending that order to the shared pick list is meant to be a faster
  // starting point than building a pick list from a blank list.
  const columnAccessors = {
    rank: (row) => officialByTeam.get(row.teamNumber)?.rank ?? null,
    team: (row) => Number(row.teamNumber) || 0,
    reports: (row) => row.matchScoutSummary.reportCount ?? 0,
    upcoming: (row) => upcomingMatchCount(row.teamKey),
    fuel: (row) => row.performance.avgFuel,
    balls: (row) => row.matchScoutSummary.avgBallsScored,
    accuracy: (row) => row.performance.avgAccuracy,
    auto: (row) => row.autoAverage,
    pit: (row) => (row.pitEntry ? 1 : 0),
    notes: (row) => row.notes.length,
    autos: (row) => row.autoPaths.length,
    risk: (row) => row.openProblems.length
  };
  function compareSortValues(first, second, direction) {
    const firstMissing = first == null;
    const secondMissing = second == null;
    if (firstMissing && secondMissing) return 0;
    if (firstMissing) return 1;
    if (secondMissing) return -1;
    const comparison = first - second;
    return direction === 'asc' ? comparison : -comparison;
  }
  $: sortedRows = sortColumn
    ? [...filteredRows].sort((first, second) => compareSortValues(
        columnAccessors[sortColumn](first),
        columnAccessors[sortColumn](second),
        sortDir
      ))
    : filteredRows;
  function toggleSort(column) {
    if (sortColumn === column) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column;
      sortDir = column === 'rank' ? 'asc' : 'desc';
    }
  }
  const sortIndicator = (column) => (sortColumn === column ? (sortDir === 'asc' ? '▲' : '▼') : '');
  // No fallback to filteredRows[0] here on purpose - defaulting to
  // "whichever team happened to sort first" highlighted an arbitrary row
  // on every page load with nothing to explain why that team, of all of
  // them, was singled out. Nothing is selected until a scout picks one.
  $: selectedTeam = selectedTeamKey ? rows.find((row) => row.teamKey === selectedTeamKey) || null : null;
  $: activeEventLabel = availableEvents.find((option) => option.value === eventKey)?.label || eventKey || 'not set';
  $: browseEventOptions = availableEvents.filter((option) => option.value !== eventKey);
  // Reuses the same buildPowerRankings pipeline Power Rankings itself calls,
  // fed from the report this page already loaded - no second scoring system,
  // just a projection layered on top (see matchProjection.js).
  $: powerRankings = buildPowerRankings(
    rows.map((row) => ({ key: row.teamKey, team_number: Number(row.teamNumber) || 0, nickname: '' })),
    report?.data?.data_events || [],
    report?.data?.notes || [],
    { pitEntries: report?.data?.pit_entries || [], problemReports: report?.data?.pit_problems || [], matchEntries: report?.data?.match_entries || [] }
  );
  $: scoutPowerByTeam = new Map(powerRankings.map((team) => [team.key, team.scoutPower]));
  // A rough per-team predicted-score contribution for the Statbotics-style
  // match view's predicted-score bar - not a calibrated scoring model (see
  // matchProjection.js), just auto + teleop scouted averages summed per
  // alliance so the bar means *something* relative rather than nothing.
  $: projectedScoreByTeam = new Map(rows.map((row) => [
    row.teamKey,
    (row.autoAverage ?? 0) + (row.matchScoutSummary.avgBallsScored ?? 0)
  ]));
  // Per-team breakdown markers ("ACE-like markings"): a match_entries row
  // already records teleop_robot_status (dead/stopped/brownout/active/
  // unknown) and beached per (match, team) - reused as-is, no new schema or
  // fetch, just indexed for O(1) lookup per match row.
  $: breakdownByMatchTeam = (() => {
    const byMatch = new Map();
    for (const entry of report?.data?.match_entries || []) {
      if (!entry?.match_key || !entry?.team_key) continue;
      if (!byMatch.has(entry.match_key)) byMatch.set(entry.match_key, new Map());
      byMatch.get(entry.match_key).set(entry.team_key, entry);
    }
    return byMatch;
  })();
  function teamBreakdown(matchKey, teamKey) {
    const entry = breakdownByMatchTeam.get(matchKey)?.get(teamKey);
    if (!entry) return null;
    if (entry.beached) return 'Beached';
    if (['dead', 'stopped', 'brownout'].includes(entry.teleop_robot_status)) {
      return entry.teleop_robot_status === 'dead' ? 'Dead'
        : entry.teleop_robot_status === 'brownout' ? 'Brownout'
        : 'Stopped';
    }
    return null;
  }
  $: selectedMatchBreakdown = selectedMatchForDetail
    ? new Map(
        [...(selectedMatchForDetail.alliances?.red?.team_keys || []), ...(selectedMatchForDetail.alliances?.blue?.team_keys || [])]
          .map((teamKey) => [teamKey, teamBreakdown(selectedMatchForDetail.key, teamKey)])
          .filter(([, label]) => label)
      )
    : new Map();
  // The schedule is 971-only. Its future rows intentionally render last
  // match first, while matches-away still uses chronological order.
  $: strategySchedule = buildStrategySchedule(matches, OUR_TEAM_KEY);
  $: upcomingMatches = strategySchedule.upcoming;
  $: playedMatches = strategySchedule.played;
  const teamNumber = (teamKey) => String(teamKey || '').replace(/^frc/i, '');
  // "i more want to know upcoming matches" than Data Matches as a top-level
  // column (see docs/plans/strategy-picklist-improvements.md section 5) -
  // reuses upcomingMatches, which this page already loads for the Matches
  // subtab, no new fetch.
  const upcomingMatchCount = (teamKey) =>
    strategySchedule.realUpcoming.filter((match) =>
      (match.alliances?.red?.team_keys || []).includes(teamKey) || (match.alliances?.blue?.team_keys || []).includes(teamKey)
    ).length;

  function estimatedMatchTime(seconds) {
    return Number.isFinite(Number(seconds)) ? formatPacificTimeWithZone(new Date(Number(seconds) * 1000)) : 'TBA';
  }

  const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-';
  const text = (value) => String(value || '').trim();

  function openTeamView(row) {
    selectedTeamKey = row.teamKey;
    goto(`/teamview?event_key=${encodeURIComponent(resolvedEventKey)}&team=${encodeURIComponent(row.teamKey)}&from=${encodeURIComponent('/strategy')}&fromLabel=${encodeURIComponent('Strategy')}`);
  }

  const teamHref = (teamKey) =>
    `/teamview?event_key=${encodeURIComponent(resolvedEventKey)}&team=${encodeURIComponent(teamKey)}&from=${encodeURIComponent('/strategy')}&fromLabel=${encodeURIComponent('Strategy')}`;

  // Hands the currently sorted team board off to the shared pick list as a
  // starting point - adds any team not already on the list (a 409 there just
  // means another scout already added it, not an error) then reorders the
  // whole list to match what's on screen right now. Adds run in parallel
  // (not one at a time) since a full team list can be 40+ teams - a
  // sequential loop over that many round trips is what made this feel like
  // it hung, especially on the poor/cell-only wifi typical at a competition.
  async function sendToPicklist() {
    if (!resolvedEventKey || !sortedRows.length) return;
    const confirmed = await requestConfirmation({
      title: 'Send to Picklist',
      message: `Send all ${sortedRows.length} teams to the shared pick list in the order currently shown? Teams already on the list keep their entry; only the order changes.`,
      confirmLabel: 'Send to Picklist'
    });
    if (!confirmed) return;

    sendingToPicklist = true;
    try {
      const authHeaders = await getAuthHeader();
      const headers = { 'Content-Type': 'application/json', ...authHeaders };
      const existingResponse = await fetch(`/api/scouting-picklist?event_key=${encodeURIComponent(resolvedEventKey)}`, { headers: authHeaders });
      const existingPayload = await existingResponse.json().catch(() => null);
      if (!existingResponse.ok || !existingPayload?.success) throw new Error(existingPayload?.error || 'Could not read the current pick list.');
      const idByTeamKey = new Map((existingPayload.data || []).map((entry) => [entry.team_key, entry.id]));

      const toAdd = sortedRows.filter((row) => !idByTeamKey.has(row.teamKey));
      const addResults = await Promise.all(toAdd.map(async (row) => {
        const addResponse = await fetch('/api/scouting-picklist', {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'add', event_key: resolvedEventKey, team_key: row.teamKey, team_number: row.teamNumber })
        });
        const addPayload = await addResponse.json().catch(() => null);
        if (addResponse.ok && addPayload?.success) return { teamKey: row.teamKey, id: addPayload.data.id };
        if (addResponse.status === 409) return null;
        throw new Error(addPayload?.error || `Could not add team ${row.teamNumber} to the pick list.`);
      }));
      for (const result of addResults) if (result) idByTeamKey.set(result.teamKey, result.id);

      const orderedIds = sortedRows.map((row) => idByTeamKey.get(row.teamKey)).filter(Boolean);
      const reorderResponse = await fetch('/api/scouting-picklist', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'reorder', event_key: resolvedEventKey, ordered_ids: orderedIds })
      });
      const reorderPayload = await reorderResponse.json().catch(() => null);
      if (!reorderResponse.ok || !reorderPayload?.success) throw new Error(reorderPayload?.error || 'Could not reorder the pick list.');
      toastActions.show(`Sent ${orderedIds.length} teams to the pick list.`);
    } catch (cause) {
      toastActions.show(cause?.message || 'Could not send teams to the pick list.', 5000);
    } finally {
      sendingToPicklist = false;
    }
  }

  let selectedMatchForDetail = null;
  const openMatchDetail = (match) => { selectedMatchForDetail = match; };
  const closeMatchDetail = () => { selectedMatchForDetail = null; };

  function applyTeamsPayload(payload) {
    if (payload?.success) { eventTeams = payload.data || []; teamsWarning = ''; }
    else teamsWarning = payload?.error || 'Could not load the event roster from The Blue Alliance.';
  }

  function applyMatchesPayload(payload) {
    if (payload?.success) { scheduledMatches = payload.data || []; matchesWarning = ''; }
    else matchesWarning = payload?.error || 'Could not load the match schedule from The Blue Alliance.';
  }

  // The event roster and match schedule barely change mid-event, so they go
  // through fetchWithCache: whatever was cached from the last visit paints
  // immediately via applyTeamsPayload/applyMatchesPayload, then gets
  // replaced once (if) the network request actually lands - a slow or
  // dropped connection leaves the last-known roster/schedule on screen
  // instead of a blank Teams/Matches board. OPR is reference-only and
  // fetched separately, deliberately not awaited before `loading` clears -
  // see loadOfficialRankings below.
  async function loadStrategy() {
    if (!resolvedEventKey) {
      report = null;
      loading = false;
      return;
    }
    loading = true;
    error = '';
    matchesWarning = '';
    teamsWarning = '';
    try {
      const authHeaders = await getAuthHeader();
      const [response] = await Promise.all([
        fetch(`/api/scouting-report?event_key=${encodeURIComponent(resolvedEventKey)}`, { headers: authHeaders }),
        fetchWithCache(`/api/tba/event-matches?event_key=${encodeURIComponent(resolvedEventKey)}&comp_level=all`, {
          cacheKey: `event-matches:${resolvedEventKey}:all`,
          onUpdate: applyMatchesPayload
        }).catch((e) => applyMatchesPayload({ success: false, error: e?.message })),
        fetchWithCache(`/api/tba/event-teams?event_key=${encodeURIComponent(resolvedEventKey)}`, {
          cacheKey: `event-teams:${resolvedEventKey}`,
          onUpdate: applyTeamsPayload
        }).catch((e) => applyTeamsPayload({ success: false, error: e?.message }))
      ]);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not load scouting strategy data.');
      report = payload;
      loadedEventKey = resolvedEventKey;
      loadOfficialRankings(resolvedEventKey);
    } catch (cause) {
      report = null;
      eventTeams = [];
      scheduledMatches = [];
      officialByTeam = new Map();
      error = cause?.message || 'Could not load scouting strategy data.';
    } finally {
      loadedEventKey = resolvedEventKey;
      loading = false;
    }
  }

  // Fire-and-forget, on purpose: OPR is reference data (see the "measure
  // key" copy elsewhere in this app), never something Teams/Matches needs
  // to render. Awaiting it inside loadStrategy would mean a slow or
  // unreachable OPR endpoint delays the page's actual content for no
  // reason - it fills in officialByTeam whenever it lands, or not at all.
  async function loadOfficialRankings(forEventKey) {
    try {
      // Same cache key Power Rankings uses for this same call - whichever
      // page a scout visited first warms it for the other.
      const payload = await fetchWithCache(`/api/tba/event-oprs?event_key=${encodeURIComponent(forEventKey)}`, {
        cacheKey: `event-oprs:${forEventKey}`
      });
      if (forEventKey !== resolvedEventKey) return; // event switched while this was in flight
      officialByTeam = new Map((payload?.success ? payload.data || [] : []).map((team) => [String(team.team), team]));
    } catch {
      // Reference-only - silently leave officialByTeam as whatever it was.
    }
  }

  onMount(async () => {
    [eventKey, availableEvents] = await Promise.all([fetchActiveScoutingEventKey(), fetchAvailableScoutingEvents()]);
    await loadStrategy();
  });

  $: if (resolvedEventKey && resolvedEventKey !== loadedEventKey && !loading) void loadStrategy();
</script>

<svelte:head><title>Strategy</title></svelte:head>

<div class="page-header strategy-header">
  <div>
    <span class="eyebrow">Competition</span>
    <h1><Target size={24} /> Strategy</h1>
    <p>One board for the scouting evidence behind match decisions.</p>
  </div>
  <div class="header-actions">
    <SeasonFilter options={browseEventOptions} bind:value={selectedEventKey} allLabel={`Current Event (${activeEventLabel})`} />
    <button class="btn btn-outline btn-sm" on:click={sendToPicklist} disabled={sendingToPicklist || !sortedRows.length} title="Send the sorted Team board order to the Picklist tab as a starting point">{sendingToPicklist ? 'Sending…' : 'Send to Picklist'}</button>
    <button class="btn btn-outline" on:click={loadStrategy} disabled={loading || !resolvedEventKey}><RefreshCw size={16} /> Refresh</button>
  </div>
</div>

{#if !resolvedEventKey}
  <div class="empty-state">Set an active scouting event in Scouting Admin to build the strategy board.</div>
{:else if loading}
  <div class="empty-state">Loading strategy evidence...</div>
{:else if error}
  <div class="notice notice-error">{error}</div>
{:else}
  <section class="summary-grid" aria-label="Scouting coverage">
    <div><Users size={18} /><strong>{totals.teams}</strong><span>Teams represented</span></div>
    <div><ClipboardList size={18} /><strong>{totals.matchReports}</strong><span>Match reports</span></div>
    <div><MapPinned size={18} /><strong>{totals.pitProfiles}</strong><span>Pit profiles</span></div>
    <div><Route size={18} /><strong>{totals.autoPaths}</strong><span>Saved autos</span></div>
    <div class:at-risk={totals.openProblems > 0}><AlertTriangle size={18} /><strong>{totals.openProblems}</strong><span>Open ACE issues</span></div>
  </section>

  <div class="subtabs">
    <button class:active={view === 'teams'} on:click={() => view = 'teams'}>Teams</button>
    <button class:active={view === 'matches'} on:click={() => view = 'matches'}>Matches</button>
  </div>

  {#if view === 'matches'}
  <section class="strategy-board matches-board">
    <div class="section-heading">
      <div><h2><CalendarClock size={18} /> Match schedule</h2><p>Synced from The Blue Alliance. Win likelihood is a rough estimate from our own Scout Power, not a scored prediction - <a href="/predictions">place a prediction market bet</a> on any upcoming match.</p></div>
    </div>
    {#if matchesWarning}<p class="muted matches-warning">{matchesWarning}</p>{/if}
    {#if !matches.length}
      <div class="empty-state">No match schedule yet for this event.</div>
    {:else}
      <div class="board-table-wrap">
        <table class="board-table statbotics-table">
          <thead><tr><th>Match</th><th>971</th><th>Est. time</th><th>Away</th><th>Red</th><th>Blue</th><th>Predicted</th><th>Win %</th><th>Score</th></tr></thead>
          <tbody>
            {#each [...upcomingMatches, ...playedMatches] as scheduleEntry (scheduleEntry.match.key)}
              {@const match = scheduleEntry.match}
              {@const projection = projectMatch(match, scoutPowerByTeam, projectedScoreByTeam)}
              {@const played = isMatchPlayed(match)}
              <tr class:test-match={match.is_test_market} class:our-team-match={matchHasOurTeam(match)} class:played-row={played}>
                <td data-label="Match">
                  <button type="button" class="match-link" on:click={() => openMatchDetail(match)}>{matchLabel(match)}</button>
                  {#if match.is_test_market}<small>Practice market</small>{/if}
                </td>
                <td data-label="971 alliance"><span class="alliance-badge" class:red={scheduleEntry.alliance === 'red'} class:blue={scheduleEntry.alliance === 'blue'}>{scheduleEntry.alliance || '—'}</span></td>
                <td data-label="Estimated time" class="estimated-time">{estimatedMatchTime(scheduleEntry.estimatedTime)}</td>
                <td data-label="Matches away">
                  {#if scheduleEntry.matchesAway == null}<span class="muted">—</span>
                  {:else}<span class:urgent-away={scheduleEntry.matchesAway <= 4} class="matches-away">{scheduleEntry.matchesAway === 0 ? 'Next' : `${scheduleEntry.matchesAway} away`}</span>{/if}
                </td>
                <td data-label="Red" class="alliance-red" class:winner={match.winning_alliance === 'red'}>
                  {#each match.alliances?.red?.team_keys || [] as teamKey}
                    {@const breakdown = teamBreakdown(match.key, teamKey)}
                    <a class="team-number-link" class:our-team={teamKey === OUR_TEAM_KEY} href={teamHref(teamKey)}>
                      {teamNumber(teamKey)}
                      {#if breakdown}<span class="breakdown-dot" title={`${teamNumber(teamKey)}: ${breakdown}`}></span>{/if}
                    </a>
                  {/each}
                </td>
                <td data-label="Blue" class="alliance-blue" class:winner={match.winning_alliance === 'blue'}>
                  {#each match.alliances?.blue?.team_keys || [] as teamKey}
                    {@const breakdown = teamBreakdown(match.key, teamKey)}
                    <a class="team-number-link" class:our-team={teamKey === OUR_TEAM_KEY} href={teamHref(teamKey)}>
                      {teamNumber(teamKey)}
                      {#if breakdown}<span class="breakdown-dot" title={`${teamNumber(teamKey)}: ${breakdown}`}></span>{/if}
                    </a>
                  {/each}
                </td>
                <td data-label="Predicted">
                  {#if projection.redProjectedScore == null && projection.blueProjectedScore == null}
                    <span class="muted">-</span>
                  {:else}
                    <span class="predicted-score">{number(projection.redProjectedScore, 0)} - {number(projection.blueProjectedScore, 0)}</span>
                  {/if}
                </td>
                <td data-label="Win %">
                  {#if projection.redWinProbability == null}
                    <span class="muted">Not enough scouting yet</span>
                  {:else}
                    <span class="win-bar" title={`Red projected ${Math.round(projection.redWinProbability * 100)}% / Blue projected ${Math.round((1 - projection.redWinProbability) * 100)}%`}>
                      <span class="win-bar-red" style={`width:${Math.round(projection.redWinProbability * 100)}%`}></span>
                    </span>
                  {/if}
                </td>
                <td data-label="Score" class="muted">
                  {#if !played}<span class="muted">Upcoming</span>
                  {:else}{match.alliances?.red?.score ?? '?'} - {match.alliances?.blue?.score ?? '?'}{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  {:else}
  {#if teamsWarning}<p class="muted matches-warning">{teamsWarning} Showing teams found in scouting data.</p>{/if}
  <section class="strategy-layout">
    <div class="strategy-board">
      <div class="section-heading">
        <div><h2>Team board</h2><p>Comparable observations from every scouting surface. Sort a column, then use "Send to Picklist" above to start a pick list from it.</p></div>
        <input class="form-input team-search" bind:value={teamSearch} placeholder="Filter team or archetype" aria-label="Filter strategy teams" />
      </div>
      {#if !sortedRows.length}
        <div class="empty-state">No scouting evidence matches this filter yet.</div>
      {:else}
        <div class="board-table-wrap">
          <table class="board-table">
            <thead><tr>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('rank')}>Rank {sortIndicator('rank')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('team')}>Team {sortIndicator('team')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('reports')}>Reports {sortIndicator('reports')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('upcoming')}>Upcoming {sortIndicator('upcoming')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('fuel')}>Fuel {sortIndicator('fuel')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('auto')}>Auto {sortIndicator('auto')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('balls')}>Reported balls {sortIndicator('balls')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('accuracy')}>Accuracy {sortIndicator('accuracy')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('pit')}>Pit {sortIndicator('pit')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('notes')}>Notes {sortIndicator('notes')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('autos')}>Autos {sortIndicator('autos')}</button></th>
              <th><button type="button" class="sort-btn" on:click={() => toggleSort('risk')}>Risk {sortIndicator('risk')}</button></th>
            </tr></thead>
            <tbody>
              {#each sortedRows as row}
                <tr class:selected={selectedTeam?.teamKey === row.teamKey} on:click={() => openTeamView(row)}>
                  <td data-label="Rank"><strong>{officialByTeam.get(row.teamNumber)?.rank ?? '—'}</strong></td>
                  <td data-label="Team"><strong>{row.teamNumber}</strong>{#if row.pitEntry?.robot_archetype}<small>{row.pitEntry.robot_archetype}</small>{/if}</td>
                  <td data-label="Reports">{row.matchScoutSummary.reportCount || '-'}<small>{row.performance.matchesScouted || 0} data matches</small></td>
                  <td data-label="Upcoming">{upcomingMatchCount(row.teamKey) || '-'}</td>
                  <td data-label="Fuel">{number(row.performance.avgFuel, 0)}</td>
                  <td data-label="Auto">{number(row.autoAverage, 0)}</td>
                  <td data-label="Reported balls">{number(row.matchScoutSummary.avgBallsScored, 0)}</td>
                  <td data-label="Accuracy">{number(row.performance.avgAccuracy)}</td>
                  <td data-label="Pit">{row.pitEntry ? 'Yes' : '-'}</td>
                  <td data-label="Notes">{row.notes.length || '-'}</td>
                  <td data-label="Autos">{row.autoPaths.length || '-'}</td>
                  <td data-label="Risk">{row.openProblems.length ? `${row.openProblems.length} open` : 'Clear'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <aside class="team-brief" aria-live="polite">
      {#if selectedTeam}
        <div class="brief-title"><div><span class="eyebrow">Team brief</span><h2>Team {selectedTeam.teamNumber}</h2></div><span class:status-risk={selectedTeam.openProblems.length} class="coverage">{selectedTeam.coverage} observations</span></div>
        <div class="metric-grid">
          <div><span>Fuel / match</span><strong>{number(selectedTeam.performance.avgFuel, 0)}</strong></div>
          <div><span>Auto average</span><strong>{number(selectedTeam.autoAverage, 0)}</strong></div>
          <div><span>Auto ran</span><strong>{percent(selectedTeam.autoMobilityRate)}</strong></div>
          <div><span>Climb success</span><strong>{percent(selectedTeam.performance.climbSuccessRate)}</strong></div>
          <div><span>Reported balls</span><strong>{number(selectedTeam.matchScoutSummary.avgBallsScored, 0)}</strong></div>
          <div><span>Driver skill</span><strong>{number(selectedTeam.matchScoutSummary.avgDriverSkill)}</strong></div>
          <div><span>Incidents</span><strong>{percent(selectedTeam.matchScoutSummary.incidentRate)}</strong></div>
        </div>
        <div class="brief-section match-reports">
          <h3>Match scouting reports</h3>
          {#if selectedTeam.matchEntries.length}
            {#each selectedTeam.matchEntries as entry (entry.id)}
              <MatchScoutReport report={entry} />
            {/each}
          {:else}<p class="muted">No match report yet.</p>{/if}
        </div>
        <div class="brief-section">
          <h3>Pit capability</h3>
          {#if selectedTeam.pitEntry}
            <p>{selectedTeam.pitEntry.robot_archetype || 'Archetype not recorded'}{selectedTeam.pitEntry.estimated_bps ? ` | ${selectedTeam.pitEntry.estimated_bps} estimated BPS` : ''}</p>
            {#if text(selectedTeam.pitEntry.additional_notes)}<p class="detail-copy">{selectedTeam.pitEntry.additional_notes}</p>{/if}
          {:else}<p class="muted">No pit profile yet.</p>{/if}
        </div>
        <div class="brief-section">
          <h3>Saved autonomous paths</h3>
          {#if selectedTeam.autoPaths.length}<ul>{#each selectedTeam.autoPaths.slice(0, 4) as path}<li>{path.name} <span>{path.alliance}</span></li>{/each}</ul>{:else}<p class="muted">No named auto path saved.</p>{/if}
        </div>
        <div class="brief-section">
          <h3>Scout notes</h3>
          {#if selectedTeam.notes.length}<ul>{#each selectedTeam.notes.slice(0, 3) as note}<li>{note.notes || note.note || 'Untitled note'}</li>{/each}</ul>{:else}<p class="muted">No notes yet.</p>{/if}
        </div>
        <div class="brief-section">
          <h3>ACE issues</h3>
          {#if selectedTeam.openProblems.length}<ul class="risk-list">{#each selectedTeam.openProblems as issue}<li><strong>{issue.severity || 'watch'}</strong> {issue.summary}</li>{/each}</ul>{:else}<p class="muted">No open issues.</p>{/if}
        </div>
        <div class="brief-actions">
          <a class="btn btn-outline btn-sm" href={`/teamview?event_key=${encodeURIComponent(resolvedEventKey)}&team=${encodeURIComponent(selectedTeam.teamKey)}&from=${encodeURIComponent('/strategy')}&fromLabel=${encodeURIComponent('Strategy')}`}>Open team view</a>
          <a class="btn btn-outline btn-sm" href={`/powerrankings`}>Power rankings</a>
          <a class="btn btn-outline btn-sm" href={`/picklist`}>Picklist</a>
        </div>
      {:else}<div class="empty-state">Select a team to view its strategy brief.</div>{/if}
    </aside>
  </section>
  {/if}
{/if}

<MatchDetailPanel match={selectedMatchForDetail} eventKey={resolvedEventKey} {scoutPowerByTeam} {projectedScoreByTeam} breakdownByTeam={selectedMatchBreakdown} on:close={closeMatchDetail} />

<style>
  .matches-board .section-heading h2 { display:flex; align-items:center; gap:var(--space-2); }
  .matches-warning { padding:0 var(--space-3); }
  .our-team-match { background: color-mix(in srgb, var(--chart-success) 10%, transparent); }
  .alliance-badge { display:inline-flex; min-width:3.8rem; justify-content:center; padding:3px 7px; border-radius:999px; text-transform:uppercase; font-size:.7rem; font-weight:800; letter-spacing:.04em; background:var(--surface-2); color:var(--text-secondary); }
  .alliance-badge.red { color:var(--danger, #dc3545); background:color-mix(in srgb, var(--danger, #dc3545) 13%, transparent); }
  .alliance-badge.blue { color:var(--brand-blue, #2563eb); background:color-mix(in srgb, var(--brand-blue, #2563eb) 13%, transparent); }
  .estimated-time { white-space:nowrap; font-variant-numeric:tabular-nums; }
  .matches-away { font-weight:700; white-space:nowrap; }
  .matches-away.urgent-away { color:var(--danger, #dc3545); }
  .match-link { background:none; border:none; padding:0; font:inherit; font-weight:700; color:var(--text); cursor:pointer; text-decoration:underline; text-decoration-color:transparent; }
  .match-link:hover { text-decoration-color:currentColor; }
  .team-number-link { display:inline-block; margin:0 var(--space-1) 0 0; padding:2px 6px; border-radius:var(--radius-xs); color:var(--text); text-decoration:none; font-weight:600; }
  .team-number-link:hover { text-decoration:underline; }
  .team-number-link.our-team { background: color-mix(in srgb, var(--chart-success) 20%, transparent); }
  .subtabs button { min-height:44px; padding:.7rem 1.25rem; font-size:.9rem; font-weight:700; }
  .test-match { background:color-mix(in srgb, var(--accent) 9%, transparent); }
  .test-match td small { display:block; margin-top:2px; color:var(--text-secondary); font-size:.7rem; }
  .alliance-red { color:var(--danger, #dc3545); }
  .alliance-blue { color:var(--brand-blue, #2563eb); }
  .played-row { opacity:.75; }
  .winner { font-weight:700; opacity:1; }
  .win-bar { display:inline-block; width:80px; height:10px; border-radius:5px; background:var(--brand-blue, #2563eb); overflow:hidden; vertical-align:middle; }
  .win-bar-red { display:block; height:100%; background:var(--danger, #dc3545); float:left; }
  .breakdown-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--danger, #dc3545); margin-left:3px; vertical-align:middle; }
  .predicted-score { font-variant-numeric:tabular-nums; color:var(--text-secondary); }
  .strategy-header { display:flex; justify-content:space-between; gap:var(--space-4); align-items:flex-end; }
  .strategy-header h1 { display:flex; align-items:center; gap:var(--space-2); margin:0; }
  .strategy-header p, .section-heading p { margin:var(--space-1) 0 0; color:var(--text-secondary); }
  .header-actions { display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; }
  .summary-grid { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); border:1px solid var(--border); margin-top:var(--space-4); }
  .summary-grid > div { min-height:92px; padding:var(--space-3); border-right:1px solid var(--border); display:grid; grid-template-columns:auto 1fr; gap:0 var(--space-2); align-content:center; }
  .summary-grid > div:last-child { border-right:0; }
  .summary-grid svg { color:var(--accent); grid-row:span 2; align-self:center; }
  .summary-grid strong { font-size:1.35rem; line-height:1.1; }
  .summary-grid span { color:var(--text-secondary); font-size:.82rem; }
  .summary-grid .at-risk svg, .summary-grid .at-risk strong { color:var(--danger, #dc3545); }
  .strategy-layout { display:grid; grid-template-columns:minmax(0, 1.7fr) minmax(290px, .8fr); gap:var(--space-4); margin-top:var(--space-4); align-items:start; }
  .strategy-board, .team-brief { border:1px solid var(--border); background:var(--surface-1); }
  .section-heading, .brief-title { display:flex; justify-content:space-between; gap:var(--space-3); align-items:center; padding:var(--space-3); border-bottom:1px solid var(--border); }
  h2, h3 { margin:0; }
  .team-search { width:min(260px, 100%); }
  .sort-btn { background:none; border:none; padding:0; margin:0; font:inherit; color:inherit; text-transform:inherit; letter-spacing:inherit; cursor:pointer; white-space:nowrap; }
  .sort-btn:hover { text-decoration:underline; }
  .board-table-wrap { overflow:auto; }
  .board-table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th { background:var(--surface-2); color:var(--text-secondary); font-size:.72rem; letter-spacing:.04em; text-align:left; text-transform:uppercase; white-space:nowrap; }
  th, td { padding:.7rem var(--space-2); border-bottom:1px solid var(--border); }
  tbody tr { cursor:pointer; }
  tbody tr:hover, tbody tr.selected { background:var(--brand-gold-soft); }
  td small { display:block; color:var(--text-secondary); margin-top:2px; }
  .coverage { white-space:nowrap; color:var(--text-secondary); font-size:.8rem; }
  .coverage.status-risk { color:var(--danger, #dc3545); font-weight:700; }
  .metric-grid { display:grid; grid-template-columns:repeat(2, 1fr); border-bottom:1px solid var(--border); }
  .metric-grid div { padding:var(--space-3); border-right:1px solid var(--border); border-bottom:1px solid var(--border); display:grid; gap:var(--space-1); }
  .metric-grid div:nth-child(2n) { border-right:0; }
  .metric-grid span, .muted { color:var(--text-secondary); font-size:.82rem; }
  .metric-grid strong { font-size:1.2rem; }
  .brief-section { padding:var(--space-3); border-bottom:1px solid var(--border); }
  .brief-section h3 { font-size:.9rem; margin-bottom:var(--space-1); }
  .brief-section p { margin:0; line-height:1.45; }
  .detail-copy { margin-top:var(--space-2) !important; color:var(--text-secondary); }
  ul { margin:0; padding-left:1.1rem; display:grid; gap:.35rem; }
  li span { color:var(--text-secondary); font-size:.8rem; text-transform:capitalize; }
  .risk-list strong { color:var(--danger, #dc3545); text-transform:capitalize; }
  .brief-actions { display:flex; gap:var(--space-2); padding:var(--space-3); flex-wrap:wrap; }
  .empty-state, .notice { border:1px solid var(--border); padding:var(--space-4); margin-top:var(--space-4); color:var(--text-secondary); }
  .notice-error { border-color:var(--danger, #dc3545); color:var(--danger, #dc3545); }
  @media (max-width:900px) { .summary-grid { grid-template-columns:repeat(3, 1fr); } .summary-grid > div:nth-child(3) { border-right:0; } .strategy-layout { grid-template-columns:1fr; } }
  @media (max-width:620px) {
    .strategy-header, .section-heading { align-items:stretch; flex-direction:column; }
    .header-actions > * { flex:1; }
    .summary-grid { grid-template-columns:repeat(2, 1fr); }
    .summary-grid > div { border-bottom:1px solid var(--border); }
    .summary-grid > div:nth-child(2n) { border-right:0; }
    .team-search { width:100%; }
    .metric-grid { grid-template-columns:1fr; }
    .metric-grid div, .metric-grid div:nth-child(2n) { border-right:0; }
    /* Both board-table uses (match schedule, team board) become a stacked
       card per row instead of a table too wide to fit - a data-label
       attribute on each <td> (see markup) supplies the printed label since
       the real <th> row is hidden here. */
    .board-table-wrap { overflow:visible; }
    .board-table thead { display:none; }
    .board-table, .board-table tbody, .board-table tr, .board-table td { display:block; width:100%; }
    .board-table tr { border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:var(--space-3); overflow:hidden; }
    .board-table td { display:flex; justify-content:space-between; align-items:center; gap:var(--space-3); text-align:right; }
    .board-table td::before { content:attr(data-label); flex-shrink:0; text-align:left; color:var(--text-secondary); font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; }
    .win-bar { width:min(140px, 45vw); }
  }
</style>
