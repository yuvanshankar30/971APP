<script>
  import { onMount } from 'svelte';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { userStore } from '$lib/stores/auth.js';
  import { getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';

  let user;
  userStore.subscribe((v) => (user = v));

  export let scoutingType = 'data'; // 'data' | 'note' | 'quick'

  let panelOpen = false;
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
    return matched?.full_name || matched?.email || null;
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
      'Assignment drafts are staged locally. Publish assignments to send notifications.'
    );
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
          user_name: chosen.full_name || chosen.email
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
</script>

<details class="assignment-accordion" bind:open={panelOpen}>
  <summary class="summary-row">
    <div class="summary-title">
      {scoutingType === 'note' ? 'Note' : scoutingType === 'quick' ? 'Quick' : 'Data'} Scouting Assignments
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
          Click a team cell to stage changes. Nothing is sent to scouts until you publish assignments.
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
              {#each m.blue as t}
                <td class="cell blue" class:editable-cell={capabilities.can_edit} on:click={() => openAssign(m.key, t)}>
                  <div class="team">{displayTeam(t)}</div>
                  <div class="scout">{assignments?.[m.key]?.[t]?.user_name || '-'}</div>
                </td>
              {/each}
              {#each m.red as t}
                <td class="cell red" class:editable-cell={capabilities.can_edit} on:click={() => openAssign(m.key, t)}>
                  <div class="team">{displayTeam(t)}</div>
                  <div class="scout">{assignments?.[m.key]?.[t]?.user_name || '-'}</div>
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
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
          <option value={u.id}>{u.full_name || u.email}</option>
        {/each}
      </select>
      <div class="btn-row modal-actions">
        <button class="btn btn-primary" disabled={!selectedUserId || saving} on:click={() => saveAssignment(false)}>Stage this Match</button>
        <button class="btn btn-secondary" disabled={!selectedUserId || saving} on:click={() => saveAssignment(true)}>Stage Robot</button>
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
    padding: var(--space-1) var(--space-2);
    font-size: var(--font-xs);
    text-align: center;
    background: var(--color-white, #fff);
    border: 1px solid var(--border);
    min-width: 70px;
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

  .assignment-table .team {
    font-weight: 700;
  }

  .assignment-table .scout {
    font-size: 0.6rem;
    margin-top: var(--space-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-muted);
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
  }
</style>
