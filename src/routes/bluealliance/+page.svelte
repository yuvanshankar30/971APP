<script>
  import { onMount } from 'svelte';
  import { Radar, ExternalLink, MapPin, Calendar, Trophy, Users, Award, ChevronDown, ChevronRight, RefreshCw } from 'lucide-svelte';

  // A draft replica of thebluealliance.com's own front end (team page ->
  // year picker -> event list -> event detail: rankings/alliances/awards/
  // matches), scoped to the two teams 971 cares about rather than a
  // universal "look up any team" browser. Deliberately styled apart from
  // the rest of Spartans Hub (TBA's own blue, not this app's gold) since
  // the point of a first draft is to look like the source it's replicating,
  // not to blend in yet - see the PR description for what's still rough.
  //
  // Every fetch below hits a NEW, distinctly-named /api/tba/* route
  // (team-profile, team-years, team-events, event-info, event-rankings,
  // event-alliances, event-awards, team-event-status) added alongside the
  // existing ones (event-matches, event-teams, event-oprs, team-matches,
  // team-media, teams-simple) used elsewhere in the app (Strategy, Power
  // Rankings, Picklist, Drive Team). Matches themselves reuse the existing
  // /api/tba/event-matches endpoint rather than a new one, since that
  // resource was already covered - nothing here duplicates or shadows an
  // existing route or collides with another page's in-flight TBA calls.

  const FEATURED_TEAMS = [
    { key: 'frc971', number: 971 },
    { key: 'frc9584', number: 9584 }
  ];

  const COMP_LEVEL_LABEL = { qm: 'Qualification', ef: 'Eighthfinal', qf: 'Quarterfinal', sf: 'Semifinal', f: 'Final' };
  const COMP_LEVEL_ORDER = ['qm', 'ef', 'qf', 'sf', 'f'];

  let activeTeamKey = FEATURED_TEAMS[0].key;
  let teamProfile = null;
  let teamLoading = false;
  let teamError = '';

  let years = [];
  let selectedYear = new Date().getFullYear();

  let events = [];
  let eventsLoading = false;
  let eventsError = '';

  let expandedEventKey = '';
  let eventDetail = {}; // event_key -> { loading, error, info, matches, rankings, allianceRows, awards, status }

  const teamNumber = (key) => Number(String(key || '').replace(/^frc/i, ''));
  const isFeatured = (key) => key === activeTeamKey;

  function matchLabel(match) {
    const level = String(match?.comp_level || '').toLowerCase();
    if (level === 'qm') return `Qual ${match.match_number}`;
    if (level === 'f') return `Final ${match.match_number}`;
    const name = COMP_LEVEL_LABEL[level] || level.toUpperCase();
    return `${name} ${match?.set_number ?? '?'} Match ${match?.match_number}`;
  }

  async function fetchJson(url) {
    try {
      const response = await fetch(url);
      const payload = await response.json();
      return payload?.success ? payload.data : null;
    } catch {
      return null;
    }
  }

  async function loadTeam(teamKey) {
    activeTeamKey = teamKey;
    expandedEventKey = '';
    eventDetail = {};
    teamLoading = true;
    teamError = '';
    events = [];

    const [profile, yearList] = await Promise.all([
      fetchJson(`/api/tba/team-profile?team_key=${encodeURIComponent(teamKey)}`),
      fetchJson(`/api/tba/team-years?team_key=${encodeURIComponent(teamKey)}`)
    ]);
    teamProfile = profile;
    if (!profile) teamError = 'Could not load this team from The Blue Alliance.';
    years = yearList || [];
    const currentYear = new Date().getFullYear();
    selectedYear = years.includes(currentYear) ? currentYear : (years[0] || currentYear);
    teamLoading = false;
    await loadEvents();
  }

  async function loadEvents() {
    eventsLoading = true;
    eventsError = '';
    expandedEventKey = '';
    const data = await fetchJson(
      `/api/tba/team-events?team_key=${encodeURIComponent(activeTeamKey)}&year=${encodeURIComponent(selectedYear)}`
    );
    if (data == null) eventsError = 'Could not load events for that season.';
    events = data || [];
    eventsLoading = false;
  }

  async function toggleEvent(eventKey) {
    if (expandedEventKey === eventKey) {
      expandedEventKey = '';
      return;
    }
    expandedEventKey = eventKey;
    if (!eventDetail[eventKey]) await loadEventDetail(eventKey);
  }

  async function loadEventDetail(eventKey) {
    eventDetail = { ...eventDetail, [eventKey]: { loading: true, error: '' } };
    const [info, matches, rankingsPayload, allianceRows, awards, status] = await Promise.all([
      fetchJson(`/api/tba/event-info?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`),
      fetchJson(`/api/tba/event-rankings?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/event-alliances?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/event-awards?event_key=${encodeURIComponent(eventKey)}`),
      fetchJson(`/api/tba/team-event-status?team_key=${encodeURIComponent(activeTeamKey)}&event_key=${encodeURIComponent(eventKey)}`)
    ]);

    const matchesByLevel = {};
    for (const match of matches || []) {
      const level = String(match?.comp_level || '').toLowerCase();
      if (!matchesByLevel[level]) matchesByLevel[level] = [];
      matchesByLevel[level].push(match);
    }

    eventDetail = {
      ...eventDetail,
      [eventKey]: {
        loading: false,
        error: matches == null ? 'Could not load this event fully.' : '',
        info,
        matchesByLevel,
        rankings: rankingsPayload?.rankings || [],
        sortOrderInfo: rankingsPayload?.sort_order_info || [],
        alliances: allianceRows || [],
        awards: awards || [],
        status
      }
    };
  }

  function refreshExpanded() {
    if (expandedEventKey) loadEventDetail(expandedEventKey);
  }

  onMount(() => {
    loadTeam(activeTeamKey);
  });
