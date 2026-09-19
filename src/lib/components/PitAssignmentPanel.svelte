<script>
  import { onMount } from 'svelte';
  import { scoutDisplayName } from '$lib/scoutNames.js';
  import { userStore } from '$lib/stores/auth.js';
  import { getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';

  export let assignmentKind = 'pit';
  export let open = false;

  $: isPrescout = assignmentKind === 'prescout';
  $: assignmentEndpoint = isPrescout ? '/api/prescout-assignments' : '/api/pit-scout-assignments';
  $: assignmentTitle = isPrescout ? 'Pre-Scouting Assignments' : 'Pit Scouting Assignments';
  $: assignmentVerb = isPrescout ? 'pre-scout' : 'pit scout';
  $: teamSourceLabel = isPrescout ? 'Pre-scout teams' : 'Event teams';

  let user;
  userStore.subscribe((v) => (user = v));

  let panelOpen = open;
  $: panelOpen = open;
  let eventTeams = []; // [{key, team_number, nickname}]
  let eventKey = '';
  let publishedAssignments = {}; // team_key -> { user_id, user_name }
  let assignments = {}; // team_key -> { user_id, user_name }
  let users = []; // eligible assignees
  let loading = false;
  let saving = false;
  let errorMsg = '';
  let statusMsg = '';
  let hasDraftChanges = false;

  let capabilities = {
    can_view: true,
    can_edit: false,
    can_be_assigned: false,
    roster_keys: []
  };

  let lastUserId = null;
  let draggingTeamKey = '';
  let dropTargetUserId = '';
  let scoutFilter = '';

  async function authFetch(url, options = {}) {
    const headers = {
      ...(options.headers || {}),
      ...(await getAuthHeader())
    };
    return fetch(url, { ...options, headers });
  }

  function displayTeam(teamKey) {
    return teamKey ? String(teamKey).replace(/^frc/i, '') : '';
  }

  function cloneAssignments(map) {
    const next = {};
    for (const [teamKey, value] of Object.entries(map || {})) {
      next[teamKey] = { ...value };
    }
    return next;
  }

  function serializeAssignments(map) {
    return Object.entries(map || {})
      .map(([teamKey, value]) => `${teamKey}::${value?.user_id || ''}`)
      .sort()
      .join('|');
  }

  function findUserName(userId) {
    const matched = users.find((userRow) => userRow.id === userId);
    return matched ? scoutDisplayName(matched) : null;
  }

  function stageAssignments(nextAssignments, message) {
    assignments = cloneAssignments(nextAssignments);
    statusMsg = message || '';
    errorMsg = '';
  }

  function stageTeamAssignment(teamKey, userId) {
    if (!teamKey || !userId || !capabilities.can_edit) return;
    const nextAssignments = cloneAssignments(assignments);
    nextAssignments[teamKey] = {
      user_id: userId,
      user_name: findUserName(userId) || null
    };
    stageAssignments(
      nextAssignments,
      `Team ${displayTeam(teamKey)} is staged for ${findUserName(userId) || 'that scout'}. Publish assignments to notify scouts.`
    );
  }

  function startTeamDrag(event, teamKey) {
    if (!capabilities.can_edit || !teamKey) {
      event.preventDefault();
      return;
    }
    draggingTeamKey = teamKey;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', teamKey);
  }

  function finishTeamDrag() {
    draggingTeamKey = '';
    dropTargetUserId = '';
  }

  function dropTeamOnScout(event, userId) {
    event.preventDefault();
    const teamKey = draggingTeamKey || event.dataTransfer.getData('text/plain');
    stageTeamAssignment(teamKey, userId);
    finishTeamDrag();
  }

  async function loadCapabilities() {
    try {
      const qs = new URLSearchParams({ capabilities: '1' });
      const res = await authFetch(`${assignmentEndpoint}?${qs}`);
      const data = await res.json();
      if (data?.success && data?.data) {
        capabilities = { ...capabilities, ...data.data };
      }
    } catch {
      capabilities = { ...capabilities, can_edit: false };
    }
  }

  async function loadEligibleUsers() {
    if (!capabilities.can_edit) {
      users = [];
      return;
    }

    try {
      const qs = new URLSearchParams({ eligible: '1' });
      const res = await authFetch(`${assignmentEndpoint}?${qs}`);
      const data = await res.json();
      if (data?.success) {
        users = data.data || [];
      }
    } catch {
      users = [];
    }
  }

  async function loadEventTeams() {
    if (isPrescout) {
      try {
        loading = true;
        errorMsg = '';
        const res = await authFetch(`${assignmentEndpoint}?teams=1`);
        const data = await res.json();
        if (!data?.success) {
          errorMsg = data?.error || 'Failed to load pre-scout teams';
          return;
        }
        eventKey = data.event_key || '';
        eventTeams = (data.data || [])
          .map((teamKey) => ({ key: teamKey, team_number: Number(String(teamKey).replace(/^frc/i, '')) || 0 }))
          .sort((a, b) => a.team_number - b.team_number);
      } catch (e) {
        errorMsg = e.message || 'Load error';
      } finally {
        loading = false;
      }
      return;
    }

    eventKey = (await fetchActiveScoutingEventKey()) || '';
    if (!eventKey) {
      errorMsg = 'No event configured';
      return;
    }

    try {
      loading = true;
      errorMsg = '';
      const res = await fetch(`/api/tba/event-teams?event_key=${encodeURIComponent(eventKey)}`);

      let data;
      try {
        data = await res.json();
      } catch {
        const text = await res.text();
        errorMsg = `Non-JSON response (${res.status}): ${text.slice(0, 100)}`;
        return;
      }

      if (!data?.success) {
        errorMsg = data?.error || 'Failed to load event teams';
        return;
      }

      eventTeams = (data.data || [])
        .map((t) => ({ key: t.key, team_number: t.team_number, nickname: t.nickname }))
        .sort((a, b) => (a.team_number || 0) - (b.team_number || 0));
    } catch (e) {
      errorMsg = e.message || 'Load error';
    } finally {
      loading = false;
    }
  }

  async function loadAssignments() {
    if (!eventKey) return;
    try {
      const qs = new URLSearchParams({ event_key: eventKey });
      const res = await authFetch(`${assignmentEndpoint}?${qs}`);
      const data = await res.json();
      if (!data?.success) return;

      const nextAssignments = {};
      for (const row of data.data || []) {
        nextAssignments[row.team_key] = {
          user_id: row.assigned_user,
          user_name: row.user_name
        };
      }
      publishedAssignments = cloneAssignments(nextAssignments);
      assignments = cloneAssignments(nextAssignments);
      statusMsg = '';
    } catch {
      publishedAssignments = {};
      assignments = {};
    }
  }

  function randomize() {
    if (!capabilities.can_edit) return;

    const eligible = [...users];
    if (eligible.length === 0 || eventTeams.length === 0) return;

    const newAssignments = {};
    const shuffled = [...eligible].sort(() => Math.random() - 0.5);
    eventTeams.forEach((team, index) => {
      const chosen = shuffled[index % shuffled.length];
      newAssignments[team.key] = {
        user_id: chosen.id,
        user_name: scoutDisplayName(chosen)
      };
    });

    stageAssignments(
      newAssignments,
      'Randomized assignments are staged locally. Publish assignments when ready.'
    );
  }

  // Unlike stageTeamAssignment (a local draft, only sent on Publish), this
  // is immediate - direct instruction: removing someone should notify them
  // right away, not sit as an unpublished draft they never find out about.
  async function removeAssignment(teamKey) {
    if (!capabilities.can_edit || saving || !teamKey) return;
    saving = true;
    errorMsg = '';
    try {
      const res = await authFetch(assignmentEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unassign', event_key: eventKey, team_key: teamKey })
      });
      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || 'unknown');
      await loadAssignments();
      statusMsg = `Team ${displayTeam(teamKey)} unassigned.`;
    } catch (e) {
      errorMsg = `Remove failed: ${e.message}`;
    } finally {
      saving = false;
    }
  }

  async function publishAssignments() {
    if (!capabilities.can_edit || !hasDraftChanges || saving) return;
    errorMsg = '';

    const list = Object.entries(assignments)
      .filter(([, value]) => value?.user_id)
      .map(([teamKey, value]) => ({ team_key: teamKey, user_id: value.user_id }));

    if (list.length === 0) {
      statusMsg = 'No assignments to publish.';
      return;
    }

    saving = true;
    try {
      const res = await authFetch(assignmentEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'bulk-assign', event_key: eventKey, items: list })
      });

      const responseText = await res.text();
      let data = null;
      try {
        data = responseText ? JSON.parse(responseText) : null;
      } catch {
        // A proxy/deployment failure can return HTML instead of the API's
        // JSON envelope. Keep enough of it to make the problem actionable.
      }
      if (!res.ok || !data?.success) {
        const detail = data?.error || responseText.trim().slice(0, 240);
        throw new Error(detail || `Request failed (${res.status})`);
      }
      await loadAssignments();
      statusMsg = 'Assignments published.';
    } catch (e) {
      errorMsg = `Publish failed: ${e.message}`;
    } finally {
      saving = false;
    }
  }

  async function refreshAll() {
    await loadCapabilities();
    await loadEventTeams();
    await loadAssignments();
    await loadEligibleUsers();
  }

  onMount(() => {
    refreshAll();
  });

  $: if (user?.id && user.id !== lastUserId) {
    lastUserId = user.id;
    refreshAll();
  }

  $: hasDraftChanges =
    serializeAssignments(assignments) !== serializeAssignments(publishedAssignments);
  $: filteredUsers = users.filter((scout) => {
    const name = `${scout.full_name || ''} ${scout.email || ''}`.toLowerCase();
    return name.includes(scoutFilter.trim().toLowerCase());
  });
