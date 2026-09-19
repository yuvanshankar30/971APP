<script>
  import { onMount } from 'svelte';
  import { TrendingUp, Calendar, MapPin, Sparkles, RefreshCw } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey, fetchAvailableScoutingEvents } from '$lib/scoutingEvent.js';
  import { computeEventEpa, winProbability } from '$lib/epaModel.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';

  // See GitHub issue #854: a Competition tab that computes our own EPA
  // (Expected Points Added) from raw TBA match data, rather than only
  // showing TBA's OPR/rank as reference input the way Power Rankings does.
  // computeEventEpa (src/lib/epaModel.js) is a first-pass, from-scratch
  // implementation - the issue flags that Omer reportedly has working EPA
  // code already, so this needs reconciling against his before it's
  // considered a final formula. That's the whole reason this ships as a
  // draft PR rather than merged: it's a real, working starting point, not
  // the last word on the calculation.
  //
  // Reuses only existing /api/tba/* proxies (event-matches, event-oprs,
  // event-info, event-teams) - no new server routes, per the issue's own
  // guidance to follow that established pattern rather than ad hoc calls.

  let eventKey = '';
  let selectedEventKey = null;
  let availableEvents = [];
  let eventInfo = null;
  let eventTeams = [];

  let loading = true;
  let error = '';
  let loadedEventKey = null;

  let matches = [];
  let oprRows = [];
  let epaByTeam = new Map();

  let activeSubtab = 'rankings'; // 'rankings' | 'events' | 'predict'

  let predictMatchKey = '';
  let predictRedKey = '';
  let predictBlueKey = '';

  $: resolvedEventKey = selectedEventKey || eventKey;
  $: activeEventLabel = availableEvents.find((option) => option.value === eventKey)?.label || eventKey || 'not set';
  $: browseEventOptions = availableEvents.filter((option) => option.value !== eventKey);

  const teamNumber = (key) => String(key || '').replace(/^frc/i, '');
  const points = (value) => (Number.isFinite(value) ? value.toFixed(1) : '—');
  const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—');

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload.data;
  }

  async function loadEvent() {
    if (!resolvedEventKey) { loading = false; return; }
    loadedEventKey = resolvedEventKey;
    loading = true;
    error = '';
    try {
      const [matchData, oprData, infoData, teamsData] = await Promise.all([
        fetchJson(`/api/tba/event-matches?event_key=${encodeURIComponent(resolvedEventKey)}&comp_level=all`),
        fetchJson(`/api/tba/event-oprs?event_key=${encodeURIComponent(resolvedEventKey)}`),
        fetchJson(`/api/tba/event-info?event_key=${encodeURIComponent(resolvedEventKey)}`).catch(() => null),
        fetchJson(`/api/tba/event-teams?event_key=${encodeURIComponent(resolvedEventKey)}`).catch(() => [])
      ]);
      matches = matchData || [];
      oprRows = oprData || [];
      eventInfo = infoData;
      eventTeams = teamsData || [];
      epaByTeam = computeEventEpa(matches);
      if (!predictMatchKey) {
        const upcoming = matches.find((m) => !m.actual_time) || matches[matches.length - 1];
        if (upcoming) selectMatchForPredict(upcoming.key);
      }
    } catch (exception) {
      error = exception?.message || 'Could not load EPA data for that event.';
      matches = [];
      oprRows = [];
      epaByTeam = new Map();
    } finally {
      loading = false;
    }
  }

  function selectMatchForPredict(matchKey) {
    predictMatchKey = matchKey;
    const match = matches.find((m) => m.key === matchKey);
    predictRedKey = '';
    predictBlueKey = '';
    if (match) return; // alliance strength comes from the match's own teams, see predictedMatch below
  }

  $: predictedFromSchedule = matches.find((m) => m.key === predictMatchKey) || null;
  $: manualPrediction = (!predictedFromSchedule && predictRedKey && predictBlueKey)
    ? { red: [predictRedKey], blue: [predictBlueKey] }
    : null;
  $: predictionTeams = predictedFromSchedule
    ? { red: predictedFromSchedule.alliances?.red?.team_keys || [], blue: predictedFromSchedule.alliances?.blue?.team_keys || [] }
    : manualPrediction;

  function allianceEpaTotal(teamKeys) {
    const known = teamKeys.map((key) => epaByTeam.get(key)?.epa).filter(Number.isFinite);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  }

  $: predictRedTotal = predictionTeams ? allianceEpaTotal(predictionTeams.red) : null;
  $: predictBlueTotal = predictionTeams ? allianceEpaTotal(predictionTeams.blue) : null;
  $: predictRedWinProb = (predictRedTotal != null && predictBlueTotal != null)
    ? winProbability(predictRedTotal, predictBlueTotal)
    : null;

  $: rankingRows = oprRows
    .map((row) => {
      const teamKey = `frc${row.team}`;
      const epaRow = epaByTeam.get(teamKey);
      const totalMatches = row.wins + row.losses + row.ties;
      return {
        teamKey,
        team: row.team,
        epa: epaRow?.epa ?? null,
        opr: row.epa, // event-oprs aliases OPR as "epa" for historical reasons - see its own file header
        winPct: totalMatches ? row.wins / totalMatches : null,
        avgScore: epaRow?.avgScore ?? null,
        matches: epaRow?.matchesPlayed ?? totalMatches,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties
      };
    })
    .sort((a, b) => (b.epa ?? -Infinity) - (a.epa ?? -Infinity));

  onMount(async () => {
    eventKey = (await fetchActiveScoutingEventKey()) || '';
    availableEvents = await fetchAvailableScoutingEvents();
    await loadEvent();
  });

  $: if (resolvedEventKey && resolvedEventKey !== loadedEventKey && !loading) void loadEvent();