</script>

<svelte:head><title>Blue Alliance</title></svelte:head>

<div class="tba-page">
  <header class="tba-topbar">
    <div class="tba-topbar-inner">
      <div class="tba-brand"><Radar size={20} /> <span>Blue Alliance</span><small>draft - powered by the TBA API</small></div>
      <div class="team-switcher" role="tablist" aria-label="Featured team">
        {#each FEATURED_TEAMS as team}
          <button
            class="team-switch-btn"
            class:active={team.key === activeTeamKey}
            on:click={() => loadTeam(team.key)}
          >#{team.number}</button>
        {/each}
      </div>
    </div>
  </header>

  <main class="tba-content">
    {#if teamLoading}
      <p class="tba-muted">Loading team...</p>
    {:else if teamError}
      <p class="tba-error">{teamError}</p>
    {:else if teamProfile}
      <section class="team-header">
        <div class="team-header-number">{teamProfile.team_number}</div>
        <div class="team-header-body">
          <h1>{teamProfile.nickname || teamProfile.name}</h1>
          {#if teamProfile.nickname && teamProfile.name && teamProfile.nickname !== teamProfile.name}
            <div class="team-header-fullname">{teamProfile.name}</div>
          {/if}
          <div class="team-header-meta">
            {#if teamProfile.city || teamProfile.state_prov || teamProfile.country}
              <span><MapPin size={13} /> {[teamProfile.city, teamProfile.state_prov, teamProfile.country].filter(Boolean).join(', ')}</span>
            {/if}
            {#if teamProfile.rookie_year}<span>Rookie year {teamProfile.rookie_year}</span>{/if}
            {#if teamProfile.website}
              <a href={teamProfile.website} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Website</a>
            {/if}
          </div>
        </div>
      </section>

      <section class="year-bar">
        <label for="tba-year-select">Season</label>
        <select id="tba-year-select" bind:value={selectedYear} on:change={loadEvents}>
          {#each years as year}<option value={year}>{year}</option>{/each}
          {#if !years.length}<option value={selectedYear}>{selectedYear}</option>{/if}
        </select>
        <button class="tba-btn-outline" on:click={loadEvents} disabled={eventsLoading}><RefreshCw size={13} /> Refresh</button>
      </section>

      {#if eventsLoading}
        <p class="tba-muted">Loading events...</p>
      {:else if eventsError}
        <p class="tba-error">{eventsError}</p>
      {:else if !events.length}
        <p class="tba-muted">No events found for team {teamProfile.team_number} in {selectedYear}.</p>
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
                    {#if detail?.error}<p class="tba-error">{detail.error}</p>{/if}

                    {#if detail?.status?.qual}
                      <div class="status-strip">
                        <span><strong>Rank {detail.status.qual.ranking?.rank ?? '—'}</strong> of {detail.status.qual.num_teams ?? '—'}</span>
                        <span>{detail.status.qual.ranking?.record?.wins ?? 0}-{detail.status.qual.ranking?.record?.losses ?? 0}-{detail.status.qual.ranking?.record?.ties ?? 0}</span>
                        {#if detail.status.alliance}<span>Alliance {detail.status.alliance.number} {detail.status.alliance.pick === 0 ? '(Captain)' : `(Pick ${detail.status.alliance.pick})`}</span>{/if}
                        {#if detail.status.playoff?.status}<span class="status-playoff">{detail.status.playoff.status}</span>{/if}
                        <button class="tba-btn-outline tiny" on:click={refreshExpanded}><RefreshCw size={11} /></button>
                      </div>
                    {/if}

                    {#if detail?.info?.webcasts?.length}
                      <div class="webcasts">Webcasts: {#each detail.info.webcasts as cast, i}{#if i > 0}, {/if}<a href={cast.channel?.startsWith('http') ? cast.channel : `https://twitch.tv/${cast.channel}`} target="_blank" rel="noreferrer">{cast.channel}</a>{/each}</div>
                    {/if}

                    {#if detail?.rankings?.length}
                      <h3 class="section-title"><Trophy size={14} /> Rankings</h3>
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
                    {/if}

                    {#if detail?.alliances?.length}
                      <h3 class="section-title"><Users size={14} /> Alliance Selection</h3>
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
                    {/if}

                    {#if detail?.awards?.length}
                      <h3 class="section-title"><Award size={14} /> Awards</h3>
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
                    {/if}

                    {#if detail?.matchesByLevel}
                      <h3 class="section-title">Matches</h3>
                      {#each COMP_LEVEL_ORDER as level}
                        {#if detail.matchesByLevel[level]?.length}
                          <div class="match-level-group">
                            <div class="match-level-heading">{COMP_LEVEL_LABEL[level]}</div>
                            {#each detail.matchesByLevel[level] as match}
                              {@const redWin = (match.alliances?.red?.score ?? -1) > (match.alliances?.blue?.score ?? -1) && match.alliances?.red?.score >= 0}
                              {@const blueWin = (match.alliances?.blue?.score ?? -1) > (match.alliances?.red?.score ?? -1) && match.alliances?.blue?.score >= 0}
                              <div class="match-row">
                                <div class="match-row-label">{matchLabel(match)}</div>
                                <div class="match-alliance red" class:winner={redWin}>
                                  {#each match.alliances?.red?.team_keys || [] as teamKey}
                                    <span class="match-team" class:us={teamKey === activeTeamKey}>#{teamNumber(teamKey)}</span>
                                  {/each}
                                  <strong class="match-score">{match.alliances?.red?.score ?? match.score_breakdown?.red?.total_points ?? '—'}</strong>
                                </div>
                                <div class="match-alliance blue" class:winner={blueWin}>
                                  {#each match.alliances?.blue?.team_keys || [] as teamKey}
                                    <span class="match-team" class:us={teamKey === activeTeamKey}>#{teamNumber(teamKey)}</span>
                                  {/each}
                                  <strong class="match-score">{match.alliances?.blue?.score ?? match.score_breakdown?.blue?.total_points ?? '—'}</strong>
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/if}
                      {/each}
                    {:else if !detail?.loading}
                      <p class="tba-muted">No match schedule published yet.</p>
                    {/if}
                  {/if}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    {/if}
  </main>
</div>

<style>
  /* Deliberately its own visual language (TBA's blue, white cards, dense
     tables) rather than this app's gold/cream design system - a draft of
     the site being replicated, not a Spartans Hub-flavored reskin yet. */
  .tba-page { --tba-blue: #1a5c96; --tba-blue-dark: #0d3f6b; --tba-border: #dde3ea; --tba-bg: #f4f6f8; background: var(--tba-bg); margin: calc(var(--space-4, 1rem) * -1); padding-bottom: 3rem; min-height: 100%; }
  .tba-topbar { background: var(--tba-blue); color: #fff; padding: 0.9rem 1.25rem; }
  .tba-topbar-inner { max-width: 1100px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; }
  .tba-brand { display: flex; align-items: center; gap: 0.5rem; font-size: 1.15rem; font-weight: 700; }
  .tba-brand small { font-weight: 400; font-size: 0.72rem; opacity: 0.75; margin-left: 0.35rem; }
  .team-switcher { display: flex; gap: 0.4rem; }
  .team-switch-btn { padding: 0.4rem 0.9rem; border-radius: 999px; border: 1px solid rgba(255,255,255,0.5); background: transparent; color: #fff; font-weight: 700; cursor: pointer; }
  .team-switch-btn.active { background: #fff; color: var(--tba-blue); }
  .tba-content { max-width: 1100px; margin: 0 auto; padding: 1.25rem; }
  .tba-muted { color: #64748b; font-size: 0.88rem; }
  .tba-error { color: #b91c1c; font-size: 0.88rem; }

  .team-header { display: flex; gap: 1rem; align-items: center; background: #fff; border: 1px solid var(--tba-border); border-radius: 10px; padding: 1.1rem 1.3rem; margin-bottom: 1rem; }
  .team-header-number { font-size: 2.2rem; font-weight: 800; color: var(--tba-blue); min-width: 5rem; }
  .team-header-body h1 { margin: 0; font-size: 1.35rem; }
  .team-header-fullname { color: #64748b; font-size: 0.82rem; }
  .team-header-meta { display: flex; flex-wrap: wrap; gap: 0.9rem; margin-top: 0.4rem; font-size: 0.8rem; color: #475569; }
  .team-header-meta span, .team-header-meta a { display: inline-flex; align-items: center; gap: 0.3rem; }
  .team-header-meta a { color: var(--tba-blue); text-decoration: none; }

  .year-bar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1rem; font-size: 0.85rem; }
  .year-bar select { padding: 0.35rem 0.6rem; border-radius: 6px; border: 1px solid var(--tba-border); }
  .tba-btn-outline { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.35rem 0.7rem; border-radius: 6px; border: 1px solid var(--tba-blue); background: #fff; color: var(--tba-blue); font-size: 0.8rem; cursor: pointer; }
  .tba-btn-outline.tiny { padding: 0.15rem 0.4rem; margin-left: auto; }

  .event-list { display: grid; gap: 0.6rem; }
  .event-card { background: #fff; border: 1px solid var(--tba-border); border-radius: 10px; overflow: hidden; }
  .event-card-summary { width: 100%; display: flex; align-items: center; gap: 0.6rem; padding: 0.75rem 1rem; border: 0; background: none; text-align: left; cursor: pointer; color: inherit; }
  .event-card-title { display: grid; gap: 0.15rem; }
  .event-card-meta { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; color: #64748b; font-size: 0.76rem; }

  .event-detail { border-top: 1px solid var(--tba-border); padding: 0.9rem 1rem 1.1rem; display: grid; gap: 0.9rem; }
  .status-strip { display: flex; flex-wrap: wrap; gap: 0.9rem; align-items: center; background: #eef4fa; border-radius: 8px; padding: 0.5rem 0.8rem; font-size: 0.82rem; font-weight: 600; color: var(--tba-blue-dark); }
  .status-playoff { text-transform: capitalize; }
  .webcasts { font-size: 0.78rem; color: #475569; }
  .webcasts a { color: var(--tba-blue); }

  .section-title { display: flex; align-items: center; gap: 0.4rem; margin: 0; font-size: 0.9rem; color: var(--tba-blue-dark); }

  .tba-table-wrap { overflow-x: auto; }
  .tba-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .tba-table th, .tba-table td { padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--tba-border); text-align: left; }
  .tba-table th { color: #64748b; font-weight: 700; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.03em; }
  .tba-table tr.us { background: #fff7e0; font-weight: 700; }

  .alliance-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: 0.5rem; }
  .alliance-card { border: 1px solid var(--tba-border); border-radius: 8px; padding: 0.5rem 0.6rem; }
  .alliance-name { font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase; }
  .alliance-picks { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.25rem; }
  .alliance-pick { padding: 0.1rem 0.4rem; border-radius: 4px; background: #eef4fa; font-size: 0.76rem; font-weight: 600; }
  .alliance-pick.captain { background: var(--tba-blue); color: #fff; }
  .alliance-pick.us { outline: 2px solid #f1c331; }
  .alliance-status { margin-top: 0.3rem; font-size: 0.72rem; color: #64748b; }

  .award-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; font-size: 0.82rem; }
  .award-recipient { margin-left: 0.4rem; color: #475569; }
  .award-recipient.us { color: var(--tba-blue-dark); font-weight: 700; }

  .match-level-group { display: grid; gap: 0.3rem; }
  .match-level-heading { font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.03em; margin-top: 0.4rem; }
  .match-row { display: grid; grid-template-columns: 6.5rem 1fr 1fr; gap: 0.4rem; align-items: center; font-size: 0.8rem; }
  .match-row-label { color: #64748b; font-size: 0.76rem; }
  .match-alliance { display: flex; align-items: center; gap: 0.3rem; padding: 0.3rem 0.5rem; border-radius: 6px; }
  .match-alliance.red { background: #fdecec; }
  .match-alliance.blue { background: #e8f0fb; }
  .match-alliance.winner { outline: 2px solid currentColor; }
  .match-alliance.red.winner { color: #b91c1c; }
  .match-alliance.blue.winner { color: var(--tba-blue-dark); }
  .match-team { font-weight: 600; }
  .match-team.us { text-decoration: underline; }
  .match-score { margin-left: auto; font-variant-numeric: tabular-nums; }

  @media (max-width: 640px) {
    .match-row { grid-template-columns: 1fr; }
    .team-header { flex-direction: column; align-items: flex-start; }
  }
</style>
