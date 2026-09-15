<script>
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { ChevronDown, ChevronRight, RefreshCw, Search, Star, Trash2 } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { getAuthHeader, supabase } from '$lib/supabase.js';
  import { myRobotRating, summarizeRobotRatings } from '$lib/robotRatings.js';

  const RATING_FIELDS = [
    { key: 'overall_rating', label: 'Overall', required: true },
    { key: 'offense_rating', label: 'Offense' },
    { key: 'shuttling_rating', label: 'Shuttling' },
    { key: 'driving_rating', label: 'Driving' },
    { key: 'defense_rating', label: 'Defense', optionalApplicability: true }
  ];
  const SCALE = Array.from({ length: 10 }, (_, index) => index + 1);

  let eventKey = '';
  let loading = true;
  let error = '';
  let warning = '';
  let search = '';

  let teams = []; // { key, team_number, nickname }
  let ratings = []; // raw scouting_robot_ratings rows for this event
  let userId = null;
  let userNames = new Map(); // id -> display name

  let expandedKey = '';
  let drafts = {}; // team_key -> editable draft object
  let saving = {}; // team_key -> boolean
  let saveMessage = {}; // team_key -> string

  $: summaryByTeam = summarizeRobotRatings(ratings);
  $: filteredTeams = (search.trim()
    ? teams.filter((team) => {
        const query = search.trim().toLowerCase();
        return String(team.team_number).includes(query) || (team.nickname || '').toLowerCase().includes(query);
      })
    : teams
  ).slice().sort((a, b) => {
    const left = summaryByTeam.get(a.key)?.overallAvg;
    const right = summaryByTeam.get(b.key)?.overallAvg;
    if (left == null && right == null) return a.team_number - b.team_number;
    if (left == null) return 1;
    if (right == null) return -1;
    return right - left;
  });

  function emptyDraft(teamKey) {
    const mine = myRobotRating(ratings, teamKey, userId);
    return {
      overall_rating: mine?.overall_rating ?? '',
      offense_rating: mine?.offense_rating ?? '',
      shuttling_rating: mine?.shuttling_rating ?? '',
      driving_rating: mine?.driving_rating ?? '',
      defense_rating: mine?.defense_rating ?? '',
      defenseNotApplicable: mine ? mine.defense_rating == null : false,
      notes: mine?.notes || '',
      strategy_notes: mine?.strategy_notes || ''
    };
  }

  function toggleExpanded(team) {
    if (expandedKey === team.key) { expandedKey = ''; return; }
    expandedKey = team.key;
    if (!drafts[team.key]) drafts = { ...drafts, [team.key]: emptyDraft(team.key) };
  }

  function pickRating(teamKey, fieldKey, value) {
    const draft = drafts[teamKey];
    if (!draft) return;
    const next = { ...draft, [fieldKey]: draft[fieldKey] === value ? '' : value };
    if (fieldKey === 'defense_rating') next.defenseNotApplicable = false;
    drafts = { ...drafts, [teamKey]: next };
  }

  function markNotApplicable(teamKey) {
    const draft = drafts[teamKey];
    if (!draft) return;
    drafts = { ...drafts, [teamKey]: { ...draft, defense_rating: '', defenseNotApplicable: !draft.defenseNotApplicable } };
  }

  function displayName(id) {
    if (!id) return 'Unknown scout';
    if (id === userId) return 'You';
    return userNames.get(id) || 'A scout';
  }

  async function loadUserNames() {
    const { data } = await supabase.from('user_profiles').select('id, full_name, email');
    const map = new Map();
    (data || []).forEach((row) => map.set(row.id, row.full_name || row.email || row.id));
    userNames = map;
  }

  async function loadRatings() {
    if (!eventKey) return;
    const authHeaders = await getAuthHeader();
    const response = await fetch(`/api/scouting-robot-ratings?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders })
      .then((res) => res.json())
      .catch(() => null);
    if (response?.success) {
      ratings = response.data || [];
      if (response.unavailable) warning = 'Robot ratings are unavailable until the scouting robot-ratings migration is applied.';
    } else {
      warning = response?.error || 'Could not load robot ratings.';
    }
  }

  async function loadAll() {
    loading = true;
    error = '';
    warning = '';
    const rosterResult = await fetch(`/api/tba/event-teams?event_key=${encodeURIComponent(eventKey)}`).then((res) => res.json()).catch(() => null);
    let roster = rosterResult?.success ? rosterResult.data : [];
    await loadRatings();
    if (!roster.length) {
      // No TBA roster yet - fall back to whatever teams already have a
      // rating, same graceful-degradation pattern Power Rankings uses.
      const keys = [...new Set(ratings.map((rating) => rating.team_key))];
      roster = keys.map((key) => ({ key, team_number: Number(String(key).replace(/^frc/i, '')), nickname: '' }));
    }
    teams = roster;
    if (!teams.length) error = rosterResult?.error || 'No event teams are available yet.';
    loading = false;
  }

  async function saveRating(team) {
    const draft = drafts[team.key];
    if (!draft) return;
    saving = { ...saving, [team.key]: true };
    saveMessage = { ...saveMessage, [team.key]: '' };
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/scouting-robot-ratings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          action: 'rate',
          event_key: eventKey,
          team_key: team.key,
          team_number: team.team_number,
          overall_rating: draft.overall_rating,
          offense_rating: draft.offense_rating,
          shuttling_rating: draft.shuttling_rating,
          driving_rating: draft.driving_rating,
          defense_rating: draft.defenseNotApplicable ? null : draft.defense_rating,
          notes: draft.notes,
          strategy_notes: draft.strategy_notes
        })
      });
      const result = await response.json();
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Could not save rating.');
      await loadRatings();
      drafts = { ...drafts, [team.key]: emptyDraft(team.key) };
      saveMessage = { ...saveMessage, [team.key]: 'Saved.' };
    } catch (cause) {
      saveMessage = { ...saveMessage, [team.key]: cause?.message || 'Could not save rating.' };
    } finally {
      saving = { ...saving, [team.key]: false };
    }
  }

  async function deleteRating(team) {
    const mine = myRobotRating(ratings, team.key, userId);
    if (!mine) return;
    saving = { ...saving, [team.key]: true };
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/scouting-robot-ratings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action: 'delete', id: mine.id })
      });
      const result = await response.json();
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Could not remove rating.');
      await loadRatings();
      drafts = { ...drafts, [team.key]: emptyDraft(team.key) };
      saveMessage = { ...saveMessage, [team.key]: 'Removed.' };
    } catch (cause) {
      saveMessage = { ...saveMessage, [team.key]: cause?.message || 'Could not remove rating.' };
    } finally {
      saving = { ...saving, [team.key]: false };
    }
  }

  const fmt = (value) => (value == null ? '—' : value.toFixed(1));

  onMount(async () => {
    const { data } = await supabase.auth.getUser();
    userId = data?.user?.id || null;
    await loadUserNames();
    eventKey = await fetchActiveScoutingEventKey();
    if (!eventKey) { loading = false; return; }
    await loadAll();
    const requestedTeam = $page.url.searchParams.get('team');
    if (requestedTeam && teams.some((team) => team.key === requestedTeam)) {
      expandedKey = requestedTeam;
      drafts = { ...drafts, [requestedTeam]: emptyDraft(requestedTeam) };
    }
  });
</script>

<svelte:head><title>Robot Ratings</title></svelte:head>

<div class="page-header">
  <div class="header-content">
    <h1><Star size={22} /> Robot Ratings</h1>
    <p>Your own out-of-10 impressions and practice-match notes, visible to the whole team{eventKey ? ` for ${eventKey}` : ''}. Feeds a display-only average into Power Rankings - it never changes calculated Scout Power.</p>
  </div>
  {#if eventKey}
    <button class="btn btn-sm" on:click={loadAll} disabled={loading}><RefreshCw size={14} /> Refresh</button>
  {/if}
</div>

{#if loading}
  <p class="text-muted">Loading robot ratings...</p>
{:else if !eventKey}
  <div class="empty-state"><Star size={40} /><h3>No active scouting event</h3><p>Set one in <a href="/scouting-admin">Scouting Admin</a>.</p></div>
{:else if error}
  <div class="error-container"><p>{error}</p></div>
{:else}
  {#if warning}<p class="text-muted">⚠ {warning}</p>{/if}

  <div class="search"><Search size={16} /><input class="form-input" placeholder="Filter teams..." bind:value={search} /></div>

  <div class="rating-list">
    {#each filteredTeams as team (team.key)}
      {@const summary = summaryByTeam.get(team.key)}
      {@const isExpanded = expandedKey === team.key}
      {@const mine = myRobotRating(ratings, team.key, userId)}
      <section class="surface-card rating-row">
        <button class="rating-row-header" on:click={() => toggleExpanded(team)}>
          {#if isExpanded}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}
          <span class="mono">#{team.team_number}</span>
          <span class="rating-row-name">{team.nickname || ''}</span>
          <span class="rating-row-summary">
            {#if mine}<span class="mine-badge" title="You've rated this team"><Star size={12} /></span>{/if}
            <span class="score-bar" title={`${fmt(summary?.overallAvg)} average over ${summary?.raterCount || 0} rater${summary?.raterCount === 1 ? '' : 's'}`}>
              <span class="score-bar-fill" style={`width:${Math.max(0, Math.min(100, ((summary?.overallAvg ?? 0) / 10) * 100))}%`}></span>
            </span>
            <strong class="score-value">{fmt(summary?.overallAvg)}</strong>
            <span class="text-muted">· {summary?.raterCount || 0} rater{summary?.raterCount === 1 ? '' : 's'}</span>
          </span>
        </button>

        {#if isExpanded}
          {@const draft = drafts[team.key] || emptyDraft(team.key)}
          <div class="rating-detail">
            <div class="rating-form">
              <h3>Your rating</h3>
              {#each RATING_FIELDS as field (field.key)}
                <div class="rating-field">
                  <div class="rating-field-label">
                    <span>{field.label}{field.required ? '' : ' (optional)'}</span>
                    {#if field.optionalApplicability}
                      <button type="button" class="na-toggle" class:chosen={draft.defenseNotApplicable} on:click={() => markNotApplicable(team.key)}>N/A</button>
                    {/if}
                  </div>
                  <div class="rating-scale" class:disabled={field.optionalApplicability && draft.defenseNotApplicable}>
                    {#each SCALE as value}
                      <button
                        type="button"
                        class="scale-chip"
                        class:chosen={draft[field.key] === value}
                        disabled={field.optionalApplicability && draft.defenseNotApplicable}
                        on:click={() => pickRating(team.key, field.key, value)}
                      >{value}</button>
                    {/each}
                  </div>
                </div>
              {/each}
              <label class="rating-field full-width">
                Notes
                <textarea class="form-input" rows="2" bind:value={draft.notes} placeholder="General impressions..."></textarea>
              </label>
              <label class="rating-field full-width">
                Strategy notes (practice matches)
                <textarea class="form-input" rows="2" bind:value={draft.strategy_notes} placeholder="What did they do in practice matches that changes how we'd play with or against them?"></textarea>
              </label>
              <div class="rating-form-actions">
                <button class="btn btn-primary btn-sm" disabled={saving[team.key] || !draft.overall_rating} on:click={() => saveRating(team)}>
                  {saving[team.key] ? 'Saving...' : 'Save rating'}
                </button>
                {#if mine}
                  <button class="btn btn-sm btn-danger" disabled={saving[team.key]} on:click={() => deleteRating(team)}><Trash2 size={14} /> Remove mine</button>
                {/if}
                {#if saveMessage[team.key]}<span class="text-muted">{saveMessage[team.key]}</span>{/if}
              </div>
            </div>

            <div class="rating-entries">
              <h3>All ratings ({summary?.entries.length || 0})</h3>
              {#if summary?.entries.length}
                {#each summary.entries as entry (entry.id)}
                  <div class="rating-entry">
                    <div class="rating-entry-header">
                      <strong>{displayName(entry.created_by)}</strong>
                      <span class="text-muted">{new Date(entry.updated_at).toLocaleString()}</span>
                    </div>
                    <div class="rating-entry-scores">
                      <span>Overall <b>{entry.overall_rating}</b></span>
                      <span>Offense <b>{entry.offense_rating ?? '—'}</b></span>
                      <span>Shuttling <b>{entry.shuttling_rating ?? '—'}</b></span>
                      <span>Driving <b>{entry.driving_rating ?? '—'}</b></span>
                      <span>Defense <b>{entry.defense_rating ?? 'N/A'}</b></span>
                    </div>
                    {#if entry.notes}<p class="rating-entry-notes">{entry.notes}</p>{/if}
                    {#if entry.strategy_notes}<p class="rating-entry-notes strategy"><strong>Strategy:</strong> {entry.strategy_notes}</p>{/if}
                  </div>
                {/each}
              {:else}
                <p class="text-muted">No one has rated this team yet.</p>
              {/if}
            </div>
          </div>
        {/if}
      </section>
    {:else}
      <p class="text-muted">No teams to rate yet.</p>
    {/each}
  </div>
{/if}

<style>
  h1, .search { display:flex; align-items:center; gap:var(--gap-2); }
  .rating-list { display:flex; flex-direction:column; gap:var(--space-2); margin-top:var(--space-3); }
  .rating-row { padding:0; overflow:hidden; }
  .rating-row-header {
    display:flex; align-items:center; gap:var(--gap-2); width:100%; padding:var(--space-3);
    background:none; border:none; cursor:pointer; text-align:left; font:inherit; color:inherit;
  }
  .rating-row-name { flex:1; }
  .rating-row-summary { display:flex; align-items:center; gap:var(--gap-1); }
  .mine-badge { display:inline-flex; color:var(--brand-gold-strong, #b8860b); }
  .score-bar { display:inline-block; width:64px; height:6px; border-radius:3px; background:var(--surface-2); overflow:hidden; }
  .score-bar-fill { display:block; height:100%; background:var(--brand-gold-strong, #b8860b); }
  .score-value { min-width:2ch; }

  .rating-detail { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:var(--space-4); padding:0 var(--space-3) var(--space-3); border-top:1px solid var(--border); }
  .rating-field { display:flex; flex-direction:column; gap:4px; font-size:0.85rem; margin-top:var(--space-2); }
  .rating-field.full-width { grid-column:1 / -1; }
  .rating-field-label { display:flex; align-items:center; justify-content:space-between; gap:var(--gap-2); }
  .rating-scale { display:flex; gap:3px; flex-wrap:wrap; }
  .rating-scale.disabled { opacity:.4; }
  .scale-chip {
    min-width:1.75rem; height:1.75rem; padding:0; border:1px solid var(--border); border-radius:var(--radius-sm);
    background:var(--surface-1); color:var(--text); font:inherit; font-size:.8rem; font-weight:600; cursor:pointer;
  }
  .scale-chip:hover:not(:disabled) { border-color:var(--brand-gold-strong, #b8860b); }
  .scale-chip.chosen { background:var(--brand-gold-strong, #b8860b); border-color:var(--brand-gold-strong, #b8860b); color:#fff; }
  .scale-chip:disabled { cursor:not-allowed; }
  .na-toggle {
    padding:.1rem .5rem; border:1px solid var(--border); border-radius:999px; background:var(--surface-1);
    color:var(--text-muted); font:inherit; font-size:.7rem; font-weight:700; cursor:pointer;
  }
  .na-toggle.chosen { background:var(--text-muted); color:var(--surface-1); border-color:var(--text-muted); }
  .rating-form-actions { display:flex; align-items:center; gap:var(--gap-2); margin-top:var(--space-3); }
  .rating-entries { max-height:420px; overflow-y:auto; }
  .rating-entry { padding:var(--space-2) 0; border-bottom:1px solid var(--border); }
  .rating-entry:last-child { border-bottom:none; }
  .rating-entry-header { display:flex; justify-content:space-between; gap:var(--gap-2); }
  .rating-entry-scores { display:flex; flex-wrap:wrap; gap:var(--gap-2); font-size:0.85rem; margin-top:4px; color:var(--text-muted); }
  .rating-entry-notes { margin:6px 0 0; font-size:0.9rem; }
  .rating-entry-notes.strategy { color:var(--text-muted); }
  @media (max-width:760px) { .rating-detail { grid-template-columns:1fr; } }
</style>
