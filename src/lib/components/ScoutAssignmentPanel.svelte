<script>
  import { onMount } from 'svelte';
  import { scoutDisplayName } from '$lib/scoutNames.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { userStore } from '$lib/stores/auth.js';
  import { getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';

  let user;
  userStore.subscribe((v) => (user = v));

  export let scoutingType = 'data'; // 'data' | 'note' | 'quick'
  export let open = false;

  let panelOpen = open;
  $: panelOpen = open;
  let matches = []; // { key, red:[], blue:[] }
  let eventKey = '';
  let publishedAssignments = {}; // match_key -> team_key -> { user_id, user_name }
  let assignments = {}; // match_key -> team_key -> { user_id, user_name }
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

  let showModal = false;
  let modalContext = { match_key: '', team_key: '', team_number: '' };
  let selectedUserId = '';
  let lastUserId = null;
  let draggingTeamKey = '';
  let dropTargetUserId = '';
  let dragClientX = 0;
  let dragClientY = 0;
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
    for (const [matchKey, teamMap] of Object.entries(map || {})) {
      next[matchKey] = {};
      for (const [teamKey, value] of Object.entries(teamMap || {})) {
        next[matchKey][teamKey] = { ...value };
      }
    }
    return next;
  }

  function serializeAssignments(map) {
    return Object.entries(map || {})
      .flatMap(([matchKey, teamMap]) =>
        Object.entries(teamMap || {}).map(
          ([teamKey, value]) => `${matchKey}::${teamKey}::${value?.user_id || ''}`
        )
      )
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

  function stageSingleAssignment(matchKey, teamKey, userId) {
    const nextAssignments = cloneAssignments(assignments);
    if (!nextAssignments[matchKey]) nextAssignments[matchKey] = {};
    nextAssignments[matchKey][teamKey] = {
      user_id: userId,
      user_name: findUserName(userId) || assignments?.[matchKey]?.[teamKey]?.user_name || null
    };
    stageAssignments(
      nextAssignments,
      'Assignment drafts are staged locally. Publish when the assignments are ready.'
    );
  }

  function stageRobotAssignment(teamKey, userId) {
    if (!teamKey || !userId || !capabilities.can_edit) return;
    const nextAssignments = cloneAssignments(assignments);
    let matchCount = 0;

    for (const match of matches) {
      if (!match.blue.includes(teamKey) && !match.red.includes(teamKey)) continue;
      if (!nextAssignments[match.key]) nextAssignments[match.key] = {};
      nextAssignments[match.key][teamKey] = {
        user_id: userId,
        user_name: findUserName(userId) || null
      };
      matchCount += 1;
    }

    if (matchCount) {
      stageAssignments(
        nextAssignments,
        `Team ${displayTeam(teamKey)} is staged for ${findUserName(userId) || 'that scout'} across ${matchCount} match${matchCount === 1 ? '' : 'es'}. Publish when the assignments are ready.`
      );
    }
  }

  function startTeamDrag(event, teamKey) {
    if (!capabilities.can_edit || !teamKey) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    draggingTeamKey = teamKey;
    dragClientX = event.clientX;
    dragClientY = event.clientY;
  }

  function updateTeamDrag(event) {
    if (!draggingTeamKey) return;
    dragClientX = event.clientX;
    dragClientY = event.clientY;
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const zone = hovered?.closest?.('[data-scout-drop-user]');
    dropTargetUserId = zone?.dataset?.scoutDropUser || '';
  }

  function finishTeamDrag() {
    draggingTeamKey = '';
    dropTargetUserId = '';
  }

  function finishPointerTeamDrag(event) {
    if (!draggingTeamKey) return;
    updateTeamDrag(event);
    if (dropTargetUserId) stageRobotAssignment(draggingTeamKey, dropTargetUserId);
    finishTeamDrag();
  }

  async function loadCapabilities() {
    try {
      const qs = new URLSearchParams({ scouting_type: scoutingType, capabilities: '1' });
      const res = await authFetch(`/api/scout-assignments?${qs}`);
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
      const qs = new URLSearchParams({ scouting_type: scoutingType, eligible: '1' });
      const res = await authFetch(`/api/scout-assignments?${qs}`);
      const data = await res.json();
      if (data?.success) {
        users = data.data || [];
      }
    } catch {
      users = [];
    }
  }

  async function loadMatches() {
    eventKey = (await fetchActiveScoutingEventKey()) || '';
    if (!eventKey) {
      errorMsg = 'No event configured';
      return;
    }

    try {
      loading = true;
      errorMsg = '';
      const res = await fetch(
        `/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=qm`
      );

      let data;
      try {
        data = await res.json();
      } catch {
        const text = await res.text();
        errorMsg = `Non-JSON response (${res.status}): ${text.slice(0, 100)}`;
        return;
      }

      if (!data?.success) {
        errorMsg = data?.error || 'Failed to load matches';
        return;
      }

      matches = (data.data || []).map((m) => ({
        key: m.key,
        match_number: m.match_number,
        red: m.alliances?.red?.team_keys || [],
        blue: m.alliances?.blue?.team_keys || []
      }));
    } catch (e) {
      errorMsg = e.message || 'Load error';
    } finally {
      loading = false;
    }
  }

  async function loadAssignments() {
    try {
      const qs = new URLSearchParams({ scouting_type: scoutingType });
      const res = await authFetch(`/api/scout-assignments?${qs}`);
      const data = await res.json();
      if (!data?.success) return;

      const nextAssignments = {};
      for (const row of data.data || []) {
        if (!nextAssignments[row.match_key]) nextAssignments[row.match_key] = {};
        nextAssignments[row.match_key][row.team_key] = {
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

  function openAssign(match_key, team_key) {
    if (!capabilities.can_edit) return;
    modalContext = { match_key, team_key, team_number: displayTeam(team_key) };
    selectedUserId = assignments?.[match_key]?.[team_key]?.user_id || '';
    showModal = true;
  }

  function saveAssignment(applyToAll = false) {
    if (!selectedUserId || !capabilities.can_edit) return;

    if (applyToAll) {
      const team_key = modalContext.team_key;
      const nextAssignments = cloneAssignments(assignments);
      let foundMatch = false;

      for (const m of matches) {
        if ((m.blue || []).includes(team_key) || (m.red || []).includes(team_key)) {
          if (!nextAssignments[m.key]) nextAssignments[m.key] = {};
          nextAssignments[m.key][team_key] = {
            user_id: selectedUserId,
            user_name: findUserName(selectedUserId) || null
          };
          foundMatch = true;
        }
      }

      if (!foundMatch) {
        alert('No matches found for that robot');
        return;
      }

      stageAssignments(
        nextAssignments,
        'Robot assignment drafts updated. Publish assignments to send notifications.'
      );
      showModal = false;
      return;
    }

    stageSingleAssignment(modalContext.match_key, modalContext.team_key, selectedUserId);
    showModal = false;
  }

  // Unlike saveAssignment (a local draft, only sent on Publish), this is
  // immediate - direct instruction: removing someone should notify them
  // right away, not sit as an unpublished draft they never find out about.
  async function removeAssignment() {
    if (!capabilities.can_edit || saving) return;
    const { match_key, team_key } = modalContext;
    if (!match_key || !team_key) return;
    saving = true;
    errorMsg = '';
    try {
      const res = await authFetch('/api/scout-assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unassign', scouting_type: scoutingType, match_key, team_key })
      });
      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || 'unknown');
      await loadAssignments();
      statusMsg = `Team ${modalContext.team_number} unassigned.`;
      showModal = false;
    } catch (e) {
      errorMsg = `Remove failed: ${e.message}`;
    } finally {
      saving = false;
    }
  }

  // The x on a team chip in a scout's drop zone unassigns that whole robot
  // (every one of its scheduled matches currently owned by that scout) in
  // one click, instead of opening the per-match modal once per match -
  // same immediate, notify-right-away behaviour as removeAssignment above.
  async function removeRobotAssignment(teamKey) {
    if (!capabilities.can_edit || saving || !teamKey) return;
    const matchKeys = matches
      .filter((match) => match.blue.includes(teamKey) || match.red.includes(teamKey))
      .map((match) => match.key);
    if (!matchKeys.length) return;
    saving = true;
    errorMsg = '';
    try {
      for (const matchKey of matchKeys) {
        const res = await authFetch('/api/scout-assignments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'unassign', scouting_type: scoutingType, match_key: matchKey, team_key: teamKey })
        });
        const data = await res.json();
        if (!data?.success) throw new Error(data?.error || 'unknown');
      }
      await loadAssignments();
      statusMsg = `Team ${displayTeam(teamKey)} unassigned.`;
    } catch (e) {
      errorMsg = `Remove failed: ${e.message}`;
    } finally {
      saving = false;
    }
  }

  function randomize() {
    if (!capabilities.can_edit) return;

    const eligible = [...users];
    if (eligible.length === 0) return;

    const newAssignments = {};
    for (const m of matches) {
      const usedInMatch = new Set();
      const teams = [...m.blue, ...m.red];
      for (const t of teams) {
        const shuffled = [...eligible].sort(() => Math.random() - 0.5);
        const u = shuffled.find((x) => !usedInMatch.has(x.id));
        const chosen = u || shuffled[0];
        usedInMatch.add(chosen.id);

        if (!newAssignments[m.key]) newAssignments[m.key] = {};
        newAssignments[m.key][t] = {
          user_id: chosen.id,
          user_name: scoutDisplayName(chosen)
        };
      }
    }

    stageAssignments(
      newAssignments,
      'Randomized assignments are staged locally. Publish assignments when ready.'
    );
  }

  async function bulkPersist(map) {
    const list = [];
    for (const mk of Object.keys(map || {})) {
      for (const tk of Object.keys(map[mk] || {})) {
        const userId = map[mk][tk]?.user_id;
        if (!userId) continue;
        list.push({ match_key: mk, team_key: tk, user_id: userId });
      }
    }

    if (list.length === 0) {
      statusMsg = 'No assignments to publish.';
      return;
    }

    saving = true;
    try {
      const body = { action: 'bulk-assign', scouting_type: scoutingType, items: list };
      const res = await authFetch('/api/scout-assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (!data?.success) {
        throw new Error(data?.error || 'unknown');
      } else {
        await loadAssignments();
        statusMsg = 'Assignments published.';
      }
    } catch (e) {
      errorMsg = `Publish failed: ${e.message}`;
    } finally {
      saving = false;
    }
  }

  async function publishAssignments() {
    if (!capabilities.can_edit || !hasDraftChanges || saving) return;
    errorMsg = '';
    await bulkPersist(assignments);
  }

  async function refreshAll({ force = false } = {}) {
    if (!force && hasDraftChanges) {
      const discard = await requestConfirmation({
        title: 'Discard assignment drafts',
        message: 'Discard unpublished scouting assignment drafts and reload the published assignments?',
        confirmLabel: 'Discard drafts',
        danger: true
      });
      if (!discard) return;
    }

    await loadCapabilities();
    await Promise.all([loadMatches(), loadAssignments()]);
    await loadEligibleUsers();
  }

  onMount(() => {
    refreshAll({ force: true });
  });

  $: if (user?.id && user.id !== lastUserId) {
    lastUserId = user.id;
    refreshAll({ force: true });
  }

  $: hasDraftChanges =
    serializeAssignments(assignments) !== serializeAssignments(publishedAssignments);
  $: scheduledTeamKeys = [...new Set(matches.flatMap((match) => [...match.blue, ...match.red]))]
    .sort((a, b) => Number(displayTeam(a)) - Number(displayTeam(b)));
  $: teamOwner = scheduledTeamKeys.reduce((owners, teamKey) => {
    const ownerIds = new Set(
      matches
        .filter((match) => match.blue.includes(teamKey) || match.red.includes(teamKey))
        .map((match) => assignments?.[match.key]?.[teamKey]?.user_id)
        .filter(Boolean)
    );
    owners[teamKey] = ownerIds.size === 1 ? [...ownerIds][0] : '';
    return owners;
  }, {});
  $: filteredUsers = users.filter((scout) => {
    const name = `${scout.full_name || ''} ${scout.email || ''}`.toLowerCase();
    return name.includes(scoutFilter.trim().toLowerCase());
  });
