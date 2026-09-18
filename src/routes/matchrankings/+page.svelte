<script>
  import { onMount } from 'svelte';
  import { ArrowDown, ArrowUp, Check, ListOrdered, RefreshCw } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { getAuthHeader } from '$lib/supabase.js';

  let eventKey = '';
  let matches = [];
  let rosterByKey = new Map();
  let rankings = [];
  let selectedMatchKey = '';
  let rankedKeys = [];
  let loading = true;
  let saving = false;
  let error = '';
  let message = '';
  let unavailable = false;

  $: selectedMatch = matches.find((match) => match.key === selectedMatchKey) || null;
  $: rankedCount = rankings.length;
  $: selectedRanking = rankings.find((ranking) => ranking.match_key === selectedMatchKey) || null;
  $: unrankedMatches = matches.filter((match) => !rankings.some((ranking) => ranking.match_key === match.key)).length;

  function matchLabel(match) {
    const level = String(match?.comp_level || 'qm').toUpperCase();
    if (level === 'QM') return `Qualification ${match?.match_number ?? ''}`.trim();
    return `${level} ${match?.set_number || ''}-${match?.match_number || ''}`.trim();
  }

  function teamsForMatch(match) {
    return [
      ...(match?.alliances?.red?.team_keys || []),
      ...(match?.alliances?.blue?.team_keys || [])
    ].filter(Boolean);
  }

  function isPlayed(match) {
    return Boolean(match?.actual_time || match?.post_result_time || match?.score_breakdown);
  }

  function teamLabel(key) {
    const team = rosterByKey.get(key);
    const number = Number(String(key || '').replace(/^frc/i, ''));
    return `#${Number.isFinite(number) ? number : key}${team?.nickname ? ` ${team.nickname}` : ''}`;
  }

  function selectMatch(matchKey) {
    selectedMatchKey = matchKey;
    const match = matches.find((item) => item.key === matchKey);
    const saved = rankings.find((item) => item.match_key === matchKey);
    rankedKeys = saved?.ranked_team_keys?.length ? [...saved.ranked_team_keys] : teamsForMatch(match);
    message = '';
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= rankedKeys.length) return;
    const next = [...rankedKeys];
    [next[index], next[target]] = [next[target], next[index]];
    rankedKeys = next;
    message = '';
  }

  async function load() {
    if (!eventKey) return;
    loading = true;
    error = '';
    const authHeaders = await getAuthHeader();
    const [matchesResult, rosterResult, rankingsResult] = await Promise.all([
      fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`).then((response) => response.json()).catch(() => null),
      fetch(`/api/tba/event-teams?event_key=${encodeURIComponent(eventKey)}`).then((response) => response.json()).catch(() => null),
      fetch(`/api/scouting-match-rankings?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders }).then((response) => response.json()).catch(() => null)
    ]);
    if (!matchesResult?.success) error = matchesResult?.error || 'Could not load the match schedule.';
    if (!rosterResult?.success) error = error || rosterResult?.error || 'Could not load event teams.';
    if (!rankingsResult?.success && !rankingsResult?.unavailable) error = error || rankingsResult?.error || 'Could not load saved match rankings.';
    matches = matchesResult?.success ? matchesResult.data || [] : [];
    rosterByKey = new Map((rosterResult?.success ? rosterResult.data : []).map((team) => [team.key, team]));
    rankings = rankingsResult?.success ? rankingsResult.data || [] : [];
    unavailable = Boolean(rankingsResult?.unavailable);
    const preferred = matches.find((match) => isPlayed(match) && !rankings.some((ranking) => ranking.match_key === match.key))
      || matches.filter(isPlayed).at(-1)
      || matches[0];
    if (preferred) selectMatch(preferred.key);
    loading = false;
  }

  async function save() {
    if (!eventKey || !selectedMatchKey || rankedKeys.length < 2) return;
    saving = true;
    message = '';
    try {
      const response = await fetch('/api/scouting-match-rankings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
        body: JSON.stringify({ action: 'save', event_key: eventKey, match_key: selectedMatchKey, ranked_team_keys: rankedKeys })
      });
      const result = await response.json();
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Could not save match ranking.');
      rankings = [...rankings.filter((item) => item.match_key !== result.data.match_key), result.data];
      message = `${matchLabel(selectedMatch)} ranking saved.`;
    } catch (cause) {
      message = cause?.message || 'Could not save match ranking.';
    } finally {
      saving = false;
    }
  }

  onMount(async () => {
    eventKey = await fetchActiveScoutingEventKey();
    if (!eventKey) {
      loading = false;
      return;
    }
    await load();
  });
</script>

<svelte:head><title>Match Rankings</title></svelte:head>

