<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { AlertTriangle, CalendarClock, ClipboardList, MapPinned, RefreshCw, Route, Target, Users } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey, fetchAvailableScoutingEvents } from '$lib/scoutingEvent.js';
  import { buildStrategyRows, strategyTotals } from '$lib/strategyScouting.js';
  import { buildPowerRankings } from '$lib/scoutingStats.js';
  import { isMatchPlayed, matchLabel, projectMatch } from '$lib/matchProjection.js';
  import { buildTestMarketMatch } from '$lib/predictionMarket.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';
  import MatchScoutReport from '$lib/components/MatchScoutReport.svelte';

  let eventKey = '';
  let selectedEventKey = null;
  let availableEvents = [];
  let report = null;
  let matches = [];
  let eventTeams = [];
  let matchesWarning = '';
  let teamsWarning = '';
  let officialByTeam = new Map();
  let loadedEventKey = '';
  let loading = true;
  let error = '';
  let teamSearch = '';
  let selectedTeamKey = '';
  let view = 'teams'; // 'teams' | 'matches'

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
  $: selectedTeam = rows.find((row) => row.teamKey === selectedTeamKey) || filteredRows[0] || null;
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
  $: scheduledMatches = matches
    .filter((match) => !match.is_test_market)
    .slice()
    .sort((a, b) => Number(a.predicted_time || a.time || 0) - Number(b.predicted_time || b.time || 0));
  $: upcomingMatches = scheduledMatches
    .filter((match) => !isMatchPlayed(match) && [...(match.alliances?.red?.team_keys || []), ...(match.alliances?.blue?.team_keys || [])].includes('frc971'))
    // Keep the next match nearest the tab controls when the list grows upward.
    .slice()
    .reverse();
  $: playedMatches = scheduledMatches.filter((match) => isMatchPlayed(match) && [...(match.alliances?.red?.team_keys || []), ...(match.alliances?.blue?.team_keys || [])].includes('frc971')).slice().reverse();
  const teamNumber = (teamKey) => String(teamKey || '').replace(/^frc/i, '');

  const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-';
  const text = (value) => String(value || '').trim();

  function allianceTeamLabel(teamKey) {
    const team = eventTeams.find((row) => row.key === teamKey || `frc${row.team_number}` === teamKey);
    const name = String(team?.nickname || team?.name || '').trim();
    return name ? `${teamNumber(teamKey)} ${name}` : teamNumber(teamKey);
  }

  function estimatedMatchTime(match) {
    const seconds = Number(match?.predicted_time || match?.time || 0);
    return seconds > 0 ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(seconds * 1000)) : 'Time not posted';
  }

  function matchesAway(match) {
    const target = scheduledMatches.findIndex((candidate) => candidate.key === match.key);
    const firstUpcoming = scheduledMatches.findIndex((candidate) => !isMatchPlayed(candidate));
    return target >= 0 && firstUpcoming >= 0 ? Math.max(0, target - firstUpcoming) : null;
  }

  function openTeamView(row) {
    selectedTeamKey = row.teamKey;
    goto(`/teamview?event_key=${encodeURIComponent(resolvedEventKey)}&team=${encodeURIComponent(row.teamKey)}`);
  }

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
      const [response, matchesResponse, teamsResponse, officialResponse] = await Promise.all([
        fetch(`/api/scouting-report?event_key=${encodeURIComponent(resolvedEventKey)}`, { headers: authHeaders }),
        fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(resolvedEventKey)}&comp_level=all`),
        fetch(`/api/tba/event-teams?event_key=${encodeURIComponent(resolvedEventKey)}`),
        fetch(`/api/tba/event-oprs?event_key=${encodeURIComponent(resolvedEventKey)}`)
      ]);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not load scouting strategy data.');
      report = payload;
      loadedEventKey = resolvedEventKey;
      if (!selectedTeamKey && buildStrategyRows(payload.data)[0]) selectedTeamKey = buildStrategyRows(payload.data)[0].teamKey;

      const teamsPayload = await teamsResponse.json().catch(() => null);
      if (teamsResponse.ok && teamsPayload?.success) eventTeams = teamsPayload.data || [];
      else { eventTeams = []; teamsWarning = teamsPayload?.error || 'Could not load the event roster from The Blue Alliance.'; }

      const matchesPayload = await matchesResponse.json().catch(() => null);
      const scheduledMatches = matchesResponse.ok && matchesPayload?.success ? matchesPayload.data || [] : [];
      matches = [buildTestMarketMatch(resolvedEventKey, eventTeams), ...scheduledMatches];
      if (!matchesResponse.ok || !matchesPayload?.success) matchesWarning = matchesPayload?.error || 'Could not load the match schedule from The Blue Alliance.';

      const officialPayload = await officialResponse.json().catch(() => null);
      officialByTeam = new Map((officialPayload?.success ? officialPayload.data || [] : []).map((team) => [String(team.team), team]));
    } catch (cause) {
      report = null;
      eventTeams = [];
      matches = [];
      officialByTeam = new Map();
      error = cause?.message || 'Could not load scouting strategy data.';
    } finally {
      loadedEventKey = resolvedEventKey;
      loading = false;
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
      <div><h2><CalendarClock size={18} /> 971 match schedule</h2><p>Only matches containing 971. Times are Blue Alliance estimates; the nearest upcoming match stays at the top.</p></div>
    </div>
    {#if matchesWarning}<p class="muted matches-warning">{matchesWarning}</p>{/if}
    {#if !matches.length}
      <div class="empty-state">No upcoming 971 matches are on this event schedule yet.</div>
    {:else}
      <div class="board-table-wrap">
        <table class="board-table">
          <thead><tr><th>Match</th><th>Est. time</th><th>Red</th><th>Blue</th><th>Status</th></tr></thead>
          <tbody>
            {#each upcomingMatches as match (match.key)}
              {@const projection = projectMatch(match, scoutPowerByTeam)}
              {@const away = matchesAway(match)}
              <tr class:test-match={match.is_test_market}>
                <td><strong>{matchLabel(match)}</strong>{#if away != null}<small class:soon={away <= 4}>{away === 0 ? 'Up next' : `${away} match${away === 1 ? '' : 'es'} away`}</small>{/if}</td>
                <td>{estimatedMatchTime(match)}</td>
                <td class="alliance-red">{match.alliances?.red?.team_keys?.map(allianceTeamLabel).join(', ')}</td>
                <td class="alliance-blue">{match.alliances?.blue?.team_keys?.map(allianceTeamLabel).join(', ')}</td>
                <td>
                  {#if projection.redWinProbability == null}
                    <span class="muted">Not enough scouting yet</span>
                  {:else}
                    <span class="win-bar" title={`Red projected ${Math.round(projection.redWinProbability * 100)}% / Blue projected ${Math.round((1 - projection.redWinProbability) * 100)}%`}>
                      <span class="win-bar-red" style={`width:${Math.round(projection.redWinProbability * 100)}%`}></span>
                    </span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#each playedMatches as match (match.key)}
              <tr class="played-row">
                <td><strong>{matchLabel(match)}</strong></td>
                <td>{estimatedMatchTime(match)}</td>
                <td class="alliance-red" class:winner={match.winning_alliance === 'red'}>{match.alliances?.red?.team_keys?.map(teamNumber).join(', ')} <span class="muted">{match.alliances?.red?.score ?? ''}</span></td>
                <td class="alliance-blue" class:winner={match.winning_alliance === 'blue'}>{match.alliances?.blue?.team_keys?.map(teamNumber).join(', ')} <span class="muted">{match.alliances?.blue?.score ?? ''}</span></td>
                <td class="muted">{match.winning_alliance ? `${match.winning_alliance} won` : 'Tie'}</td>
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
        <div><h2>Team board</h2><p>Comparable observations from every scouting surface.</p></div>
        <input class="form-input team-search" bind:value={teamSearch} placeholder="Filter team or archetype" aria-label="Filter strategy teams" />
      </div>
      {#if !filteredRows.length}
        <div class="empty-state">No scouting evidence matches this filter yet.</div>
      {:else}
        <div class="board-table-wrap">
          <table class="board-table">
            <thead><tr><th>Rank</th><th>Team</th><th>Data matches</th><th>Reports</th><th>Fuel</th><th>Reported balls</th><th>Accuracy</th><th>Auto</th><th>Pit</th><th>Notes</th><th>Autos</th><th>Risk</th></tr></thead>
            <tbody>
              {#each filteredRows as row}
                <tr class:selected={selectedTeam?.teamKey === row.teamKey} on:click={() => openTeamView(row)}>
                  <td><strong>{officialByTeam.get(row.teamNumber)?.rank ?? '—'}</strong></td>
                  <td><strong>{row.teamNumber}</strong>{#if row.pitEntry?.robot_archetype}<small>{row.pitEntry.robot_archetype}</small>{/if}</td>
                  <td>{row.performance.matchesScouted || '-'}</td>
                  <td>{row.matchScoutSummary.reportCount || '-'}</td>
                  <td>{number(row.performance.avgFuel, 0)}</td>
                  <td>{number(row.matchScoutSummary.avgBallsScored, 0)}</td>
                  <td>{number(row.performance.avgAccuracy)}</td>
                  <td>{number(row.autoAverage, 0)}</td>
                  <td>{row.pitEntry ? 'Yes' : '-'}</td>
                  <td>{row.notes.length || '-'}</td>
                  <td>{row.autoPaths.length || '-'}</td>
                  <td>{row.openProblems.length ? `${row.openProblems.length} open` : 'Clear'}</td>
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
          <a class="btn btn-outline btn-sm" href={`/teamview?event_key=${encodeURIComponent(resolvedEventKey)}&team=${encodeURIComponent(selectedTeam.teamKey)}`}>Open team view</a>
          <a class="btn btn-outline btn-sm" href={`/powerrankings`}>Power rankings</a>
        </div>
      {:else}<div class="empty-state">Select a team to view its strategy brief.</div>{/if}
    </aside>
  </section>
  {/if}
{/if}

<style>
  .matches-board .section-heading h2 { display:flex; align-items:center; gap:var(--space-2); }
  .matches-warning { padding:0 var(--space-3); }
  .subtabs button { min-height:44px; padding:.7rem 1.25rem; font-size:.9rem; font-weight:700; }
  .test-match { background:color-mix(in srgb, var(--accent) 9%, transparent); }
  .test-match td small { display:block; margin-top:2px; color:var(--text-secondary); font-size:.7rem; }
  .test-match td small.soon, td small.soon { color:var(--danger, #dc3545); font-weight:800; }
  .alliance-red { color:var(--danger, #dc3545); }
  .alliance-blue { color:var(--brand-blue, #2563eb); }
  .played-row { opacity:.75; }
  .winner { font-weight:700; opacity:1; }
  .win-bar { display:inline-block; width:80px; height:10px; border-radius:5px; background:var(--brand-blue, #2563eb); overflow:hidden; vertical-align:middle; }
  .win-bar-red { display:block; height:100%; background:var(--danger, #dc3545); float:left; }
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
  @media (max-width:620px) { .strategy-header, .section-heading { align-items:stretch; flex-direction:column; } .header-actions > * { flex:1; } .summary-grid { grid-template-columns:repeat(2, 1fr); } .summary-grid > div { border-bottom:1px solid var(--border); } .summary-grid > div:nth-child(2n) { border-right:0; } .team-search { width:100%; } }
</style>
