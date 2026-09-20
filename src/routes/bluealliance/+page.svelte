<script>
  import { onMount } from 'svelte';
  import { Radar, ExternalLink, MapPin, Calendar, Trophy, Users, Award, ChevronDown, ChevronRight, RefreshCw, Search, ListOrdered } from 'lucide-svelte';
  import { fetchWithCache } from '$lib/offlineCache.js';

  // Team/event browser backed by The Blue Alliance - any team, not just
  // 971/9584 (the old version's FEATURED_TEAMS pill-switcher hardcoded
  // exactly those two). Restyled in this app's own design language
  // (sharp corners, gold accents) instead of a TBA-blue replica, and
  // split into subtabs: Events (the original season/event/rankings drill-
  // down) and Match Schedule (every match a team plays in a season, across
  // every event, in one flat chronological list - no expanding events one
  // at a time to find it).
  //
  // Every fetch below hits a NEW, distinctly-named /api/tba/* route
  // (team-profile, team-years, team-events, event-info, event-rankings,
  // event-alliances, event-awards, team-event-status) added alongside the
  // existing ones (event-matches, event-teams, event-oprs, team-matches,
  // team-media, teams-simple) used elsewhere in the app (Strategy, Power
  // Rankings, Picklist, Drive Team). Match Schedule reuses team-matches
  // (already built for Strategy/Picklist's cross-event match history);
  // Events reuses event-matches - nothing here duplicates or shadows an
  // existing route.

  const DEFAULT_TEAM_NUMBER = '971';
  const COMP_LEVEL_LABEL = { qm: 'Qualification', ef: 'Eighthfinal', qf: 'Quarterfinal', sf: 'Semifinal', f: 'Final' };
  const COMP_LEVEL_ORDER = ['qm', 'ef', 'qf', 'sf', 'f'];

  let teamNumberInput = DEFAULT_TEAM_NUMBER;
  let activeTeamKey = '';
  let teamProfile = null;
  let teamLoading = false;
  let teamError = '';

  let years = [];
  let selectedYear = new Date().getFullYear();

  let events = [];
  let eventsLoading = false;
  let eventsError = '';

  let expandedEventKey = '';
  let eventDetail = {}; // event_key -> { loading, error, info, matchesByLevel, rankings, sortOrderInfo, alliances, awards, status }
  let eventSubtab = {}; // event_key -> 'rankings' | 'alliances' | 'awards' | 'matches'

  let activeSubtab = 'events'; // 'events' | 'matches'
  let seasonMatches = [];
  let seasonMatchesLoading = false;
  let seasonMatchesError = '';
  let seasonMatchesLoadedFor = ''; // `${activeTeamKey}::${selectedYear}` already fetched

  const teamNumber = (key) => Number(String(key || '').replace(/^frc/i, ''));

  function matchLabel(match) {
    const level = String(match?.comp_level || '').toLowerCase();
    if (level === 'qm') return `Qual ${match.match_number}`;
    if (level === 'f') return `Final ${match.match_number}`;
    const name = COMP_LEVEL_LABEL[level] || level.toUpperCase();
    return `${name} ${match?.set_number ?? '?'} Match ${match?.match_number}`;
  }

  // Cached - almost everything this page shows (a past event's rankings,
  // a completed match's score, a team's own profile) never changes once
  // it exists, and even a live event's data moves slowly by scouting-app
  // standards. The URL itself is a fine cache key here since every caller
  // already encodes the team/event it's asking about into it.
  // Unlike the old version, the real error message survives instead of
  // being swallowed into one generic string - a 404 ("Team not found"), a
  // missing server API key, and a network timeout are different problems
  // and now read as different messages.
  async function fetchJson(url) {
    const payload = await fetchWithCache(url);
    if (!payload?.success) throw new Error(payload?.error || 'Request failed');
    return payload.data;
  }

  function normalizeTeamKey(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    return digits ? `frc${digits}` : '';
  }

  async function searchTeam() {
    const key = normalizeTeamKey(teamNumberInput);
    if (!key) { teamError = 'Enter a team number.'; return; }
    await loadTeam(key);
  }

  async function loadTeam(teamKey) {
    activeTeamKey = teamKey;
    teamNumberInput = String(teamNumber(teamKey));
    expandedEventKey = '';
    eventDetail = {};
    activeSubtab = 'events';
    seasonMatches = [];
    seasonMatchesLoadedFor = '';
    teamLoading = true;
    teamError = '';
    events = [];

    try {
      const [profile, yearList] = await Promise.all([
        fetchJson(`/api/tba/team-profile?team_key=${encodeURIComponent(teamKey)}`),
        fetchJson(`/api/tba/team-years?team_key=${encodeURIComponent(teamKey)}`)
      ]);
      teamProfile = profile;
      years = yearList || [];
      const currentYear = new Date().getFullYear();
      selectedYear = years.includes(currentYear) ? currentYear : (years[0] || currentYear);
      await loadEvents();
    } catch (exception) {
      teamProfile = null;
      teamError = exception?.message || 'Could not load this team from The Blue Alliance.';
    } finally {
      teamLoading = false;
    }
  }

  async function loadEvents() {
    eventsLoading = true;
    eventsError = '';
    expandedEventKey = '';
    seasonMatches = [];
    seasonMatchesLoadedFor = '';
    try {
      events = await fetchJson(`/api/tba/team-events?team_key=${encodeURIComponent(activeTeamKey)}&year=${encodeURIComponent(selectedYear)}`) || [];
    } catch (exception) {
      eventsError = exception?.message || 'Could not load events for that season.';
      events = [];
    } finally {
      eventsLoading = false;
    }
    if (activeSubtab === 'matches') void loadSeasonMatches();
  }

  async function toggleEvent(eventKey) {
    if (expandedEventKey === eventKey) {
      expandedEventKey = '';
      return;
    }
    expandedEventKey = eventKey;
    if (!eventSubtab[eventKey]) eventSubtab = { ...eventSubtab, [eventKey]: 'rankings' };
    if (!eventDetail[eventKey]) await loadEventDetail(eventKey);
  }

  async function loadEventDetail(eventKey) {
    eventDetail = { ...eventDetail, [eventKey]: { loading: true, error: '' } };
    const [info, matches, rankingsPayload, allianceRows, awards, status] = await Promise.allSettled([
      fetchJson(`/api/tba/event-info?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`),
      fetchJson(`/api/tba/event-rankings?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/event-alliances?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/event-awards?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/team-event-status?team_key=${encodeURIComponent(activeTeamKey)}&event_key=${encodeURIComponent(eventKey)}`)
    ]);

    const value = (settled) => (settled.status === 'fulfilled' ? settled.value : null);
    const matchesValue = value(matches);
    const matchesByLevel = {};
    for (const match of matchesValue || []) {
      const level = String(match?.comp_level || '').toLowerCase();
      if (!matchesByLevel[level]) matchesByLevel[level] = [];
      matchesByLevel[level].push(match);
    }
    const rankingsValue = value(rankingsPayload);

    eventDetail = {
      ...eventDetail,
      [eventKey]: {
        loading: false,
        error: matchesValue == null ? (matches.reason?.message || 'Could not load this event fully.') : '',
        info: value(info),
        matchesByLevel,
        rankings: rankingsValue?.rankings || [],
        sortOrderInfo: rankingsValue?.sort_order_info || [],
        alliances: value(allianceRows) || [],
        awards: value(awards) || [],
        status: value(status)
      }
    };
  }

  function refreshExpanded() {
    if (expandedEventKey) loadEventDetail(expandedEventKey);
  }

  async function selectSubtab(key) {
    activeSubtab = key;
    if (key === 'matches') await loadSeasonMatches();
  }

  async function loadSeasonMatches() {
    const cacheKey = `${activeTeamKey}::${selectedYear}`;
    if (seasonMatchesLoadedFor === cacheKey || seasonMatchesLoading) return;
    seasonMatchesLoading = true;
    seasonMatchesError = '';
    try {
      seasonMatches = await fetchJson(`/api/tba/team-matches?team_key=${encodeURIComponent(activeTeamKey)}&year=${encodeURIComponent(selectedYear)}`) || [];
      seasonMatchesLoadedFor = cacheKey;
    } catch (exception) {
      seasonMatchesError = exception?.message || 'Could not load the match schedule for that season.';
      seasonMatches = [];
    } finally {
      seasonMatchesLoading = false;
    }
  }

  function matchTime(match) {
    const seconds = match?.actual_time || match?.predicted_time || match?.time;
    if (!seconds) return '';
    try {
      return new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  $: eventNameByKey = Object.fromEntries(events.map((event) => [event.key, event.name]));
  $: eventStartByKey = Object.fromEntries(events.map((event) => [event.key, event.start_date || '']));

  // Grouped by EVENT first, then by comp level inside it. Flattening the
  // whole season into one "Qualification" list put Qual 1 from March
  // directly under Qual 117 from May, repeated every match number once per
  // event, and forced the event name onto every single row (where it wrapped
  // to three lines and made every row a different height).
  $: seasonMatchGroups = (() => {
    const byEvent = new Map();
    for (const match of seasonMatches) {
      const key = match?.event_key || '';
      if (!byEvent.has(key)) byEvent.set(key, []);
      byEvent.get(key).push(match);
    }
    return [...byEvent.entries()]
      .sort((left, right) => String(eventStartByKey[left[0]] || '').localeCompare(String(eventStartByKey[right[0]] || '')))
      .map(([eventKey, eventMatches]) => ({
        eventKey,
        eventName: eventNameByKey[eventKey] || eventKey,
        startDate: eventStartByKey[eventKey] || '',
        levels: COMP_LEVEL_ORDER
          .map((level) => ({
            level,
            label: COMP_LEVEL_LABEL[level],
            matches: eventMatches
              .filter((match) => String(match?.comp_level || '').toLowerCase() === level)
              .sort((left, right) => (left.match_number || 0) - (right.match_number || 0))
          }))
          .filter((group) => group.matches.length)
      }));
  })();

  onMount(() => {
    loadTeam(normalizeTeamKey(DEFAULT_TEAM_NUMBER));
  });
</script>

<svelte:head><title>Blue Alliance</title></svelte:head>

<div class="tba-page">
  <header class="tba-header">
    <div>
      <h1><Radar size={22} /> Blue Alliance</h1>
      <p>Look up any team's events, rankings, and match schedule.</p>
    </div>
    <form class="team-search" on:submit|preventDefault={searchTeam}>
      <label for="tba-team-input">Team #</label>
      <input id="tba-team-input" class="form-input" type="text" inputmode="numeric" bind:value={teamNumberInput} placeholder="971" />
      <button class="btn btn-primary" type="submit" disabled={teamLoading}><Search size={14} /> Search</button>
    </form>
  </header>

  {#if teamLoading}
    <div class="empty-state">Loading team...</div>
  {:else if teamError}
    <div class="notice notice-error">{teamError}</div>
  {:else if teamProfile}
    <section class="team-card">
      <div class="team-card-number">{teamProfile.team_number}</div>
      <div class="team-card-body">
        <h2>{teamProfile.nickname || teamProfile.name}</h2>
        {#if teamProfile.nickname && teamProfile.name && teamProfile.nickname !== teamProfile.name}
          <div class="team-card-fullname">{teamProfile.name}</div>
        {/if}
        <div class="team-card-meta">
          {#if teamProfile.city || teamProfile.state_prov || teamProfile.country}
            <span><MapPin size={13} /> {[teamProfile.city, teamProfile.state_prov, teamProfile.country].filter(Boolean).join(', ')}</span>
          {/if}
          {#if teamProfile.rookie_year}<span>Rookie year {teamProfile.rookie_year}</span>{/if}
          {#if teamProfile.website}
            <a href={teamProfile.website} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Website</a>
          {/if}
        </div>
      </div>
      <div class="year-bar">
        <label for="tba-year-select">Season</label>
        <select id="tba-year-select" class="form-select" bind:value={selectedYear} on:change={loadEvents}>
          {#each years as year}<option value={year}>{year}</option>{/each}
          {#if !years.length}<option value={selectedYear}>{selectedYear}</option>{/if}
        </select>
        <button class="btn btn-outline btn-sm" on:click={loadEvents} disabled={eventsLoading} title="Refresh"><RefreshCw size={13} /></button>
      </div>
    </section>

    <div class="subtab-strip" role="tablist">
      <button class="subtab" class:active={activeSubtab === 'events'} on:click={() => selectSubtab('events')}><Calendar size={14} /> Events</button>
      <button class="subtab" class:active={activeSubtab === 'matches'} on:click={() => selectSubtab('matches')}><ListOrdered size={14} /> Match Schedule</button>
    </div>

    {#if activeSubtab === 'events'}
      {#if eventsLoading}
        <div class="empty-state">Loading events...</div>
      {:else if eventsError}
        <div class="notice notice-error">{eventsError}</div>
      {:else if !events.length}
        <div class="empty-state">No events found for team {teamProfile.team_number} in {selectedYear}.</div>
      {:else}
        <div class="event-list">
          {#each events as event (event.key)}
            {@const detail = eventDetail[event.key]}
            <article class="event-card">
              <button class="event-card-summary" on:click={() => toggleEvent(event.key)}>
                {#if expandedEventKey === event.key}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}
                <div class="event-card-title">
                  <strong>{event.name}</strong>
                  <span class="event-card-meta">
                    <Calendar size={12} /> {event.start_date} – {event.end_date}
                    {#if event.city || event.state_prov}· <MapPin size={12} /> {[event.city, event.state_prov].filter(Boolean).join(', ')}{/if}
                    {#if event.week != null}· Week {event.week + 1}{/if}
                  </span>
                </div>
              </button>

              {#if expandedEventKey === event.key}
                <div class="event-detail">
                  {#if detail?.loading}
                    <p class="tba-muted">Loading event...</p>
                  {:else}
                    {#if detail?.error}<p class="notice notice-error">{detail.error}</p>{/if}

                    {#if detail?.status?.qual}
                      <div class="status-strip">
                        <span><strong>Rank {detail.status.qual.ranking?.rank ?? '—'}</strong> of {detail.status.qual.num_teams ?? '—'}</span>
                        <span>{detail.status.qual.ranking?.record?.wins ?? 0}-{detail.status.qual.ranking?.record?.losses ?? 0}-{detail.status.qual.ranking?.record?.ties ?? 0}</span>
                        {#if detail.status.alliance}<span>Alliance {detail.status.alliance.number} {detail.status.alliance.pick === 0 ? '(Captain)' : `(Pick ${detail.status.alliance.pick})`}</span>{/if}
                        {#if detail.status.playoff?.status}<span class="status-playoff">{detail.status.playoff.status}</span>{/if}
                        <button class="btn btn-outline btn-sm tiny" on:click={refreshExpanded}><RefreshCw size={11} /></button>
                      </div>
                    {/if}

                    {#if detail?.info?.webcasts?.length}
                      <div class="webcasts">Webcasts: {#each detail.info.webcasts as cast, i}{#if i > 0}, {/if}<a href={cast.channel?.startsWith('http') ? cast.channel : `https://twitch.tv/${cast.channel}`} target="_blank" rel="noreferrer">{cast.channel}</a>{/each}</div>
                    {/if}

                    <div class="event-subtab-strip">
                      <button class="event-subtab" class:active={eventSubtab[event.key] === 'rankings'} on:click={() => eventSubtab = {...eventSubtab, [event.key]: 'rankings'}}><Trophy size={13} /> Rankings</button>
                      <button class="event-subtab" class:active={eventSubtab[event.key] === 'alliances'} on:click={() => eventSubtab = {...eventSubtab, [event.key]: 'alliances'}}><Users size={13} /> Alliances</button>
                      <button class="event-subtab" class:active={eventSubtab[event.key] === 'awards'} on:click={() => eventSubtab = {...eventSubtab, [event.key]: 'awards'}}><Award size={13} /> Awards</button>
                      <button class="event-subtab" class:active={eventSubtab[event.key] === 'matches'} on:click={() => eventSubtab = {...eventSubtab, [event.key]: 'matches'}}><ListOrdered size={13} /> Matches</button>
                    </div>

                    {#if eventSubtab[event.key] === 'rankings'}
                      {#if detail?.rankings?.length}
                        <div class="tba-table-wrap">
                          <table class="tba-table">
                            <thead><tr><th>Rank</th><th>Team</th><th>Record (W-L-T)</th><th>{detail.sortOrderInfo?.[0]?.name || 'Ranking Score'}</th><th>Played</th></tr></thead>
                            <tbody>
                              {#each detail.rankings as row}
                                <tr class:us={row.team_key === activeTeamKey}>
                                  <td>{row.rank}</td>
                                  <td>#{teamNumber(row.team_key)}</td>
                                  <td>{row.record?.wins ?? 0}-{row.record?.losses ?? 0}-{row.record?.ties ?? 0}</td>
                                  <td>{row.sort_orders?.[0] != null ? Number(row.sort_orders[0]).toFixed(2) : '—'}</td>
                                  <td>{row.matches_played ?? '—'}</td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {:else}
                        <p class="tba-muted">No rankings published yet.</p>
                      {/if}
                    {:else if eventSubtab[event.key] === 'alliances'}
                      {#if detail?.alliances?.length}
                        <div class="alliance-grid">
                          {#each detail.alliances as alliance, index}
                            <div class="alliance-card">
                              <div class="alliance-name">{alliance.name || `Alliance ${index + 1}`}</div>
                              <div class="alliance-picks">
                                {#each alliance.picks || [] as pick, pickIndex}
                                  <span class="alliance-pick" class:us={pick === activeTeamKey} class:captain={pickIndex === 0}>#{teamNumber(pick)}</span>
                                {/each}
                              </div>
                              {#if alliance.status?.status}<div class="alliance-status">{alliance.status.status}</div>{/if}
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <p class="tba-muted">No alliance selection published yet.</p>
                      {/if}
                    {:else if eventSubtab[event.key] === 'awards'}
                      {#if detail?.awards?.length}
                        <ul class="award-list">
                          {#each detail.awards as award}
                            <li>
                              <strong>{award.name}</strong>
                              {#each award.recipient_list || [] as recipient}
                                <span class="award-recipient" class:us={recipient.team_key === activeTeamKey}>
                                  {recipient.team_key ? `#${teamNumber(recipient.team_key)}` : ''}{recipient.awardee ? ` ${recipient.awardee}` : ''}
                                </span>
                              {/each}
                            </li>
                          {/each}
                        </ul>
                      {:else}
                        <p class="tba-muted">No awards given yet.</p>
                      {/if}
                    {:else if eventSubtab[event.key] === 'matches'}
                      {#if Object.keys(detail?.matchesByLevel || {}).length}
                        {#each COMP_LEVEL_ORDER as level}
                          {#if detail.matchesByLevel[level]?.length}
                            <div class="match-level-group">
                              <div class="match-level-heading">{COMP_LEVEL_LABEL[level]}</div>
                              {#each detail.matchesByLevel[level] as match}
                                {@const redWin = (match.alliances?.red?.score ?? -1) > (match.alliances?.blue?.score ?? -1) && match.alliances?.red?.score >= 0}
                                {@const blueWin = (match.alliances?.blue?.score ?? -1) > (match.alliances?.red?.score ?? -1) && match.alliances?.blue?.score >= 0}
                                <div class="match-row">
                                  <div class="match-row-label"><span class="match-row-name">{matchLabel(match)}</span></div>
                                  <div class="match-alliance red" class:winner={redWin}>
                                    <span class="match-teams">
                                      {#each match.alliances?.red?.team_keys || [] as teamKey}
                                        <span class="match-team" class:us={teamKey === activeTeamKey}>{teamNumber(teamKey)}</span>
                                      {/each}
                                    </span>
                                    <strong class="match-score">{match.alliances?.red?.score ?? match.score_breakdown?.red?.total_points ?? '—'}</strong>
                                  </div>
                                  <div class="match-alliance blue" class:winner={blueWin}>
                                    <span class="match-teams">
                                      {#each match.alliances?.blue?.team_keys || [] as teamKey}
                                        <span class="match-team" class:us={teamKey === activeTeamKey}>{teamNumber(teamKey)}</span>
                                      {/each}
                                    </span>
                                    <strong class="match-score">{match.alliances?.blue?.score ?? match.score_breakdown?.blue?.total_points ?? '—'}</strong>
                                  </div>
                                </div>
                              {/each}
                            </div>
                          {/if}
                        {/each}
                      {:else}
                        <p class="tba-muted">No match schedule published yet.</p>
                      {/if}
                    {/if}
                  {/if}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    {:else}
      <!-- Match Schedule subtab: every match this team plays in the
           selected season, across every event, flattened into one
           chronological list - no expanding events one at a time. -->
      {#if seasonMatchesLoading}
        <div class="empty-state">Loading the {selectedYear} match schedule...</div>
      {:else if seasonMatchesError}
        <div class="notice notice-error">{seasonMatchesError}</div>
      {:else if !seasonMatches.length}
        <div class="empty-state">No matches found for team {teamProfile.team_number} in {selectedYear}.</div>
      {:else}
        <div class="season-schedule">
          {#each seasonMatchGroups as group (group.eventKey)}
            <section class="season-event">
              <header class="season-event-header">
                <h3>{group.eventName}</h3>
                {#if group.startDate}<span class="season-event-date">{group.startDate}</span>{/if}
              </header>
              {#each group.levels as levelGroup (levelGroup.level)}
                <div class="match-level-group">
                  <div class="match-level-heading">{levelGroup.label}</div>
                  {#each levelGroup.matches as match (match.key)}
                    {@const redScore = match.alliances?.red?.score ?? -1}
                    {@const blueScore = match.alliances?.blue?.score ?? -1}
                    {@const played = redScore >= 0 && blueScore >= 0}
                    <div class="match-row season">
                      <div class="match-row-label">
                        <span class="match-row-name">{matchLabel(match)}</span>
                        {#if matchTime(match)}<span class="match-row-time">{matchTime(match)}</span>{/if}
                      </div>
                      <div class="match-alliance red" class:winner={played && redScore > blueScore}>
                        <span class="match-teams">
                          {#each match.alliances?.red?.team_keys || [] as teamKey}
                            <span class="match-team" class:us={teamKey === activeTeamKey}>{teamNumber(teamKey)}</span>
                          {/each}
                        </span>
                        <strong class="match-score">{played ? redScore : '—'}</strong>
                      </div>
                      <div class="match-alliance blue" class:winner={played && blueScore > redScore}>
                        <span class="match-teams">
                          {#each match.alliances?.blue?.team_keys || [] as teamKey}
                            <span class="match-team" class:us={teamKey === activeTeamKey}>{teamNumber(teamKey)}</span>
                          {/each}
                        </span>
                        <strong class="match-score">{played ? blueScore : '—'}</strong>
                      </div>
                    </div>
                  {/each}
                </div>
              {/each}
            </section>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  /* This app's own design language now (sharp corners, gold accents),
     not a TBA-blue replica. */
  .tba-page {
    --home-radius: 0;
    max-width: 1100px;
    margin: var(--space-6) auto;
    padding: 0 var(--space-4);
  }

  .tba-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }

  .tba-header h1 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }

  .tba-header p {
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
  }

  .team-search {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }

  .team-search label {
    display: block;
    font-size: var(--font-xs);
    color: var(--text-muted);
    margin-bottom: 2px;
  }

  .team-search .form-input {
    width: 7rem;
  }

  .tba-muted { color: var(--text-muted); font-size: 0.88rem; }

  .team-card {
    display: flex;
    gap: var(--space-4);
    align-items: center;
    flex-wrap: wrap;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--brand-gold-strong);
    padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-4);
  }

  .team-card-number { font-size: 2rem; font-weight: 800; color: var(--brand-gold-strong); min-width: 4.5rem; }
  .team-card-body { flex: 1; min-width: 12rem; }
  .team-card-body h2 { margin: 0; font-size: var(--font-lg); color: var(--secondary); }
  .team-card-fullname { color: var(--text-muted); font-size: 0.82rem; }
  .team-card-meta { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-2); font-size: 0.8rem; color: var(--text-secondary); }
  .team-card-meta span, .team-card-meta a { display: inline-flex; align-items: center; gap: 0.3rem; }
  .team-card-meta a { color: var(--accent-strong); text-decoration: none; }

  .year-bar { display: flex; align-items: center; gap: var(--space-2); font-size: 0.82rem; flex: none; }
  .year-bar label { color: var(--text-muted); }

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

  .event-list { display: grid; gap: var(--space-3); }
  .event-card { background: var(--surface-1); border: 1px solid var(--border); }
  .event-card-summary { width: 100%; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border: 0; background: none; text-align: left; cursor: pointer; color: inherit; }
  .event-card-title { display: grid; gap: 2px; }
  .event-card-meta { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; color: var(--text-muted); font-size: 0.76rem; }

  .event-detail { border-top: 1px solid var(--border); padding: var(--space-4); display: grid; gap: var(--space-3); }
  .status-strip { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: center; background: var(--accent-subtle); padding: var(--space-2) var(--space-3); font-size: 0.82rem; font-weight: 600; color: var(--secondary); }
  .status-playoff { text-transform: capitalize; }
  .webcasts { font-size: 0.78rem; color: var(--text-secondary); }
  .webcasts a { color: var(--accent-strong); }

  .event-subtab-strip { display: flex; gap: var(--space-2); flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: var(--space-2); }
  .event-subtab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border: 1px solid transparent;
    background: none;
    color: var(--text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .event-subtab:hover { background: var(--surface-2); }
  .event-subtab.active { border-color: var(--border); background: var(--surface-2); color: var(--secondary); font-weight: 600; }

  .tba-table-wrap { overflow-x: auto; }
  .tba-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .tba-table th, .tba-table td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); text-align: left; }
  .tba-table th { color: var(--text-muted); font-weight: 700; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.03em; }
  .tba-table tr.us { background: var(--brand-gold-soft); font-weight: 700; }

  .alliance-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: var(--space-2); }
  .alliance-card { border: 1px solid var(--border); padding: var(--space-2) var(--space-3); }
  .alliance-name { font-size: 0.72rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; }
  .alliance-picks { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1); }
  .alliance-pick { padding: 2px 6px; background: var(--accent-subtle); font-size: 0.76rem; font-weight: 600; }
  .alliance-pick.captain { background: var(--brand-gold-strong); color: var(--primary); }
  .alliance-pick.us { outline: 2px solid var(--brand-gold-strong); }
  .alliance-status { margin-top: var(--space-1); font-size: 0.72rem; color: var(--text-muted); }

  .award-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); font-size: 0.82rem; }
  .award-recipient { margin-left: var(--space-2); color: var(--text-secondary); }
  .award-recipient.us { color: var(--secondary); font-weight: 700; }

  .season-schedule { display: grid; gap: var(--space-5); }
  .season-event-header {
    display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);
    border-bottom: 1px solid var(--border); padding-bottom: var(--space-2); margin-bottom: var(--space-2);
  }
  .season-event-header h3 { margin: 0; font-size: 1rem; }
  .season-event-date { color: var(--text-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; }

  .match-level-group { display: grid; gap: 2px; }
  .match-level-heading { font-size: 0.72rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-top: var(--space-3); margin-bottom: var(--space-1); }
  .match-row { display: grid; grid-template-columns: 6.5rem 1fr 1fr; gap: var(--space-2); align-items: stretch; font-size: 0.8rem; }
  /* The season view no longer repeats the event name per row (it has its
     own heading now), so the label column only holds "Qual 12" and a time
     and can be tight instead of 9rem of wrapped text. */
  .match-row.season { grid-template-columns: 8rem 1fr 1fr; }
  .match-row-label {
    display: flex; align-items: baseline; gap: var(--space-2);
    color: var(--text-secondary); font-size: 0.76rem; padding: var(--space-1) 0;
  }
  .match-row-name { font-weight: 600; white-space: nowrap; }
  .match-row-time { color: var(--text-muted); font-size: 0.7rem; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .match-alliance {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    /* An inset ring, not `outline` - outline draws OUTSIDE the box, so the
       winning alliance used to bulge 2px past its row while the loser sat
       flush, which is what made the whole column look jagged. This keeps
       every cell the exact same footprint whether it won or not. */
    box-shadow: inset 0 0 0 1px transparent;
  }
  .match-alliance.red { background: var(--red-soft); }
  .match-alliance.blue { background: var(--blue-soft, #e8f1ff); }
  .match-alliance.red.winner { box-shadow: inset 0 0 0 2px var(--red-strong); }
  .match-alliance.blue.winner { box-shadow: inset 0 0 0 2px var(--blue-strong, #174ea6); }
  .match-alliance.winner .match-score { font-weight: 800; }

  /* Fixed-width team slots so the numbers line up as columns down the page
     instead of drifting with digit count (#27 vs #11297). */
  .match-teams { display: flex; gap: var(--space-2); flex: 1; min-width: 0; }
  .match-team {
    min-width: 3.1rem; font-weight: 600; font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
  .match-team.us { color: var(--text); font-weight: 800; text-decoration: underline; }
  .match-score { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 0.86rem; }

  .notice { border: 1px solid var(--border); padding: var(--space-4); }
  .notice-error { border-color: var(--danger, #dc3545); color: var(--danger, #dc3545); }

  @media (max-width: 640px) {
    .match-row, .match-row.season { grid-template-columns: 1fr; }
    .team-card { flex-direction: column; align-items: flex-start; }
    .year-bar { width: 100%; }
    .year-bar .form-select { flex: 1; }
  }
</style>