</script>

<svelte:window on:pointermove={updateTeamDrag} on:pointerup={finishPointerTeamDrag} on:pointercancel={finishTeamDrag} />

<details class="assignment-accordion" bind:open={panelOpen}>
  <summary class="summary-row">
    <div class="summary-title">
      {scoutingType === 'note' ? 'Note' : scoutingType === 'quick' ? 'Quick' : 'Match'} Scouting Assignments
    </div>
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
          Select a team, then drag it onto a scout to stage that robot across its scheduled matches. Nothing is sent until you publish.
        {:else}
          Assignments are read-only unless you are a scouting lead in Roster Studio.
        {/if}
      </div>
      <div class="actions">
        {#if capabilities.can_edit}
          <button class="btn btn-secondary" on:click={randomize} disabled={matches.length === 0 || users.length === 0 || saving}>Randomize</button>
          <button class="btn btn-primary" on:click={publishAssignments} disabled={!hasDraftChanges || saving}>
            {saving ? 'Publishing...' : 'Publish Assignments'}
          </button>
        {/if}
        <button class="btn btn-outline" on:click={() => refreshAll()} disabled={loading || saving}>Refresh</button>
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
      <section class="drag-assignment-board" aria-label="Drag and drop scouting assignments">
        <div class="assignment-toolbar">
          <div class="team-drag-source">
            <span>FRC teams</span>
            <div class="team-drag-bar" aria-label="Drag an FRC team to a scout">
              {#each scheduledTeamKeys as teamKey}
                <button
                  class="team-chip"
                  class:assigned={!!teamOwner[teamKey]}
                  class:dragging={draggingTeamKey === teamKey}
                  type="button"
                  title={teamOwner[teamKey] ? `Assigned to ${findUserName(teamOwner[teamKey]) || 'a scout'}; drag to reassign` : 'Drag to assign'}
                  on:pointerdown={(event) => startTeamDrag(event, teamKey)}
                >
                  #{displayTeam(teamKey)}
                </button>
              {/each}
              {#if !scheduledTeamKeys.length}
                <!-- Silence here read as "there is nothing to drag and no
                     reason given". The teams on this board come from the
                     match schedule, so an empty schedule means an empty bar -
                     say that rather than rendering a blank strip above a grid
                     of drop zones. -->
                <span class="assignment-empty">
                  No teams to drag - this board lists the teams in the match schedule, and no schedule is loaded for this event yet.
                </span>
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
              data-scout-drop-user={scout.id}
              aria-label={`Drop teams onto ${scoutDisplayName(scout)}`}
            >
              <div class="scout-drop-name">{scoutDisplayName(scout)}</div>
              <div class="team-chip-list">
                {#each scheduledTeamKeys.filter((teamKey) => teamOwner[teamKey] === scout.id) as teamKey}
                  <span class="team-chip-wrap">
                    <button class="team-chip assigned" class:dragging={draggingTeamKey === teamKey} type="button" on:pointerdown={(event) => startTeamDrag(event, teamKey)}>
                      {displayTeam(teamKey)}
                    </button>
                    <button
                      class="chip-remove"
                      type="button"
                      title={`Unassign team ${displayTeam(teamKey)} - notifies ${scoutDisplayName(scout)}`}
                      aria-label={`Unassign team ${displayTeam(teamKey)} from ${scoutDisplayName(scout)}`}
                      disabled={saving}
                      on:click={() => removeRobotAssignment(teamKey)}
                    >&times;</button>
                  </span>
                {/each}
                {#if !scheduledTeamKeys.some((teamKey) => teamOwner[teamKey] === scout.id)}
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

    {#if draggingTeamKey}
      <div class="team-drag-ghost" style={`left:${dragClientX + 12}px;top:${dragClientY + 12}px`} aria-hidden="true">#{displayTeam(draggingTeamKey)}</div>
    {/if}

    <details class="table-accordion">
      <summary>Match-by-match table ({matches.length} match{matches.length === 1 ? '' : 'es'})</summary>
      <div class="scroll-x">
        <table class="assignment-table">
          <thead>
            <tr>
              <th colspan="3" class="alliance blue">Blue Alliance</th>
              <th colspan="3" class="alliance red">Red Alliance</th>
            </tr>
            <tr>
              {#each [1, 2, 3] as i}<th class="blue">B{i}</th>{/each}
              {#each [1, 2, 3] as i}<th class="red">R{i}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each matches as m}
              <tr>
                {#each m.blue as t, i}
                  <td data-label={`Blue ${i + 1}`} class="cell blue" class:editable-cell={capabilities.can_edit} on:click={() => openAssign(m.key, t)}>
                    <span class="team">#{displayTeam(t)}</span><span class="scout">{assignments?.[m.key]?.[t]?.user_name || '-'}</span>
                  </td>
                {/each}
                {#each m.red as t, i}
                  <td data-label={`Red ${i + 1}`} class="cell red" class:editable-cell={capabilities.can_edit} on:click={() => openAssign(m.key, t)}>
                    <span class="team">#{displayTeam(t)}</span><span class="scout">{assignments?.[m.key]?.[t]?.user_name || '-'}</span>
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  </div>
</details>

{#if showModal}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close assignment dialog"
    on:click|self={() => {
      if (!saving) showModal = false;
    }}
    on:keydown={(e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!saving) showModal = false;
      }
    }}
  >
    <div class="modal" style="--modal-width: 360px;" role="dialog" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
      <h4>Assign Scout - {modalContext.team_number}</h4>
      <select class="form-select" bind:value={selectedUserId} disabled={saving}>
        <option value="">-- choose user --</option>
        {#each users as u}
          <option value={u.id}>{scoutDisplayName(u)}</option>
        {/each}
      </select>
      <div class="btn-row modal-actions">
        <button class="btn btn-primary" disabled={!selectedUserId || saving} on:click={() => saveAssignment(false)}>Stage this Match</button>
        <button class="btn btn-secondary" disabled={!selectedUserId || saving} on:click={() => saveAssignment(true)}>Stage Robot</button>
        {#if publishedAssignments?.[modalContext.match_key]?.[modalContext.team_key]?.user_id}
          <button class="btn btn-danger" disabled={saving} title="Removes the assignment and notifies the scout right away" on:click={removeAssignment}>Remove Assignment</button>
        {/if}
        <button class="btn btn-outline" on:click={() => {
          if (!saving) showModal = false;
        }}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Accordion container */
  .assignment-accordion {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  /* Summary row (collapsed header) */
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

  /* Open state border */
  .assignment-accordion[open] .summary-row {
    border-bottom: 1px solid var(--border);
  }

  /* Panel body */
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
    touch-action: none;
  }

  .team-chip:active { cursor: grabbing; }
  .team-chip.dragging { opacity: 0.4; }
  .team-chip.assigned { background: var(--accent-subtle, #fff4cf); }
  .assignment-empty { font-size: var(--font-xs); color: var(--text-muted); }
  .team-drag-ghost {
    position: fixed;
    z-index: 1000;
    min-width: 2.35rem;
    min-height: 1.7rem;
    padding: 0.1rem 0.35rem;
    border: 1px solid var(--accent-strong, #b8860b);
    border-radius: var(--radius-sm);
    background: var(--accent-subtle, #fff4cf);
    color: var(--text);
    font-size: var(--font-xs);
    font-weight: 700;
    pointer-events: none;
    box-shadow: var(--shadow-md);
  }

  /* Assignment table */
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
    padding: 3px var(--space-2);
    font-size: var(--font-xs);
    text-align: center;
    background: var(--color-white, #fff);
    border: 1px solid var(--border);
    min-width: 70px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .assignment-table th.alliance {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .assignment-table .blue {
    background: var(--blue-soft);
  }

  .assignment-table .red {
    background: var(--red-soft);
  }

  /* Team and scout used to stack on two lines per cell, roughly doubling
     the height of an already very tall (one row per match) table. One line
     per cell - "#123 · Name" - keeps every cell readable at a fraction of
     the height, which is the point of compacting this table at all. */
  .assignment-table .team {
    font-weight: 700;
  }

  .assignment-table .scout {
    font-size: 0.62rem;
    color: var(--text-muted);
  }

  .assignment-table .scout::before {
    content: ' · ';
  }

  .editable-cell {
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .editable-cell:hover {
    filter: brightness(0.93);
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

  /* The 6-column Blue/Red alliance grid (each td already a min-width:70px
     table cell, 6 of them a guaranteed 420px+ floor) becomes one card per
     match below phone width, its six alliance slots stacked in the same
     blue-then-red order instead of packed into columns too narrow to read.
     A data-label attribute on each <td> (see markup) supplies "Blue 1" /
     "Red 2" etc since the real header rows are hidden here. */
  @media (max-width: 640px) {
    .scroll-x { overflow-x: visible; }
    .assignment-table thead { display: none; }
    .assignment-table, .assignment-table tbody, .assignment-table tr, .assignment-table td {
      display: block;
      width: 100%;
      min-width: 0;
    }
    .assignment-table tr {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: var(--space-2);
      overflow: hidden;
    }
    .assignment-table td {
      text-align: left;
      border: 0;
      border-bottom: 1px solid var(--border);
      padding: var(--space-2) var(--space-3);
    }
    .assignment-table tr td:last-child { border-bottom: 0; }
    .assignment-table td::before {
      content: attr(data-label);
      display: block;
      color: var(--text-muted);
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 2px;
    }
    .assignment-table td {
      white-space: normal;
    }
  }

  /* Collapsed by default - a full event's match list here is one row per
     scheduled qualification match (dozens at a real event), which dwarfed
     the rest of the page. The drag-and-drop board above already covers
     assigning; this table is the detailed read/override view underneath. */
  .table-accordion {
    margin-top: var(--gap-2);
  }

  .table-accordion > summary {
    cursor: pointer;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2, #f7f7f5);
    font-size: var(--font-xs);
    font-weight: 700;
    color: var(--text-muted);
    list-style: none;
    user-select: none;
  }

  .table-accordion > summary::-webkit-details-marker {
    display: none;
  }

  .table-accordion > summary::before {
    content: '▸ ';
  }

  .table-accordion[open] > summary::before {
    content: '▾ ';
  }

  .table-accordion .scroll-x {
    margin-top: var(--gap-2);
  }
</style>