</script>

<svelte:head><title>EPA</title></svelte:head>

<div class="epa-page">
  <div class="page-header">
    <div>
      <h1><TrendingUp size={22} /> EPA</h1>
      <p>Our own Expected Points Added rating, computed from raw match data - a second, statistically-grounded lens alongside Scout Power.</p>
    </div>
    <div class="header-actions">
      <SeasonFilter options={browseEventOptions} bind:value={selectedEventKey} allLabel={`Current Event (${activeEventLabel})`} />
      <button class="btn btn-outline" on:click={loadEvent} disabled={loading || !resolvedEventKey}><RefreshCw size={16} /> Refresh</button>
    </div>
  </div>

  {#if !resolvedEventKey}
    <div class="empty-state">Set an active scouting event in Scouting Admin to compute EPA here.</div>
  {:else if loading}
    <div class="empty-state">Loading {resolvedEventKey}...</div>
  {:else if error}
    <div class="notice notice-error">{error}</div>
  {:else}
    <div class="subtab-strip" role="tablist">
      <button class="subtab" class:active={activeSubtab === 'rankings'} on:click={() => activeSubtab = 'rankings'}><TrendingUp size={14} /> Rankings</button>
      <button class="subtab" class:active={activeSubtab === 'events'} on:click={() => activeSubtab = 'events'}><Calendar size={14} /> Events</button>
      <button class="subtab" class:active={activeSubtab === 'predict'} on:click={() => activeSubtab = 'predict'}><Sparkles size={14} /> Predict</button>
    </div>

    {#if activeSubtab === 'rankings'}
      {#if !rankingRows.length}
        <div class="empty-state">No OPR/ranking data published yet for {resolvedEventKey}.</div>
      {:else}
        <div class="tba-table-wrap">
          <table class="tba-table">
            <thead>
              <tr><th>Rank</th><th>Team</th><th>EPA</th><th>OPR</th><th>Win%</th><th>Avg Score</th><th>Matches</th><th>Record</th></tr>
            </thead>
            <tbody>
              {#each rankingRows as row, index}
                <tr>
                  <td>{index + 1}</td>
                  <td><a href={`/teamview?team=${encodeURIComponent(teamNumber(row.teamKey))}&event_key=${encodeURIComponent(resolvedEventKey)}&from=/epa&fromLabel=EPA`}>#{row.team}</a></td>
                  <td class="strong">{points(row.epa)}</td>
                  <td>{points(row.opr)}</td>
                  <td>{pct(row.winPct)}</td>
                  <td>{points(row.avgScore)}</td>
                  <td>{row.matches}</td>
                  <td class="mono">{row.wins}-{row.losses}-{row.ties}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else if activeSubtab === 'events'}
      <div class="event-card">
        <h2>{eventInfo?.name || resolvedEventKey}</h2>
        <div class="event-meta">
          {#if eventInfo?.start_date}<span><Calendar size={13} /> {eventInfo.start_date} – {eventInfo.end_date}</span>{/if}
          {#if eventInfo?.city || eventInfo?.state_prov}<span><MapPin size={13} /> {[eventInfo?.city, eventInfo?.state_prov].filter(Boolean).join(', ')}</span>{/if}
          <span>{eventTeams.length} teams</span>
          <span>{matches.filter((m) => m.actual_time).length} of {matches.length} matches played</span>
        </div>
        <p class="tba-muted">Rankings and Predict both use this event. Switch events with the picker above.</p>
      </div>
    {:else}
      <div class="predict-card">
        <div class="form-group">
          <label class="form-label" for="epa-predict-match">Match</label>
          <select id="epa-predict-match" class="form-select" bind:value={predictMatchKey} on:change={() => selectMatchForPredict(predictMatchKey)}>
            <option value="">Pick two teams manually instead</option>
            {#each matches as match}
              <option value={match.key}>{String(match.comp_level || '').toUpperCase()} {match.match_number} - {teamNumber(match.alliances?.red?.team_keys?.[0])}/{teamNumber(match.alliances?.red?.team_keys?.[1])}/{teamNumber(match.alliances?.red?.team_keys?.[2])} vs {teamNumber(match.alliances?.blue?.team_keys?.[0])}/{teamNumber(match.alliances?.blue?.team_keys?.[1])}/{teamNumber(match.alliances?.blue?.team_keys?.[2])}</option>
            {/each}
          </select>
        </div>

        {#if !predictedFromSchedule}
          <div class="manual-teams">
            <div class="form-group">
              <label class="form-label" for="epa-predict-red">Red team</label>
              <select id="epa-predict-red" class="form-select" bind:value={predictRedKey}>
                <option value="">Choose a team</option>
                {#each eventTeams as team}<option value={team.key}>#{teamNumber(team.key)}</option>{/each}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="epa-predict-blue">Blue team</label>
              <select id="epa-predict-blue" class="form-select" bind:value={predictBlueKey}>
                <option value="">Choose a team</option>
                {#each eventTeams as team}<option value={team.key}>#{teamNumber(team.key)}</option>{/each}
              </select>
            </div>
          </div>
        {/if}

        {#if predictionTeams && predictRedWinProb != null}
          <div class="predict-result">
            <div class="predict-alliance red">
              <span class="predict-alliance-label">Red</span>
              {#each predictionTeams.red as key}<span class="predict-team">#{teamNumber(key)}</span>{/each}
              <strong class="predict-score">{points(predictRedTotal)}</strong>
              <span class="predict-prob">{pct(predictRedWinProb)} to win</span>
            </div>
            <div class="predict-vs">vs</div>
            <div class="predict-alliance blue">
              <span class="predict-alliance-label">Blue</span>
              {#each predictionTeams.blue as key}<span class="predict-team">#{teamNumber(key)}</span>{/each}
              <strong class="predict-score">{points(predictBlueTotal)}</strong>
              <span class="predict-prob">{pct(1 - predictRedWinProb)} to win</span>
            </div>
          </div>
        {:else if predictionTeams}
          <p class="tba-muted">Not enough EPA data yet for one or both alliances - they may not have played a match.</p>
        {:else}
          <p class="tba-muted">Pick a match or two teams to see a prediction.</p>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .epa-page {
    --home-radius: 0;
    max-width: 1100px;
    margin: var(--space-6) auto;
    padding: 0 var(--space-4);
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }

  .page-header h1 { display: flex; align-items: center; gap: var(--space-2); margin: 0; }
  .page-header p { margin: var(--space-1) 0 0; color: var(--text-secondary); max-width: 42em; }
  .header-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }

  .subtab-strip { display: flex; gap: 1px; background: var(--border); border: 1px solid var(--border); margin-bottom: var(--space-4); }
  .subtab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: none;
    background: var(--surface-1);
    color: var(--text-secondary);
    font-weight: 600;
    cursor: pointer;
  }
  .subtab:hover { background: var(--surface-2); }
  .subtab.active { background: var(--accent-subtle); color: var(--secondary); box-shadow: inset 0 -3px 0 var(--brand-gold-strong); }

  .tba-table-wrap { overflow-x: auto; }
  .tba-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .tba-table th, .tba-table td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); text-align: left; }
  .tba-table th { color: var(--text-muted); font-weight: 700; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.03em; }
  .tba-table .strong { font-weight: 700; color: var(--secondary); }
  .tba-table .mono { font-family: var(--font-mono-stack); color: var(--text-secondary); }
  .tba-table a { color: var(--accent-strong); text-decoration: none; font-weight: 600; }
  .tba-table a:hover { text-decoration: underline; }

  .event-card { background: var(--surface-1); border: 1px solid var(--border); border-left: 3px solid var(--brand-gold-strong); padding: var(--space-4) var(--space-5); }
  .event-card h2 { margin: 0; font-size: var(--font-lg); color: var(--secondary); }
  .event-meta { display: flex; flex-wrap: wrap; gap: var(--space-4); margin: var(--space-3) 0; font-size: 0.82rem; color: var(--text-secondary); }
  .event-meta span { display: inline-flex; align-items: center; gap: 0.3rem; }
  .tba-muted { color: var(--text-muted); font-size: 0.88rem; }

  .predict-card { background: var(--surface-1); border: 1px solid var(--border); padding: var(--space-4) var(--space-5); display: grid; gap: var(--space-4); }
  .manual-teams { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }

  .predict-result { display: grid; grid-template-columns: 1fr auto 1fr; gap: var(--space-4); align-items: center; }
  .predict-alliance { display: flex; flex-direction: column; align-items: center; gap: var(--space-1); padding: var(--space-4); }
  .predict-alliance.red { background: var(--red-soft); }
  .predict-alliance.blue { background: var(--blue-soft, #e8f1ff); }
  .predict-alliance-label { font-size: var(--font-xs); font-weight: 700; text-transform: uppercase; color: var(--text-muted); }
  .predict-team { font-weight: 600; }
  .predict-score { font-size: var(--font-xl); }
  .predict-prob { font-size: 0.8rem; color: var(--text-secondary); }
  .predict-vs { color: var(--text-muted); font-weight: 700; }

  .notice { border: 1px solid var(--border); padding: var(--space-4); }
  .notice-error { border-color: var(--danger, #dc3545); color: var(--danger, #dc3545); }

  @media (max-width: 640px) {
    .predict-result { grid-template-columns: 1fr; }
    .manual-teams { grid-template-columns: 1fr; }
  }
</style>
