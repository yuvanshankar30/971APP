<script>
  import { onMount } from 'svelte';
  import { AlertTriangle, ArrowUpDown, RefreshCw, Search, Swords, Trophy, Vote } from 'lucide-svelte';
  import RobotStarPlot from '$lib/components/RobotStarPlot.svelte';
  import MatchScoutReport from '$lib/components/MatchScoutReport.svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { getAuthHeader } from '$lib/supabase.js';
  import { applyPairwiseConsensus, buildPowerRankings, summarizePairwisePair } from '$lib/scoutingStats.js';
  import { applyRobotRatings } from '$lib/robotRatings.js';

  let eventKey = '';
  let teams = [];
  let baseTeams = [];
  let pairwiseVotes = [];
  let loading = true;
  let error = '';
  let warning = '';
  let search = '';
  let sortKey = 'scoutPower';
  let sortAsc = false;
  let compareLeftKey = '';
  let compareRightKey = '';
  let voteSaving = false;
  let voteMessage = '';
  let pairwiseVotingAvailable = true;

  const fmt = (value) => value == null ? '—' : Number(value).toFixed(1);
  const fmtPercent = (value) => value == null ? '—' : `${Math.round(value * 100)}%`;

  $: sortedTeams = [...teams].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av == null && bv == null) return a.team_number - b.team_number;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av < bv ? -1 : av > bv ? 1 : 0) * (sortAsc ? 1 : -1);
  });
  $: filteredTeams = search.trim()
    ? sortedTeams.filter((team) => {
        const query = search.trim().toLowerCase();
        return String(team.team_number).includes(query) || (team.nickname || '').toLowerCase().includes(query);
      })
    : sortedTeams;
  $: compareLeft = teams.find((team) => team.key === compareLeftKey) || null;
  $: compareRight = teams.find((team) => team.key === compareRightKey) || null;
  $: selectedPair = summarizePairwisePair(pairwiseVotes, compareLeftKey, compareRightKey);

  function sortBy(key) {
    if (sortKey === key) sortAsc = !sortAsc;
    else {
      sortKey = key;
      sortAsc = key === 'team_number' || key === 'powerRank' || key === 'humanRank';
    }
  }

  let officialByTeam = new Map();
  let officialNote = '';

  const officialRank = (team) => officialByTeam.get(team?.team_number)?.rank ?? null;
  const officialOpr = (team) => officialByTeam.get(team?.team_number)?.opr ?? null;

  async function savePairwiseVote(winnerTeamKey) {
    if (!eventKey || !compareLeftKey || !compareRightKey || compareLeftKey === compareRightKey) return;
    voteSaving = true;
    voteMessage = '';
    try {
      const response = await fetch('/api/scouting-comparisons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
        body: JSON.stringify({
          action: 'vote',
          event_key: eventKey,
          team_a_key: compareLeftKey,
          team_b_key: compareRightKey,
          winner_team_key: winnerTeamKey
        })
      });
      const result = await response.json();
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Could not save comparison.');
      const authHeaders = await getAuthHeader();
      const refreshed = await fetch(`/api/scouting-comparisons?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((res) => res.json());
      if (!refreshed?.success) throw new Error(refreshed?.error || 'Vote saved, but consensus could not refresh.');
      pairwiseVotes = refreshed.data || [];
      teams = applyPairwiseConsensus(baseTeams, pairwiseVotes);
      voteMessage = `Preference saved for team ${Number(String(winnerTeamKey).replace(/^frc/i, ''))}.`;
    } catch (cause) {
      voteMessage = cause?.message || 'Could not save comparison.';
    } finally {
      voteSaving = false;
    }
  }

  async function loadRankings() {
    if (!eventKey) return;
    loading = true;
    error = '';
    warning = '';
    officialNote = '';
    const authHeaders = await getAuthHeader();
    const [rosterResult, scoutResult, matchResult, notesResult, pitResult, problemResult, officialResult, comparisonResult, ratingsResult] = await Promise.all([
      fetch(`/api/tba/event-teams?event_key=${encodeURIComponent(eventKey)}`).then((response) => response.json()).catch(() => null),
      fetch(`/datascout?all_teams=1&event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((response) => response.json()).catch(() => null),
      fetch(`/api/matchscout?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((response) => response.json()).catch(() => null),
      fetch(`/notescout?event_key=${encodeURIComponent(eventKey)}&recent=50000`, { headers: authHeaders }).then((response) => response.json()).catch(() => null),
      fetch(`/pitscout?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((response) => response.json()).catch(() => null),
      fetch(`/api/matchscout?resource=pit-problems&event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((response) => response.json()).catch(() => null),
      fetch(`/api/tba/event-oprs?event_key=${encodeURIComponent(eventKey)}`).then((response) => response.json()).catch(() => null),
      fetch(`/api/scouting-comparisons?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((response) => response.json()).catch(() => null),
      fetch(`/api/scouting-robot-ratings?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((response) => response.json()).catch(() => null)
    ]);

    const scoutEvents = scoutResult?.success ? scoutResult.data : [];
    const matchEntries = matchResult?.success ? matchResult.data : [];
    const scoutNotes = notesResult?.success ? notesResult.data : [];
    const pitEntries = pitResult?.success ? pitResult.data : [];
    const problemReports = problemResult?.success ? problemResult.data : [];
    pairwiseVotes = comparisonResult?.success ? comparisonResult.data : [];
    pairwiseVotingAvailable = !comparisonResult?.unavailable;
    const robotRatings = ratingsResult?.success ? ratingsResult.data : [];
    if (!scoutResult?.success) warning = scoutResult?.error || 'Local scouting data is unavailable.';
    else if (scoutResult.truncated) warning = 'Only the first 50,000 scouting observations were loaded.';
    if (!matchResult?.success) warning = `${warning ? `${warning} ` : ''}${matchResult?.error || 'Match scouting reports are unavailable.'}`;
    if (!notesResult?.success) warning = `${warning ? `${warning} ` : ''}${notesResult?.error || 'Scouting notes are unavailable.'}`;
    if (!pitResult?.success) warning = `${warning ? `${warning} ` : ''}${pitResult?.error || 'Pit profiles are unavailable.'}`;
    if (!problemResult?.success) warning = `${warning ? `${warning} ` : ''}${problemResult?.error || 'Pit problem reports are unavailable.'}`;
    if (!comparisonResult?.success) warning = `${warning ? `${warning} ` : ''}${comparisonResult?.error || 'Human consensus votes are unavailable.'}`;
    if (!ratingsResult?.success && !ratingsResult?.unavailable) warning = `${warning ? `${warning} ` : ''}${ratingsResult?.error || 'Robot ratings are unavailable.'}`;

    let roster = rosterResult?.success ? rosterResult.data : [];
    if (!roster.length) {
      const keys = [...new Set([
        ...[...scoutEvents, ...matchEntries, ...scoutNotes, ...pitEntries, ...problemReports].map((row) => row.team_key),
        ...pairwiseVotes.flatMap((row) => [row.team_a_key, row.team_b_key])
      ].filter(Boolean))];
      roster = keys.map((key) => ({
        key,
        team_number: Number(String(key).replace(/^frc/i, '')),
        nickname: ''
      }));
    }
    if (!roster.length) {
      error = rosterResult?.error || 'No event teams are available.';
      teams = [];
      loading = false;
      return;
    }

    // Official rank is reference-only and never feeds buildPowerRankings().
    // OPR is different: direct instruction folds it into Scout Power itself
    // at 7.5% weight (see buildPowerRankings) - officialByTeam is passed
    // straight through as oprByTeamNumber below, so this Map is the one
    // source of truth for both the reference "Official Rank"/"TBA OPR"
    // columns and the formula input. Keyed by bare team number, which is
    // the shape api/tba/event-oprs returns.
    //
    // Note the endpoint's field is named `epa` for backwards compatibility
    // with the Statbotics route it replaced; the value it carries is TBA's
    // OPR, and it is labelled as OPR everywhere it is shown.
    officialByTeam = new Map();
    if (officialResult?.success) {
      for (const row of officialResult.data || []) {
        const teamNumber = Number(row?.team);
        if (Number.isFinite(teamNumber)) {
          officialByTeam.set(teamNumber, { rank: row?.rank ?? null, opr: row?.epa ?? null });
        }
      }
    } else if (officialResult?.error) {
      // Reference data only - a TBA outage must not hide the scouting ranking.
      officialNote = 'Official rank and TBA OPR are unavailable right now.';
    }

    baseTeams = applyRobotRatings(buildPowerRankings(roster, scoutEvents, scoutNotes, { pitEntries, problemReports, matchEntries, oprByTeamNumber: officialByTeam }), robotRatings);
    teams = applyPairwiseConsensus(baseTeams, pairwiseVotes);
    const ranked = [...teams].sort((a, b) => (b.scoutPower ?? -1) - (a.scoutPower ?? -1));
    if (!compareLeftKey && ranked[0]) compareLeftKey = ranked[0].key;
    if (!compareRightKey && ranked[1]) compareRightKey = ranked[1].key;
    loading = false;
  }

  onMount(async () => {
    eventKey = await fetchActiveScoutingEventKey();
    if (!eventKey) {
      loading = false;
      return;
    }
    await loadRankings();
  });
</script>

<svelte:head><title>Power Rankings</title></svelte:head>

<div class="page-header">
  <div class="header-content">
    <h1><Trophy size={22} /> Power Rankings</h1>
    <p>Calculated scouting power and human comparison consensus{eventKey ? ` for ${eventKey}` : ''}, with official TBA data kept as reference.</p>
  </div>
  {#if eventKey}
    <button class="btn btn-sm" on:click={loadRankings} disabled={loading}><RefreshCw size={14} /> Refresh</button>
  {/if}
</div>

{#if loading}
  <p class="text-muted">Loading power rankings...</p>
{:else if !eventKey}
  <div class="empty-state"><Trophy size={40} /><h3>No active scouting event</h3><p>Set one in <a href="/scouting-admin">Scouting Admin</a>.</p></div>
{:else if error}
  <div class="error-container"><p>{error}</p></div>
{:else}
  {#if warning}<p class="text-muted">⚠ {warning}</p>{/if}
  {#if officialNote}<p class="text-muted">⚠ {officialNote}</p>{/if}

  <section class="measure-key" aria-label="What each measure means">
    <div>
      <h3>971 Scout Power</h3>
      <p>Our own ranking, from our own scouts. 70% observed match performance, 15% explicit note impact, 7.5% pit-reported reliability, and 7.5% TBA OPR; missing inputs are omitted and the remaining weights rebalanced. An open ACE flag caps a team's self-reported reliability at 7 even if they claimed higher. <strong>Not an FRC ranking</strong> - it exists to inform our picks.</p>
    </div>
    <div>
      <h3>Human Consensus</h3>
      <p>Authenticated scouts choose between two robots. Win rate produces a separate preference rank; it never changes calculated Scout Power. A strong majority against a five-point-or-larger Scout Power gap is flagged for human review.</p>
    </div>
    <div>
      <h3>Team Rating</h3>
      <p>Scouts' own out-of-10 impressions (overall/offense/shuttling/driving/defense) plus notes, entered on <a href="/robotratings">Robot Ratings</a>. A display-only average of whoever has rated the team so far - it never changes calculated Scout Power.</p>
    </div>
    <div>
      <h3>Official Event Rank</h3>
      <p>The real qualification standing from The Blue Alliance, which FIRST computes from Ranking Points earned in qualification matches. This is the only official rank on this page.</p>
    </div>
    <div>
      <h3>TBA OPR</h3>
      <p>Offensive Power Rating: a least-squares estimate of a team's contribution to alliance score, calculated by The Blue Alliance from match results. A statistical estimate, <strong>not an official rank</strong>.</p>
    </div>
  </section>

  <section class="surface-card comparison-card">
    <h2><Swords size={18} /> Head to Head</h2>
    <div class="comparison-selectors">
      <label>Team A<select class="form-input" bind:value={compareLeftKey}>{#each [...teams].sort((a, b) => a.team_number - b.team_number) as team}<option value={team.key}>#{team.team_number} {team.nickname}</option>{/each}</select></label>
      <span>VS</span>
      <label>Team B<select class="form-input" bind:value={compareRightKey}>{#each [...teams].sort((a, b) => a.team_number - b.team_number) as team}<option value={team.key}>#{team.team_number} {team.nickname}</option>{/each}</select></label>
    </div>
    {#if compareLeft && compareRight}
      <RobotStarPlot left={compareLeft} right={compareRight} />
      <div class="preference-panel">
        <div>
          <h3><Vote size={16} /> Scout preference</h3>
          {#if compareLeftKey === compareRightKey}
            <p>Choose two different teams to compare and vote.</p>
          {:else if selectedPair.voteCount}
            <p>{selectedPair.voteCount} scout vote{selectedPair.voteCount === 1 ? '' : 's'} · Team {compareLeft.team_number}: {fmtPercent(selectedPair.firstShare)} · Team {compareRight.team_number}: {fmtPercent(selectedPair.secondShare)}</p>
          {:else if !pairwiseVotingAvailable}
            <p>Human comparison voting will be available after the scouting consensus data migration is applied.</p>
          {:else}
            <p>No preference votes for this matchup yet.</p>
          {/if}
        </div>
        <div class="vote-buttons">
          <button class="btn btn-sm" class:vote-leader={selectedPair.leaderKey === compareLeftKey} disabled={!pairwiseVotingAvailable || voteSaving || compareLeftKey === compareRightKey} on:click={() => savePairwiseVote(compareLeftKey)}>Prefer #{compareLeft.team_number}</button>
          <button class="btn btn-sm" class:vote-leader={selectedPair.leaderKey === compareRightKey} disabled={!pairwiseVotingAvailable || voteSaving || compareLeftKey === compareRightKey} on:click={() => savePairwiseVote(compareRightKey)}>Prefer #{compareRight.team_number}</button>
        </div>
      </div>
      {#if voteMessage}<p class="vote-message" aria-live="polite">{voteMessage}</p>{/if}
      <div class="comparison-grid">
        <strong>#{compareLeft.team_number}</strong><span>Metric</span><strong>#{compareRight.team_number}</strong>
        <b>{fmt(compareLeft.matchScoutSummary.avgAutoPoints)}</b><span>Auto score</span><b>{fmt(compareRight.matchScoutSummary.avgAutoPoints)}</b>
        <b>{fmt(compareLeft.matchScoutSummary.avgBallsScored)}</b><span>Teleop score</span><b>{fmt(compareRight.matchScoutSummary.avgBallsScored)}</b>
        <b>{compareLeft.powerRank ?? '—'}</b><span>Scout power rank (971)</span><b>{compareRight.powerRank ?? '—'}</b>
        <b>{fmt(compareLeft.scoutPower)}</b><span>Scout power (971)</span><b>{fmt(compareRight.scoutPower)}</b>
        <b>{compareLeft.humanRank ?? '—'}</b><span>Human consensus rank</span><b>{compareRight.humanRank ?? '—'}</b>
        <b>{fmtPercent(compareLeft.humanWinRate)}</b><span>Human preference win rate</span><b>{fmtPercent(compareRight.humanWinRate)}</b>
        <b>{compareLeft.humanVoteCount}</b><span>Human comparisons</span><b>{compareRight.humanVoteCount}</b>
        <b class:review={compareLeft.reviewFlag}>{compareLeft.reviewFlag ? 'Review' : '—'}</b><span>Power/consensus disagreement</span><b class:review={compareRight.reviewFlag}>{compareRight.reviewFlag ? 'Review' : '—'}</b>
        <b>{officialRank(compareLeft) ?? '—'}</b><span>Official event rank</span><b>{officialRank(compareRight) ?? '—'}</b>
        <b>{fmt(officialOpr(compareLeft))}</b><span>TBA OPR</span><b>{fmt(officialOpr(compareRight))}</b>
        <b>{fmt(compareLeft.robotRating.overallAvg)}</b><span>Team rating (ours)</span><b>{fmt(compareRight.robotRating.overallAvg)}</b>
        <b>{compareLeft.robotRating.raterCount}</b><span>Raters</span><b>{compareRight.robotRating.raterCount}</b>
        <b>{compareLeft.noteSummary.averageImpact ?? '—'}</b><span>Note impact</span><b>{compareRight.noteSummary.averageImpact ?? '—'}</b>
        <b>{compareLeft.noteSummary.noteCount}</b><span>Saved notes</span><b>{compareRight.noteSummary.noteCount}</b>
        <b>{fmt(compareLeft.pitSummary.pitScore)}</b><span>Pit score</span><b>{fmt(compareRight.pitSummary.pitScore)}</b>
        <b>{compareLeft.pitSummary.rawReliability ?? '—'}</b><span>Pit reliability (1-10)</span><b>{compareRight.pitSummary.rawReliability ?? '—'}</b>
        <b>{compareLeft.pitSummary.robotArchetype || '—'}</b><span>Archetype</span><b>{compareRight.pitSummary.robotArchetype || '—'}</b>
        <b>{compareLeft.pitSummary.openProblemCount}</b><span>Open pit problems</span><b>{compareRight.pitSummary.openProblemCount}</b>
        <b>{compareLeft.scoutSummary.matchesScouted}</b><span>Matches scouted</span><b>{compareRight.scoutSummary.matchesScouted}</b>
        <b>{compareLeft.matchScoutSummary.reportCount}</b><span>Match reports</span><b>{compareRight.matchScoutSummary.reportCount}</b>
        <b>{fmt(compareLeft.matchScoutSummary.avgDriverSkill)}</b><span>Driver skill</span><b>{fmt(compareRight.matchScoutSummary.avgDriverSkill)}</b>
        <b>{fmt(compareLeft.matchScoutSummary.ratingAverages.Reliability)}</b><span>Reliability (match reports)</span><b>{fmt(compareRight.matchScoutSummary.ratingAverages.Reliability)}</b>
        <b>{fmtPercent(compareLeft.matchScoutSummary.shuttlingRate)}</b><span>Shuttling rate</span><b>{fmtPercent(compareRight.matchScoutSummary.shuttlingRate)}</b>
      </div>
    {/if}
  </section>

  {#if compareLeft || compareRight}
    <section class="ranking-reports">
      <h2>Match scouting evidence</h2>
      <div class="ranking-report-grid">
        {#each [compareLeft, compareRight].filter(Boolean) as team (team.key)}
          <div>
            <h3>Team {team.team_number}</h3>
            {#if team.matchScoutEntries.length}
              {#each team.matchScoutEntries as report (report.id)}
                <MatchScoutReport {report} />
              {/each}
            {:else}<p class="text-muted">No match scouting reports yet.</p>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <div class="search"><Search size={16} /><input class="form-input" placeholder="Filter teams..." bind:value={search} /></div>
  <div class="bom-table-container">
    <table class="bom-table">
      <thead><tr>
        <th><button on:click={() => sortBy('powerRank')}># <ArrowUpDown size={11} /></button></th>
        <th><button on:click={() => sortBy('team_number')}>Team <ArrowUpDown size={11} /></button></th>
        <th>Name</th><th><button on:click={() => sortBy('scoutPower')}>Scout Power <ArrowUpDown size={11} /></button></th>
        <th><button on:click={() => sortBy('humanRank')}>Human Rank <ArrowUpDown size={11} /></button></th>
        <th><button on:click={() => sortBy('humanWinRate')}>Win Rate <ArrowUpDown size={11} /></button></th>
        <th>Review</th>
        <th title="Scouts' own out-of-10 impressions, averaged - see Robot Ratings"><button on:click={() => sortBy('robotRatingAvg')}>Team Rating <ArrowUpDown size={11} /></button></th>
        <th class="reference" title="Official FRC qualification rank from The Blue Alliance">Official Rank</th>
        <th class="reference" title="The Blue Alliance's Offensive Power Rating - a statistical estimate, not a rank">TBA OPR</th>
        <th>Data Matches</th><th>Match Reports</th><th>Auto Score</th><th>Teleop Score</th><th>Driver</th><th>Reliability</th><th>Shuttling</th><th>Pit Score</th><th>Pit Reliability</th><th>Problems</th><th>Archetype</th><th>Note Impact</th><th>Notes</th>
      </tr></thead>
      <tbody>{#each filteredTeams as team (team.key)}<tr>
        <td class="strong">{team.powerRank ?? '—'}</td><td class="mono">{team.team_number}</td><td>{team.nickname}</td>
        <td class="strong">{fmt(team.scoutPower)}</td>
        <td>{team.humanRank ?? '—'}</td>
        <td>{fmtPercent(team.humanWinRate)}</td>
        <td>{#if team.reviewFlag}<span class="review-badge" title={`${team.consensusSummary.reviewCount} strong disagreement(s)`}><AlertTriangle size={13} /> Review</span>{:else}—{/if}</td>
        <td><a href={`/robotratings?team=${team.key}`} title={`${team.robotRating.raterCount} rater(s)`}>{fmt(team.robotRatingAvg)}{#if team.robotRatingCount}<span class="text-muted"> ({team.robotRatingCount})</span>{/if}</a></td>
        <td class="reference">{officialRank(team) ?? '—'}</td>
        <td class="reference">{fmt(officialOpr(team))}</td>
        <td>{team.scoutSummary.matchesScouted}</td><td>{team.matchScoutSummary.reportCount}</td><td>{fmt(team.matchScoutSummary.avgAutoPoints)}</td><td>{fmt(team.matchScoutSummary.avgBallsScored)}</td><td>{fmt(team.matchScoutSummary.avgDriverSkill)}</td><td>{fmt(team.matchScoutSummary.ratingAverages.Reliability)}</td><td>{fmtPercent(team.matchScoutSummary.shuttlingRate)}</td><td>{fmt(team.pitSummary.pitScore)}</td><td>{team.pitSummary.rawReliability ?? '—'}</td><td>{team.pitSummary.openProblemCount}</td><td>{team.pitSummary.robotArchetype || '—'}</td><td>{team.noteSummary.averageImpact ?? '—'}</td><td>{team.noteSummary.noteCount}</td>
      </tr>{/each}</tbody>
    </table>
  </div>
{/if}

<style>
  h1, h2, .search { display:flex; align-items:center; gap:var(--gap-2); }
  .comparison-card { padding:var(--space-4); margin:var(--space-4) 0; }
  .comparison-card h2 { margin-top:0; font-size:1rem; }
  .ranking-reports { margin:var(--space-4) 0; }
  .ranking-reports h2, .ranking-reports h3 { font-size:1rem; }
  .ranking-report-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:var(--space-4); }
  .comparison-selectors { display:grid; grid-template-columns:1fr auto 1fr; align-items:end; gap:var(--gap-4); }
  .comparison-selectors label { display:grid; gap:var(--space-1); }
  .comparison-selectors > span { padding-bottom:var(--space-2); font-weight:700; color:var(--text-muted); }
  .comparison-grid { display:grid; grid-template-columns:1fr 1.25fr 1fr; text-align:center; margin-top:var(--space-4); }
  .comparison-grid > * { padding:var(--space-2); border-bottom:1px solid var(--border); }
  .comparison-grid > span { color:var(--text-muted); }
  .preference-panel { display:flex; align-items:center; justify-content:space-between; gap:var(--gap-4); padding:var(--space-3); border:1px solid var(--border); border-radius:var(--radius-md); background:var(--surface-1); }
  .preference-panel h3 { display:flex; align-items:center; gap:var(--space-1); margin:0; font-size:.86rem; }
  .preference-panel p, .vote-message { margin:var(--space-1) 0 0; color:var(--text-muted); font-size:.78rem; }
  .vote-buttons { display:flex; flex-wrap:wrap; gap:var(--gap-2); }
  .vote-buttons .vote-leader { border-color:var(--accent-strong); box-shadow:inset 0 0 0 1px var(--accent-strong); }
  .vote-message { text-align:right; }
  .review, .review-badge { color:var(--warning); }
  .review-badge { display:inline-flex; align-items:center; gap:4px; font-weight:700; white-space:nowrap; }
  /* Reference columns are visually recessive so the page reads as our ranking
     with official data alongside, not as a scoreboard of equals. */
  @media (max-width:760px) { .ranking-report-grid { grid-template-columns:1fr; } }
  .reference { color:var(--text-muted); }
  .measure-key { display:grid; grid-template-columns:repeat(auto-fit, minmax(15rem, 1fr)); gap:var(--gap-4); margin:var(--space-4) 0; }
  .measure-key h3 { margin:0 0 var(--space-1); font-size:.82rem; text-transform:uppercase; letter-spacing:.04em; }
  .measure-key p { margin:0; color:var(--text-muted); font-size:.82rem; }
  .search { margin:var(--space-4) 0 var(--space-3); }
  .search input { flex:1; }
  th button { display:inline-flex; align-items:center; gap:4px; background:none; border:0; padding:0; color:inherit; font:inherit; cursor:pointer; }
  @media (max-width:640px) {
    .comparison-selectors { grid-template-columns:1fr; }
    .comparison-selectors > span { text-align:center; padding:0; }
    .preference-panel { align-items:stretch; flex-direction:column; }
    .vote-buttons { display:grid; grid-template-columns:1fr 1fr; }
    .vote-message { text-align:left; }
  }
</style>
