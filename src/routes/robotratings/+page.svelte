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
      <section class="surface-card rating-row">
        <button class="rating-row-header" on:click={() => toggleExpanded(team)}>
          {#if isExpanded}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}
          <span class="mono">#{team.team_number}</span>
          <span class="rating-row-name">{team.nickname || ''}</span>
          <span class="rating-row-summary">
            <strong>{fmt(summary?.overallAvg)}</strong> avg overall
            <span class="text-muted">· {summary?.raterCount || 0} rater{summary?.raterCount === 1 ? '' : 's'}</span>
          </span>
        </button>

        {#if isExpanded}
          {@const draft = drafts[team.key] || emptyDraft(team.key)}
          <div class="rating-detail">
            <div class="rating-form">
              <h3>Your rating</h3>
              <div class="rating-field-grid">
                {#each RATING_FIELDS as field (field.key)}
                  <label class="rating-field">
                    {field.label}{field.required ? '' : ' (optional)'}
                    {#if field.optionalApplicability}
                      <span class="rating-na">
                        <input type="checkbox" bind:checked={draft.defenseNotApplicable} />
                        N/A
                      </span>
                    {/if}
                    <input
                      class="form-input"
                      type="number" min="1" max="10" step="1"
                      disabled={field.optionalApplicability && draft.defenseNotApplicable}
                      bind:value={draft[field.key]}
                    />
                  </label>
                {/each}
              </div>
              <label class="rating-field full-width">
                Notes
                <textarea class="form-input" rows="2" bind:value={draft.notes} placeholder="General impressions..."></textarea>
              </label>
              <label class="rating-field full-width">
                Strategy notes (practice matches)
                <textarea class="form-input" rows="2" bind:value={draft.strategy_notes} placeholder="What did they do in practice matches that changes how we'd play with or against them?"></textarea>
              </label>
              <div class="rating-form-actions">
                <button class="btn btn-primary btn-sm" disabled={saving[team.key]} on:click={() => saveRating(team)}>
                  {saving[team.key] ? 'Saving...' : 'Save rating'}
                </button>
                {#if myRobotRating(ratings, team.key, userId)}
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
  .rating-row-summary { display:flex; align-items:baseline; gap:var(--gap-1); }
  .rating-detail { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:var(--space-4); padding:0 var(--space-3) var(--space-3); border-top:1px solid var(--border); }
  .rating-field-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:var(--space-2); }
  .rating-field { display:flex; flex-direction:column; gap:4px; font-size:0.85rem; }
  .rating-field.full-width { grid-column:1 / -1; margin-top:var(--space-2); }
  .rating-na { display:flex; align-items:center; gap:4px; font-size:0.75rem; }
  .rating-form-actions { display:flex; align-items:center; gap:var(--gap-2); margin-top:var(--space-2); }
  .rating-entries { max-height:420px; overflow-y:auto; }
  .rating-entry { padding:var(--space-2) 0; border-bottom:1px solid var(--border); }
  .rating-entry:last-child { border-bottom:none; }
  .rating-entry-header { display:flex; justify-content:space-between; gap:var(--gap-2); }
  .rating-entry-scores { display:flex; flex-wrap:wrap; gap:var(--gap-2); font-size:0.85rem; margin-top:4px; color:var(--text-muted); }
  .rating-entry-notes { margin:6px 0 0; font-size:0.9rem; }
  .rating-entry-notes.strategy { color:var(--text-muted); }
  @media (max-width:760px) { .rating-detail { grid-template-columns:1fr; } }
</style>
