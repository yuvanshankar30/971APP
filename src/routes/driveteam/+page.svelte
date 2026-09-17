<script>
  import { onMount, onDestroy } from 'svelte';
  import { Clock, RefreshCw, Signal, Zap } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { FRC_TEAMS } from '$lib/permissions.js';
  import { isMatchPlayed, matchLabel } from '$lib/matchProjection.js';

  // Built from Slack feedback (Andre Fong, drive team): "like next matches
  // and our like downtimes and how long they are ... like i only know
  // matches that we're in queue for, id rather know sooner." This page is
  // meant to sit open on a phone at the drive station: the very next match,
  // how long until it, how many matches away it is (so queue position is
  // known well before an official call to queue), and how long a gap
  // ("downtime") follows each of our matches so the team can plan charging/
  // resets instead of just waiting.
  const OUR_TEAM_KEY = `frc${FRC_TEAMS.TEAM_971}`;

  let eventKey = '';
  let matches = [];
  let loading = true;
  let error = '';
  let lastLoadedAt = null;
  let now = Date.now();

  let pollTimer = null;
  let tickTimer = null;

  const teamNumber = (teamKey) => String(teamKey || '').replace(/^frc/i, '');
  const matchHasUs = (match) =>
    (match?.alliances?.red?.team_keys || []).includes(OUR_TEAM_KEY) ||
    (match?.alliances?.blue?.team_keys || []).includes(OUR_TEAM_KEY);
  const allianceForUs = (match) => (match?.alliances?.red?.team_keys || []).includes(OUR_TEAM_KEY) ? 'red' : 'blue';

  // TBA gives epoch seconds. predicted_time is the live estimate (it moves
  // as the event actually runs ahead of or behind the printed schedule);
  // time is the original static schedule slot - prefer predicted, fall back
  // to the static time so a match still shows something before predictions
  // exist (e.g. very early in a day).
  function matchTimeMs(match) {
    const epoch = Number.isFinite(match?.predicted_time) ? match.predicted_time : match?.time;
    return Number.isFinite(epoch) ? epoch * 1000 : null;
  }
  function matchEndMs(match) {
    if (Number.isFinite(match?.actual_time)) return match.actual_time * 1000;
    const start = matchTimeMs(match);
    // A match itself runs ~5-6 minutes wall clock (queue to field-clear);
    // used only as a rough estimate when a match hasn't actually completed
    // yet but still needs some "end" point to measure downtime from.
    return Number.isFinite(start) ? start + 6 * 60 * 1000 : null;
  }

  function formatClock(ms) {
    if (!Number.isFinite(ms)) return 'Time TBD';
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return null;
    const clamped = Math.max(0, ms);
    const totalMinutes = Math.round(clamped / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  // A clearly-labeled synthetic match (comp_level 'test', same convention
  // Strategy's Matches subtab uses for its practice prediction market) with
  // a real predicted_time a few minutes out, so the countdown/queue-position/
  // downtime math has something to render against - including in production,
  // before a real event's schedule exists yet.
  function buildDriveTeamTestMatch() {
    const now = Math.floor(Date.now() / 1000);
    const startsIn = 5 * 60;
    return {
      key: 'test_driveteam_1',
      comp_level: 'test',
      set_number: 1,
      match_number: 1,
      time: now + startsIn,
      predicted_time: now + startsIn,
      actual_time: null,
      alliances: {
        red: { team_keys: [OUR_TEAM_KEY, 'frc254', 'frc118'], score: -1 },
        blue: { team_keys: ['frc1114', 'frc2056', 'frc330'], score: -1 }
      }
    };
  }

  async function loadMatches() {
    if (!eventKey) { loading = false; return; }
    try {
      const response = await fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not load the match schedule.');
      matches = [buildDriveTeamTestMatch(), ...(payload.data || [])];
      error = '';
      lastLoadedAt = Date.now();
    } catch (cause) {
      error = cause?.message || 'Could not load the match schedule.';
    } finally {
      loading = false;
    }
  }

  $: ourMatches = matches.filter(matchHasUs);
  $: ourUpcoming = ourMatches.filter((match) => !isMatchPlayed(match));
  $: ourPlayed = ourMatches.filter((match) => isMatchPlayed(match));
  $: lastPlayedOurs = ourPlayed[ourPlayed.length - 1] || null;

  // Overall (every team's) match order doubles as queue position: how many
  // matches are left to run before ours, counting from whichever match was
  // most recently played event-wide - not just our own matches.
  $: overallIndexByKey = new Map(matches.map((match, index) => [match.key, index]));
  $: lastPlayedOverallIndex = (() => {
    let idx = -1;
    matches.forEach((match, index) => { if (isMatchPlayed(match)) idx = index; });
    return idx;
  })();
  function matchesAway(match) {
    const idx = overallIndexByKey.get(match.key);
    if (idx == null) return null;
    return Math.max(0, idx - lastPlayedOverallIndex - 1);
  }

  $: upcomingWithMeta = ourUpcoming.map((match, index) => {
    const previous = index === 0 ? lastPlayedOurs : ourUpcoming[index - 1];
    const previousEndMs = previous ? matchEndMs(previous) : now;
    const startMs = matchTimeMs(match);
    const downtimeMs = Number.isFinite(startMs) && Number.isFinite(previousEndMs)
      ? Math.max(0, startMs - previousEndMs)
      : null;
    return {
      match,
      alliance: allianceForUs(match),
      startMs,
      countdownMs: Number.isFinite(startMs) ? startMs - now : null,
      downtimeMs,
      away: matchesAway(match)
    };
  });
  $: nextUp = upcomingWithMeta[0] || null;
  $: laterMatches = upcomingWithMeta.slice(1);
  $: secondsSinceLoad = lastLoadedAt ? Math.round((now - lastLoadedAt) / 1000) : null;

  onMount(async () => {
    eventKey = await fetchActiveScoutingEventKey();
    await loadMatches();
    // 20s poll - frequent enough to feel live without hammering a connection
    // that may be poor/cell-only at a real event.
    pollTimer = setInterval(loadMatches, 20000);
    tickTimer = setInterval(() => { now = Date.now(); }, 1000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
  });
</script>

<svelte:head><title>Drive Team</title></svelte:head>

<div class="dt-page">
  <div class="dt-header">
    <div>
      <span class="eyebrow">Team {FRC_TEAMS.TEAM_971}</span>
      <h1><Zap size={22} /> Drive Team</h1>
    </div>
    <button class="btn btn-outline btn-sm" on:click={loadMatches} disabled={loading}><RefreshCw size={16} /> Refresh</button>
  </div>

  {#if !eventKey}
    <div class="dt-empty">No active scouting event set.</div>
  {:else if loading && !matches.length}
    <div class="dt-empty">Loading match schedule...</div>
  {:else if error}
    <div class="dt-empty dt-error">{error}</div>
  {:else if !ourMatches.length}
    <div class="dt-empty">No matches found for Team {FRC_TEAMS.TEAM_971} at this event yet.</div>
  {:else}
    <div class="dt-freshness"><Signal size={13} /> {secondsSinceLoad == null ? 'Loading…' : `Updated ${secondsSinceLoad}s ago`}</div>

    {#if nextUp}
      <section class="dt-next" class:alliance-red={nextUp.alliance === 'red'} class:alliance-blue={nextUp.alliance === 'blue'}>
        <span class="dt-next-label">Next match</span>
        <h2>{matchLabel(nextUp.match)}</h2>
        <div class="dt-countdown">{formatDuration(nextUp.countdownMs) ?? 'Time TBD'}</div>
        <div class="dt-next-meta">
          <span><Clock size={14} /> {formatClock(nextUp.startMs)}</span>
          {#if nextUp.away != null}<span>{nextUp.away === 0 ? 'You are up next' : `${nextUp.away} match${nextUp.away === 1 ? '' : 'es'} away`}</span>{/if}
        </div>
        <div class="dt-roster">
          <div class="dt-alliance dt-alliance-red">{#each nextUp.match.alliances?.red?.team_keys || [] as teamKey}<span class:us={teamKey === OUR_TEAM_KEY}>{teamNumber(teamKey)}</span>{/each}</div>
          <div class="dt-vs">vs</div>
          <div class="dt-alliance dt-alliance-blue">{#each nextUp.match.alliances?.blue?.team_keys || [] as teamKey}<span class:us={teamKey === OUR_TEAM_KEY}>{teamNumber(teamKey)}</span>{/each}</div>
        </div>
      </section>
    {/if}

    {#if laterMatches.length}
      <section class="dt-upcoming">
        <h3>Then</h3>
        {#each laterMatches as item (item.match.key)}
          <div class="dt-row">
            <div class="dt-row-main">
              <strong>{matchLabel(item.match)}</strong>
              <span class="dt-row-alliance" class:alliance-red={item.alliance === 'red'} class:alliance-blue={item.alliance === 'blue'}>{item.alliance}</span>
            </div>
            <div class="dt-row-meta">
              <span><Clock size={13} /> {formatClock(item.startMs)}</span>
              {#if item.away != null}<span>{item.away} away</span>{/if}
              {#if item.downtimeMs != null}<span class="dt-downtime">{formatDuration(item.downtimeMs)} downtime before</span>{/if}
            </div>
          </div>
        {/each}
      </section>
    {/if}

    {#if lastPlayedOurs}
      <section class="dt-last">
        <h3>Last match</h3>
        <div class="dt-row">
          <div class="dt-row-main"><strong>{matchLabel(lastPlayedOurs)}</strong></div>
          <div class="dt-row-meta">
            {#if lastPlayedOurs.alliances?.red?.score != null}
              <span>{lastPlayedOurs.alliances.red.score} - {lastPlayedOurs.alliances.blue.score}</span>
            {/if}
          </div>
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .dt-page { max-width: 640px; margin: 0 auto; padding: var(--space-3); display: grid; gap: var(--space-3); }
  .dt-header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
  .dt-header h1 { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: 1.4rem; }
  .dt-freshness { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: .78rem; justify-content: center; }
  .dt-empty { border: 1px solid var(--border); padding: var(--space-4); text-align: center; color: var(--text-secondary); border-radius: var(--radius-sm); }
  .dt-error { border-color: var(--danger, #dc3545); color: var(--danger, #dc3545); }

  .dt-next { border: 2px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); text-align: center; background: var(--surface-1); }
  .dt-next.alliance-red { border-color: var(--danger, #dc3545); }
  .dt-next.alliance-blue { border-color: var(--brand-blue, #2563eb); }
  .dt-next-label { text-transform: uppercase; letter-spacing: .06em; font-size: .78rem; color: var(--text-secondary); font-weight: 700; }
  .dt-next h2 { margin: var(--space-1) 0; font-size: 1.6rem; }
  .dt-countdown { font-size: 3rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; margin: var(--space-2) 0; }
  .dt-next-meta { display: flex; justify-content: center; gap: var(--space-3); color: var(--text-secondary); font-size: .9rem; flex-wrap: wrap; }
  .dt-next-meta span { display: inline-flex; align-items: center; gap: 4px; }

  .dt-roster { display: flex; align-items: center; justify-content: center; gap: var(--space-3); margin-top: var(--space-3); flex-wrap: wrap; }
  .dt-alliance { display: flex; gap: var(--space-1); }
  .dt-alliance span { padding: 4px 10px; border-radius: var(--radius-xs); font-weight: 700; background: var(--surface-2); }
  .dt-alliance-red span { color: var(--danger, #dc3545); }
  .dt-alliance-blue span { color: var(--brand-blue, #2563eb); }
  .dt-alliance span.us { background: var(--brand-gold-soft); outline: 2px solid var(--accent); }
  .dt-vs { color: var(--text-secondary); font-weight: 700; }

  .dt-upcoming h3, .dt-last h3 { margin: 0 0 var(--space-2); font-size: .95rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: .04em; }
  .dt-row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: var(--space-2); flex-wrap: wrap; }
  .dt-row-main { display: flex; align-items: center; gap: var(--space-2); }
  .dt-row-alliance { text-transform: capitalize; font-size: .78rem; color: var(--text-secondary); }
  .dt-row-alliance.alliance-red { color: var(--danger, #dc3545); }
  .dt-row-alliance.alliance-blue { color: var(--brand-blue, #2563eb); }
  .dt-row-meta { display: flex; gap: var(--space-3); color: var(--text-secondary); font-size: .82rem; flex-wrap: wrap; }
  .dt-row-meta span { display: inline-flex; align-items: center; gap: 4px; }
  .dt-downtime { font-weight: 600; }

  @media (max-width: 480px) {
    .dt-countdown { font-size: 2.4rem; }
    .dt-next h2 { font-size: 1.3rem; }
  }
</style>