</script>

<details class="assignment-accordion" bind:open={panelOpen}>
  <summary class="summary-row">
    <div class="summary-title">{assignmentTitle}</div>
    <div class="summary-meta">
      <span class="mode-pill" class:editable={capabilities.can_edit}>
        {capabilities.can_edit ? 'Lead edit mode' : 'View only'}
      </span>
    </div>
  </summary>

  <div class="panel-body">
    <div class="panel-header">
      <div class="hint">
        {#if capabilities.can_edit}
          Drag a team onto a scout to assign them {assignmentVerb} duty for that team. Nothing is sent until you publish.
        {:else}
          Assignments are read-only unless you are a scouting lead in Roster Studio.
        {/if}
      </div>
      <div class="actions">
        {#if capabilities.can_edit}
          <button class="btn btn-secondary" on:click={randomize} disabled={eventTeams.length === 0 || users.length === 0 || saving}>Randomize</button>
          <button class="btn btn-primary" on:click={publishAssignments} disabled={!hasDraftChanges || saving}>
            {saving ? 'Publishing...' : 'Publish Assignments'}
          </button>
        {/if}
        <button class="btn btn-outline" on:click={refreshAll} disabled={loading || saving}>Refresh</button>
      </div>
    </div>

    {#if errorMsg}
      <div class="error-note">{errorMsg}</div>
    {/if}

    {#if capabilities.can_edit && (statusMsg || hasDraftChanges)}
      <div class="status-note" class:pending={hasDraftChanges}>
        {#if hasDraftChanges}
          Draft changes pending. Publish assignments to make them live.
        {:else}
          {statusMsg}
        {/if}
      </div>
    {/if}

    {#if capabilities.can_edit}
      <section class="drag-assignment-board" aria-label="Drag and drop pit scouting assignments">
        <div class="assignment-toolbar">
          <div class="team-drag-source">
            <span>{teamSourceLabel}</span>
            <div class="team-drag-bar" aria-label="Drag an FRC team to a scout">
              {#each eventTeams as team}
                <button
                  class="team-chip"
                  class:assigned={!!assignments[team.key]?.user_id}
                  type="button"
                  draggable="true"
                  title={assignments[team.key]?.user_id ? `Assigned to ${assignments[team.key]?.user_name || 'a scout'}; drag to reassign` : 'Drag to assign'}
                  on:dragstart={(event) => startTeamDrag(event, team.key)}
                  on:dragend={finishTeamDrag}
                >
                  #{displayTeam(team.key)}
                </button>
              {/each}
              {#if !eventTeams.length}
                <span class="assignment-empty">{isPrescout ? 'Add teams in the Pre-Scouting list above.' : 'No teams loaded for this event.'}</span>
              {/if}
            </div>
          </div>
          <label class="scout-filter">
            <span>Scouts</span>
            <input class="form-input" type="search" bind:value={scoutFilter} placeholder="Filter roster" />
          </label>
        </div>

        <div class="scout-drop-grid">
          {#each filteredUsers as scout}
            <div
              class="scout-drop-zone"
              class:drop-target={dropTargetUserId === scout.id}
              role="group"
              aria-label={`Drop teams onto ${scoutDisplayName(scout)}`}
              on:dragenter={() => (dropTargetUserId = scout.id)}
              on:dragleave={() => (dropTargetUserId = '')}
              on:dragover|preventDefault
              on:drop={(event) => dropTeamOnScout(event, scout.id)}
            >
              <div class="scout-drop-name">{scoutDisplayName(scout)}</div>
              <div class="team-chip-list">
                {#each Object.entries(assignments).filter(([, value]) => value?.user_id === scout.id) as [teamKey]}
                  <span class="team-chip-wrap">
                    <button class="team-chip assigned" type="button" draggable="true" on:dragstart={(event) => startTeamDrag(event, teamKey)} on:dragend={finishTeamDrag}>
                      {displayTeam(teamKey)}
                    </button>
                    <button
                      class="chip-remove"
                      type="button"
                      title={`Remove ${displayTeam(teamKey)} - notifies ${scoutDisplayName(scout)}`}
                      aria-label={`Remove ${displayTeam(teamKey)} from ${scoutDisplayName(scout)}`}
                      disabled={saving}
                      on:click={() => removeAssignment(teamKey)}
                    >&times;</button>
                  </span>
                {/each}
                {#if !Object.entries(assignments).some(([, value]) => value?.user_id === scout.id)}
                  <span class="assignment-empty">Drop a team here</span>
                {/if}
              </div>
            </div>
          {/each}
          {#if !filteredUsers.length}
            <div class="assignment-empty">No scouts match that filter.</div>
          {/if}
        </div>
      </section>
    {/if}

    {#if !capabilities.can_edit}
      <div class="scroll-x">
        <table class="assignment-table">
          <thead>
            <tr><th>Team</th><th>Assigned scout</th></tr>
          </thead>
          <tbody>
            {#each eventTeams as team}
              <tr>
                <td class="team">#{displayTeam(team.key)}</td>
                <td class="scout">{assignments[team.key]?.user_name || '-'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</details>

<style>
  /* Accordion container */
  .assignment-accordion {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .summary-row {
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-2);
    cursor: pointer;
    padding: var(--space-3) var(--space-4);
    font-weight: 600;
    user-select: none;
  }

  .summary-row::-webkit-details-marker {
    display: none;
  }

  .summary-title {
    font-size: var(--font-md);
  }

  .summary-meta {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .mode-pill {
    font-size: var(--font-xs);
    font-weight: 600;
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-full, 9999px);
    background: var(--surface-2, rgba(0, 0, 0, 0.06));
    color: var(--text-muted);
    white-space: nowrap;
  }

  .mode-pill.editable {
    background: var(--accent-subtle, rgba(34, 197, 94, 0.12));
    color: var(--accent-strong, #16a34a);
  }

  .assignment-accordion[open] .summary-row {
    border-bottom: 1px solid var(--border);
  }

  .panel-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--gap-2);
    flex-wrap: wrap;
  }

  .hint {
    font-size: var(--font-xs);
    color: var(--text-muted);
    flex: 1;
    min-width: 0;
  }

  .actions {
    display: flex;
    gap: var(--gap-2);
    flex-wrap: wrap;
  }

  .error-note {
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-md);
    background: var(--red-soft, rgba(239, 68, 68, 0.1));
    color: var(--red-strong, #dc2626);
    font-size: var(--font-xs);
    font-weight: 500;
  }

  .status-note {
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-md);
    background: rgba(9, 62, 109, 0.08);
    color: var(--text);
    font-size: var(--font-xs);
  }

  .status-note.pending {
    background: rgba(255, 193, 7, 0.16);
  }

  .drag-assignment-board {
    display: grid;
    gap: var(--gap-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2, #f7f7f5);
  }

  .assignment-toolbar {
    display: flex;
    align-items: end;
    gap: var(--gap-2);
  }

  .team-drag-source,
  .scout-filter {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
    font-size: var(--font-xs);
    font-weight: 700;
    color: var(--text-muted);
  }

  .team-drag-source { flex: 1; }
  .scout-filter { flex: 0 1 13rem; }

  .team-drag-bar {
    display: flex;
    /* Wraps instead of scrolling sideways. A single non-wrapping row put a
       third of a 43-team event off-screen behind a horizontal scrollbar in a
       34px strip - you cannot drag a team you cannot see, and nothing
       indicated there were more. Every team is now a visible box. */
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0.3rem;
    min-height: 2.1rem;
    /* Still bounded, so a large event cannot push the drop zones off the
       page - but it scrolls in the direction the eye already expects. */
    max-height: 11rem;
    overflow-y: auto;
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
  }

  .scout-drop-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: var(--gap-2);
    max-height: 20rem;
    overflow-y: auto;
    padding-right: 0.2rem;
  }

  .scout-drop-zone {
    display: grid;
    gap: 0.25rem;
    min-height: 3.35rem;
    padding: 0.35rem 0.45rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }

  .scout-drop-zone.drop-target {
    border-color: var(--accent-strong, #b8860b);
    background: var(--accent-subtle, #fff4cf);
  }

  .scout-drop-name {
    font-size: var(--font-xs);
    font-weight: 700;
  }

  .team-chip-list {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0.2rem;
  }

  .team-chip-wrap {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }

  .chip-remove {
    min-width: 1.4rem;
    min-height: 1.9rem;
    padding: 0 0.3rem;
    border: 1px solid var(--accent-strong, #b8860b);
    border-left: 0;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: var(--surface-1);
    color: var(--red-strong, #dc2626);
    font: inherit;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }

  .chip-remove:hover { background: var(--red-soft, rgba(239, 68, 68, 0.1)); }
  .chip-remove:disabled { opacity: 0.5; cursor: not-allowed; }

  .team-chip-wrap .team-chip { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }

  .team-chip {
    min-width: 3rem;
    min-height: 1.9rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--accent-strong, #b8860b);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text);
    font: inherit;
    font-size: var(--font-xs);
    font-weight: 700;
    cursor: grab;
  }

  .team-chip:active { cursor: grabbing; }
  .team-chip.assigned { background: var(--accent-subtle, #fff4cf); }
  .assignment-empty { font-size: var(--font-xs); color: var(--text-muted); }

  .scroll-x {
    overflow-x: auto;
  }

  .assignment-table {
    border-collapse: separate;
    border-spacing: 2px;
    width: 100%;
  }

  .assignment-table th,
  .assignment-table td {
    padding: var(--space-1) var(--space-2);
    font-size: var(--font-xs);
    text-align: left;
    background: var(--color-white, #fff);
    border: 1px solid var(--border);
  }

  .assignment-table .team {
    font-weight: 700;
  }

  .assignment-table .scout {
    color: var(--text-muted);
  }

  @media (max-width: 768px) {
    .panel-header {
      flex-direction: column;
      align-items: stretch;
    }

    .actions {
      justify-content: stretch;
    }

    .actions .btn {
      flex: 1;
    }

    .summary-row {
      padding: var(--space-2) var(--space-3);
    }

    .assignment-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .scout-filter { flex-basis: auto; }
  }
</style>
