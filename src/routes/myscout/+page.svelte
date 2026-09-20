<script>
  import { onMount } from 'svelte';
  import { ClipboardCheck, ListChecks, RefreshCw, Wrench } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { userStore } from '$lib/stores/auth.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';

  let user;
  userStore.subscribe((v) => (user = v));

  let eventKey = '';
  let matchReports = [];
  let pitReports = [];
  let assignments = [];
  let loading = true;
  let error = '';

  const ASSIGNMENT_LIMIT = 20;
  const SCOUTING_TYPE_LABELS = {
    data: 'Match scouting',
    note: 'Note scouting',
    quick: 'Quick scouting'
  };

  async function load() {
    loading = true;
    error = '';
    try {
      eventKey = (await fetchActiveScoutingEventKey()) || '';
      if (!eventKey) {
        matchReports = [];
        pitReports = [];
        assignments = [];
        return;
      }
      const headers = await getAuthHeader();
      // Match Scouting already has a proven mine=1 (per-event) branch -
      // reuse it exactly rather than a new one. Pit scouting has no
      // per-scout filter server-side (one row per team, not per scout), so
      // fetch the event's roster and keep only this scout's own rows -
      // created_by is overwritten on every save, so this is "entries this
      // scout most recently touched," the best signal available.
      const [matchRes, pitRes, dataAssignments, noteAssignments, quickAssignments] = await Promise.all([
        fetch(`/api/matchscout?event_key=${encodeURIComponent(eventKey)}&mine=1`, { headers }).then((r) => r.json()).catch(() => null),
        fetch(`/pitscout?event_key=${encodeURIComponent(eventKey)}`, { headers }).then((r) => r.json()).catch(() => null),
        fetchMyAssignments('data', headers),
        fetchMyAssignments('note', headers),
        fetchMyAssignments('quick', headers)
      ]);
      matchReports = matchRes?.success ? matchRes.data || [] : [];
      pitReports = pitRes?.success ? (pitRes.data || []).filter((r) => r.created_by === user?.id) : [];
      assignments = [...dataAssignments, ...noteAssignments, ...quickAssignments]
        .filter((assignment) => !assignment.completed_at)
        .sort(compareAssignments);
      if (!matchRes?.success && !pitRes?.success) {
        error = matchRes?.error || pitRes?.error || 'Could not load your scouting history.';
      }
    } catch (exception) {
      error = exception?.message || 'Could not load your scouting history.';
    } finally {
      loading = false;
    }
  }

  async function fetchMyAssignments(scoutingType, headers) {
    if (!user?.id) return [];
    const response = await fetch(
      `/api/scout-assignments?scouting_type=${scoutingType}&mine=1&user_id=${encodeURIComponent(user.id)}`,
      { headers }
    );
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.success ? payload.data || [] : [];
  }

  onMount(load);

  const teamNumber = (key) => String(key || '').replace(/^frc/i, '');

  function matchNumberForRoute(matchKey) {
    const suffix = String(matchKey || '').split('_').pop();
    return suffix.replace(/^qm/i, '') || '';
  }

  function matchLabel(matchKey) {
    const suffix = String(matchKey || '').split('_').pop().toLowerCase();
    const qualification = suffix.match(/^qm(\d+)$/);
    const practice = suffix.match(/^pm(\d+)$/);
    const quarterfinal = suffix.match(/^qf(\d+)(?:m(\d+))?$/);
    const semifinal = suffix.match(/^sf(\d+)(?:m(\d+))?$/);
    const final = suffix.match(/^f(\d+)(?:m(\d+))?$/);

    if (qualification) return `Qualification Match ${qualification[1]}`;
    if (practice) return `Practice Match ${practice[1]}`;
    if (quarterfinal) return `Quarterfinal ${quarterfinal[1]}${quarterfinal[2] ? ` Match ${quarterfinal[2]}` : ''}`;
    if (semifinal) return `Semifinal ${semifinal[1]}${semifinal[2] ? ` Match ${semifinal[2]}` : ''}`;
    if (final) return `Final ${final[1]}${final[2] ? ` Match ${final[2]}` : ''}`;
    return suffix ? `Match ${suffix}` : 'Match';
  }

  function compareAssignments(left, right) {
    const number = (value) => Number(String(value || '').match(/\d+/)?.[0]) || 0;
    return number(left.match_key) - number(right.match_key)
      || String(left.match_key || '').localeCompare(String(right.match_key || ''))
      || Number(teamNumber(left.team_key)) - Number(teamNumber(right.team_key));
  }

  function assignmentHref(assignment) {
    const team = teamNumber(assignment.team_key);
    const match = matchNumberForRoute(assignment.match_key);
    if (assignment.scouting_type === 'data') {
      return `/matchscout?match=${encodeURIComponent(match)}&team=${encodeURIComponent(team)}`;
    }
    return assignment.scouting_type === 'note' ? '/notescout' : '/quickscout';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  $: teamsCovered = new Set([...matchReports, ...pitReports].map((r) => r.team_key).filter(Boolean)).size;
  $: sortedMatchReports = [...matchReports].sort((a, b) =>
    String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  $: sortedPitReports = [...pitReports].sort((a, b) =>
    String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  $: visibleAssignments = assignments.slice(0, ASSIGNMENT_LIMIT);
  $: hiddenAssignmentCount = Math.max(0, assignments.length - visibleAssignments.length);
</script>

<svelte:head><title>My Scout</title></svelte:head>

<div class="myscout-page">
  <header class="myscout-header">
    <div>
      <h1><ClipboardCheck size={22} /> My Scout</h1>
      <p>Every match and pit report you've personally submitted for the active competition.</p>
    </div>
    <button class="btn btn-outline" on:click={load} disabled={loading}><RefreshCw size={16} /> Refresh</button>
  </header>

  {#if loading}
    <div class="empty-state">Loading your scouting history...</div>
  {:else if error}
    <div class="notice notice-error">{error}</div>
  {:else if !eventKey}
    <div class="empty-state">No active competition is set. Set one in <a href="/scouting-admin">Scouting Admin</a> to see your scouting history here.</div>
  {:else}
    <div class="stat-strip">
      <div class="stat-tile">
        <span class="stat-label">Competition</span>
        <strong class="stat-value stat-value-text">{eventKey}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Match Reports</span>
        <strong class="stat-value">{matchReports.length}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Pit Reports</span>
        <strong class="stat-value">{pitReports.length}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Teams Covered</span>
        <strong class="stat-value">{teamsCovered}</strong>
      </div>
    </div>

    <section class="assignment-section" aria-labelledby="assignment-heading">
      <div class="section-heading">
        <div>
          <h2 id="assignment-heading"><ListChecks size={18} /> Assignments to Complete</h2>
          <p class="muted">{assignments.length ? `${assignments.length} open scouting assignment${assignments.length === 1 ? '' : 's'}` : 'No open scouting assignments.'}</p>
        </div>
        {#if hiddenAssignmentCount}
          <span class="assignment-overflow">+{hiddenAssignmentCount} more</span>
        {/if}
      </div>
      <div class="assignment-grid" class:empty={visibleAssignments.length === 0}>
        {#each visibleAssignments as assignment (assignment.id)}
          <a class="assignment-card" href={assignmentHref(assignment)}>
            <span class="assignment-type">{SCOUTING_TYPE_LABELS[assignment.scouting_type] || 'Scouting'}</span>
            <strong>{matchLabel(assignment.match_key)} · Team {teamNumber(assignment.team_key)}</strong>
          </a>
        {:else}
          <p class="assignment-empty">You are caught up.</p>
        {/each}
      </div>
    </section>

    <section class="report-section">
      <h2><ClipboardCheck size={18} /> Match Reports</h2>
      {#if sortedMatchReports.length === 0}
        <p class="muted">No match reports submitted yet. Head to <a href="/matchscout">Match Scouting</a> to start one.</p>
      {:else}
        <div class="report-grid">
          {#each sortedMatchReports as r (r.id)}
            <a class="report-card" href={`/matchscout?match=${encodeURIComponent(r.match_key)}&team=${encodeURIComponent(r.team_key)}`}>
              <span class="report-event">{r.event_key}</span>
              <h4>Match {r.match_key} &middot; Team {teamNumber(r.team_key)}</h4>
              <p class="muted">
                {#if r.alliance}<span class="alliance-chip" class:red={r.alliance === 'red'} class:blue={r.alliance === 'blue'}>{r.alliance}</span>{/if}
                {fmtDate(r.updated_at || r.created_at)}
              </p>
            </a>
          {/each}
        </div>
      {/if}
    </section>

    <section class="report-section">
      <h2><Wrench size={18} /> Pit Scouting Reports</h2>
      {#if sortedPitReports.length === 0}
        <p class="muted">No pit scouting reports submitted yet. Head to <a href="/pitscout">Pit Scouting</a> to start one.</p>
      {:else}
        <div class="report-grid">
          {#each sortedPitReports as r (r.event_key + '::' + r.team_key)}
            <a class="report-card pit" href={`/pitscout?event_key=${encodeURIComponent(r.event_key)}&team_key=${encodeURIComponent(r.team_key)}`}>
              <span class="report-event">{r.event_key}</span>
              <h4>Team {teamNumber(r.team_key)}</h4>
              <p class="muted">{r.robot_archetype || r.drivebase_type || 'Pit report'} &middot; {fmtDate(r.updated_at || r.created_at)}</p>
            </a>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .myscout-page {
    --home-radius: 0;
    max-width: 1200px;
    margin: var(--space-7) auto;
    padding: 0 var(--space-4);
  }

  .myscout-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }

  .myscout-header h1 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }

  .myscout-header p {
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
  }

  .stat-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    margin-bottom: var(--space-6);
  }

  .stat-tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    background: var(--surface-1);
    padding: var(--space-4) var(--space-5);
  }

  .stat-label {
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .stat-value {
    font-size: var(--font-xxl, 1.75rem);
    font-weight: 700;
    color: var(--secondary);
    line-height: 1.1;
  }

  .stat-value-text {
    font-size: var(--font-lg);
    font-family: var(--font-mono-stack);
    text-transform: uppercase;
  }

  .report-section {
    margin-bottom: var(--space-7);
  }

  .assignment-section {
    margin-bottom: var(--space-6);
  }

  .section-heading {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .section-heading h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--secondary);
    font-size: var(--font-lg);
  }

  .section-heading p {
    margin: var(--space-1) 0 0;
  }

  .assignment-overflow {
    color: var(--text-secondary);
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    white-space: nowrap;
  }

  .assignment-grid {
    display: grid;
    grid-template-columns: repeat(10, minmax(0, 1fr));
    grid-template-rows: repeat(2, minmax(72px, 1fr));
    gap: var(--gap-2);
    min-height: calc(144px + var(--gap-2));
  }

  .assignment-card {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--brand-gold-strong);
    color: inherit;
    padding: var(--space-2);
    text-decoration: none;
  }

  .assignment-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
  }

  .assignment-type {
    color: var(--text-muted);
    font-family: var(--font-mono-stack);
    font-size: 0.65rem;
    line-height: 1.1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .assignment-card strong {
    margin-top: 3px;
    font-size: var(--font-xs);
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .assignment-empty {
    grid-column: 1 / -1;
    align-self: center;
    margin: 0;
    color: var(--text-secondary);
  }

  .report-section h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
    color: var(--secondary);
    font-size: var(--font-lg);
  }

  .report-section .muted {
    color: var(--text-secondary);
  }

  .report-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--gap-3);
  }

  .report-card {
    display: block;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--brand-gold-strong);
    padding: var(--space-4) var(--space-5);
    text-decoration: none;
    color: inherit;
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .report-card.pit {
    border-left-color: var(--accent-strong, #4a6fa5);
  }

  .report-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
  }

  .report-event {
    display: block;
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-1);
  }

  .report-card h4 {
    margin: 0 0 var(--space-1) 0;
    color: var(--secondary);
    font-size: var(--font-md);
  }

  .report-card p {
    margin: 0;
    font-size: var(--font-xs);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .alliance-chip {
    text-transform: uppercase;
    font-size: var(--font-xs);
    font-weight: 700;
    padding: 1px 6px;
  }

  .alliance-chip.red { color: var(--red-strong); background: var(--red-soft); }
  .alliance-chip.blue { color: var(--blue-strong, #174ea6); background: var(--blue-soft, #e8f1ff); }

  .empty-state, .notice {
    border: 1px solid var(--border);
    padding: var(--space-4);
    color: var(--text-secondary);
  }

  .notice-error { border-color: var(--danger, #dc3545); color: var(--danger, #dc3545); }

  @media (max-width: 600px) {
    .myscout-header { flex-direction: column; align-items: stretch; }
    .assignment-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-rows: repeat(2, minmax(72px, 1fr));
    }
    .assignment-grid .assignment-card:nth-of-type(n + 5) { display: none; }
  }
</style>