<div class="page-header">
  <div class="header-content">
    <h1><ListOrdered size={22} /> Match Rankings</h1>
    <p>Record the scouting group's best-to-worst call after each match. Those direct results connect across matches in Power Rankings.</p>
  </div>
  {#if eventKey}<button class="btn btn-sm" on:click={load} disabled={loading}><RefreshCw size={14} /> Refresh</button>{/if}
</div>

{#if loading}
  <p class="text-muted">Loading match rankings...</p>
{:else if !eventKey}
  <div class="empty-state"><ListOrdered size={40} /><h3>No active scouting event</h3><p>Set one in <a href="/scouting-admin">Scouting Admin</a>.</p></div>
{:else if error}
  <div class="error-container"><p>{error}</p></div>
{:else if unavailable}
  <div class="error-container"><p>Match rankings will be available after the scouting match-rankings migration is applied.</p></div>
{:else}
  <section class="summary-strip" aria-label="Match ranking progress">
    <span><strong>{rankedCount}</strong> ranked match{rankedCount === 1 ? '' : 'es'}</span>
    <span><strong>{unrankedMatches}</strong> remaining</span>
    <a href="/powerrankings">View Power Rankings</a>
  </section>

  <div class="ranking-workspace">
    <aside class="match-list" aria-label="Event matches">
      <h2>Matches</h2>
      {#each matches as match (match.key)}
        <button class:active={match.key === selectedMatchKey} class:played={isPlayed(match)} on:click={() => selectMatch(match.key)}>
          <span>{matchLabel(match)}</span>
          <small>{rankings.some((ranking) => ranking.match_key === match.key) ? 'Ranked' : isPlayed(match) ? 'Ready' : 'Scheduled'}</small>
        </button>
      {/each}
    </aside>

    <section class="order-panel">
      {#if selectedMatch}
        <div class="order-heading">
          <div><h2>{matchLabel(selectedMatch)}</h2><p>{selectedRanking ? 'Update the shared conclusion if the group revises its call.' : 'Move robots into the order the group saw on the field.'}</p></div>
          <button class="btn btn-primary" on:click={save} disabled={saving || rankedKeys.length < 2}><Check size={16} /> {saving ? 'Saving...' : 'Save ranking'}</button>
        </div>
        <ol class="ranked-robots">
          {#each rankedKeys as teamKey, index (teamKey)}
            <li>
              <span class="rank-number">{index + 1}</span>
              <strong>{teamLabel(teamKey)}</strong>
              <span class="move-controls">
                <button class="icon-btn" title="Move up" on:click={() => move(index, -1)} disabled={index === 0}><ArrowUp size={16} /></button>
                <button class="icon-btn" title="Move down" on:click={() => move(index, 1)} disabled={index === rankedKeys.length - 1}><ArrowDown size={16} /></button>
              </span>
            </li>
          {/each}
        </ol>
        {#if message}<p class:save-error={message.includes('Could not')} class="save-message">{message}</p>{/if}
      {:else}
        <div class="empty-state compact"><ListOrdered size={32} /><h3>No matches available</h3></div>
      {/if}
    </section>
  </div>
{/if}

<style>
  h1, h2 { display:flex; align-items:center; gap:var(--gap-2); }
  .summary-strip { display:flex; align-items:center; gap:var(--gap-4); padding:var(--space-3) 0; border-bottom:1px solid var(--border); color:var(--text-muted); }
  .summary-strip strong { color:var(--text); }
  .summary-strip a { margin-left:auto; }
  .ranking-workspace { display:grid; grid-template-columns:minmax(13rem, .6fr) minmax(0, 1.4fr); gap:var(--space-5); margin-top:var(--space-4); }
  .match-list { border-right:1px solid var(--border); padding-right:var(--space-4); max-height:calc(100vh - 16rem); overflow:auto; }
  .match-list h2, .order-panel h2 { margin-top:0; font-size:1rem; }
  .match-list button { width:100%; display:flex; justify-content:space-between; align-items:center; text-align:left; border:1px solid var(--border); background:var(--surface-1); color:var(--text); padding:var(--space-2) var(--space-3); margin-bottom:var(--space-2); border-radius:var(--radius-sm); cursor:pointer; }
  .match-list button.active { border-color:var(--accent-strong); box-shadow:inset 3px 0 var(--accent-strong); }
  .match-list button.played small { color:var(--success); }
  .match-list small { color:var(--text-muted); }
  .order-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:var(--space-4); border-bottom:1px solid var(--border); padding-bottom:var(--space-3); }
  .order-heading p { margin:var(--space-1) 0 0; color:var(--text-muted); }
  .ranked-robots { list-style:none; margin:var(--space-3) 0; padding:0; border-top:1px solid var(--border); }
  .ranked-robots li { display:flex; align-items:center; gap:var(--space-3); min-height:3.25rem; border-bottom:1px solid var(--border); }
  .rank-number { display:grid; place-items:center; width:1.75rem; height:1.75rem; flex:0 0 auto; background:var(--accent-subtle); color:var(--accent-strong); font-weight:700; border-radius:50%; }
  .move-controls { display:flex; gap:var(--gap-1); margin-left:auto; }
  .save-message { margin:var(--space-3) 0; color:var(--success); }
  .save-error { color:var(--danger); }
  @media (max-width:700px) { .ranking-workspace { grid-template-columns:1fr; } .match-list { border-right:0; border-bottom:1px solid var(--border); padding:0 0 var(--space-3); max-height:14rem; } .order-heading { align-items:stretch; flex-direction:column; } .summary-strip { flex-wrap:wrap; } .summary-strip a { margin-left:0; } }
</style>
