<script>
  import { onMount } from "svelte";
  import { userStore } from "$lib/stores/auth.js";
  import { getAuthHeader } from "$lib/supabase.js";
  import { fetchActiveScoutingEventKey } from "$lib/scoutingEvent.js";
  import EventTimelineEditor from "$lib/components/quickscout/EventTimelineEditor.svelte";

  let user;
  userStore.subscribe((v) => (user = v));

  const START_POSITIONS = [
    { label: "Left Trench", value: "left trench" },
    { label: "Left Mound", value: "left mound" },
    { label: "Center", value: "center" },
    { label: "Right Mound", value: "right mound" },
    { label: "Right Trench", value: "right trench" },
  ];

  const FLAGS = [
    { key: "quick_shooting", label: "Shooting" },
    { key: "quick_climbed", label: "Climbed" },
    { key: "quick_defense", label: "Defense" },
    { key: "quick_broken", label: "Broken" },
  ];

  let mode = "scout"; // scout | review

  // --- Match / team picker (originally duplicated from the Data Scouting
  // page, which has since been removed - own small page,
  // not worth a shared lib for ~40 lines, matching notescout's convention) ---
  let matches = [];
  let teamsCurrentMatch = [];
  let selectedMatchKey = "";
  let selectedMatch = null;
  let selectedTeam = "";
  let manualMatchLabel = "";
  let manualTeamInput = "";
  let loadNote = "";
  let loadingMatches = false;
  let eventKey = "";

  function teamSort(a, b) {
    const numA = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const numB = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    return numA - numB;
  }

  function displayTeam(t) {
    return t ? String(t).replace(/^frc/i, "") : "";
  }

  function normalizeTeamKey(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (raw.startsWith("frc")) return raw;
    const digits = raw.replace(/\D/g, "");
    return digits ? `frc${digits}` : raw;
  }

  function slugifyMatchLabel(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function buildManualMatch(label) {
    const trimmed = String(label || "").trim();
    const slug = slugifyMatchLabel(trimmed);
    if (!trimmed || !slug) return null;
    const numeric = parseInt(trimmed.replace(/\D/g, ""), 10);
    return {
      key: `${eventKey || "manual"}_manual_${slug}`,
      match_number: Number.isFinite(numeric) ? numeric : null,
      manual_label: trimmed,
      manual: true,
    };
  }

  function formatMatchLabel(match) {
    if (!match) return "";
    if (match.manual_label) return match.manual_label;
    const level = String(match.comp_level || "").toLowerCase();
    const setNumber = Number(match.set_number) || 1;
    const matchNumber = Number(match.match_number) || 0;
    if (level === "pm") return `Practice ${matchNumber}`;
    if (level === "qm") return `Qual ${matchNumber}`;
    if (level === "ef") return `Eighthfinal ${setNumber}-${matchNumber}`;
    if (level === "qf") return `Quarterfinal ${setNumber}-${matchNumber}`;
    if (level === "sf") return `Semifinal ${setNumber}-${matchNumber}`;
    if (level === "f") return `Final ${matchNumber}`;
    return match.key?.split("_").pop() || match.key || "";
  }

  async function authFetch(url, options = {}) {
    const headers = { ...(options.headers || {}), ...(await getAuthHeader()) };
    return fetch(url, { ...options, headers });
  }

  async function fetchMatches() {
    loadNote = "";
    eventKey = (await fetchActiveScoutingEventKey()) || "";
    if (!eventKey) {
      loadNote = "No event configured.";
      return;
    }
    loadingMatches = true;
    try {
      const res = await fetch(
        `/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`,
      );
      const js = await res.json().catch(() => null);
      if (!res.ok || !js?.success) {
        loadNote = js?.error || `Failed to load matches (${res.status})`;
        return;
      }
      matches = (js.data || []).slice();
    } catch (e) {
      loadNote = e.message || "Load error";
    } finally {
      loadingMatches = false;
    }
  }

  function onSelectMatchByKey() {
    if (selectedMatchKey === "__manual__") {
      selectedMatch = buildManualMatch(manualMatchLabel);
      const teamKey = normalizeTeamKey(manualTeamInput);
      teamsCurrentMatch = teamKey ? [teamKey] : [];
      selectedTeam = teamKey;
    } else {
      const m = matches.find((x) => x.key === selectedMatchKey);
      selectedMatch = m || null;
      if (m) {
        teamsCurrentMatch = [
          ...(m.alliances?.red?.team_keys || []),
          ...(m.alliances?.blue?.team_keys || []),
        ].sort(teamSort);
        selectedTeam = teamsCurrentMatch[0] || "";
      } else {
        teamsCurrentMatch = [];
        selectedTeam = "";
      }
    }
    resetSessionState();
    if (mode === "review") loadReviewEvents();
  }

  $: if (selectedMatchKey === "__manual__") {
    selectedMatch = buildManualMatch(manualMatchLabel);
    const teamKey = normalizeTeamKey(manualTeamInput);
    teamsCurrentMatch = teamKey ? [teamKey] : [];
    selectedTeam = teamKey;
  }

  // --- assignment (scouting_type: 'quick') ---
  let myQuickAssignments = {};

  function assignmentLookupKey(matchKey, teamKey) {
    return `${matchKey}::${teamKey}`;
  }

  function isMyAssignedRobot(matchKey, teamKey) {
    return !!myQuickAssignments[assignmentLookupKey(matchKey, teamKey)];
  }

  async function loadMyAssignments() {
    if (!user?.id) {
      myQuickAssignments = {};
      return;
    }
    try {
      const res = await authFetch(
        `/api/scout-assignments?scouting_type=quick&mine=1&user_id=${encodeURIComponent(user.id)}`,
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
      const next = {};
      for (const row of data.data || []) {
        if (row?.completed_at) continue;
        next[assignmentLookupKey(row.match_key, row.team_key)] = true;
      }
      myQuickAssignments = next;
    } catch {
      myQuickAssignments = {};
    }
  }

  async function completeMyAssignment(matchKey, teamKey) {
    if (!user?.id || !isMyAssignedRobot(matchKey, teamKey)) return;
    try {
      await authFetch("/api/scout-assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          scouting_type: "quick",
          match_key: matchKey,
          team_key: teamKey,
          user_id: user.id,
        }),
      });
      await loadMyAssignments();
    } catch {
      // scouted data already saved - a failed "mark complete" isn't worth blocking on
    }
  }

  // --- recording ---
  let startPosition = "";
  let holdTimers = {};
  let scoutingEvents = []; // this session's quick_* rows
  let sessionStartedAt = null;
  let finished = false;

  function resetSessionState() {
    startPosition = "";
    holdTimers = {};
    scoutingEvents = [];
    sessionStartedAt = null;
    finished = false;
  }

  async function record(event_type, event_value) {
    if (!selectedMatch || !selectedTeam) return;
    if (!sessionStartedAt) sessionStartedAt = new Date().toISOString();
    const payload = {
      action: "record-event",
      match_key: selectedMatch.key,
      match_number: selectedMatch.match_number,
      team_key: selectedTeam,
      event_type,
      event_value,
      user_id: user?.id || null,
    };

    const tempEvent = { ...payload, created_at: new Date().toISOString() };
    scoutingEvents = [...scoutingEvents, tempEvent];

    try {
      const res = await fetch("/datascout", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await getAuthHeader()) },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data?.success) {
        console.error("Failed to save quick-scout event", data?.error);
      } else if (data.data?.id) {
        const idx = scoutingEvents.findIndex(
          (e) => e.created_at === tempEvent.created_at && e.event_type === tempEvent.event_type,
        );
        if (idx !== -1) {
          scoutingEvents[idx].id = data.data.id;
          scoutingEvents = [...scoutingEvents];
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  function startAction(actionName, value) {
    const key = `${actionName}_${value}`;
    if (holdTimers[key]) return;
    record(`${actionName}_start`, value);
    holdTimers = { ...holdTimers, [key]: true };
  }

  function endAction(actionName, value) {
    const key = `${actionName}_${value}`;
    if (!holdTimers[key]) return;
    record(`${actionName}_end`, value);
    const next = { ...holdTimers };
    delete next[key];
    holdTimers = next;
  }

  function toggleFlag(flagKey) {
    if (holdTimers[`${flagKey}_on`]) endAction(flagKey, "on");
    else startAction(flagKey, "on");
  }

  function chooseStart(pos) {
    startPosition = pos;
    record("quick_auto_start_position", pos);
  }

  async function finishMatch() {
    for (const f of FLAGS) {
      if (holdTimers[`${f.key}_on`]) endAction(f.key, "on");
    }
    finished = true;
    if (selectedMatch && selectedTeam) {
      await completeMyAssignment(selectedMatch.key, selectedTeam);
    }
  }

  function scoutAnother() {
    resetSessionState();
  }

  // live update of an in-progress event's timestamp (drag-to-edit during
  // review, or immediately after finishing to fix a mistimed tap)
  async function updateEventTimestamp(id, isoTimestamp) {
    const idx = scoutingEvents.findIndex((e) => e.id === id);
    if (idx !== -1) {
      scoutingEvents[idx] = { ...scoutingEvents[idx], created_at: isoTimestamp };
      scoutingEvents = [...scoutingEvents];
    }
    const rIdx = reviewEvents.findIndex((e) => e.id === id);
    if (rIdx !== -1) {
      reviewEvents[rIdx] = { ...reviewEvents[rIdx], created_at: isoTimestamp };
      reviewEvents = [...reviewEvents];
    }
    try {
      await fetch("/datascout", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await getAuthHeader()) },
        body: JSON.stringify({ action: "update-event-timestamp", id, created_at: isoTimestamp }),
      });
    } catch (e) {
      console.error("Failed to update event timestamp", e);
    }
  }

  // --- review mode: look at (and edit) a past quick-scout entry ---
  let reviewEvents = [];
  let reviewLoading = false;
  let reviewNote = "";

  async function loadReviewEvents() {
    if (!selectedMatch || !selectedTeam) {
      reviewEvents = [];
      return;
    }
    reviewLoading = true;
    reviewNote = "";
    try {
      const res = await authFetch(
        `/datascout?team_key=${encodeURIComponent(selectedTeam)}&match_key=${encodeURIComponent(selectedMatch.key)}`,
      );
      const js = await res.json().catch(() => null);
      if (!res.ok || !js?.success) throw new Error(js?.error || "Failed to load");
      reviewEvents = (js.data || []).filter((e) => String(e.event_type || "").startsWith("quick_"));
      if (reviewEvents.length === 0) reviewNote = "No Quick Scout data recorded for this robot yet.";
    } catch (e) {
      reviewNote = e.message || "Failed to load";
      reviewEvents = [];
    } finally {
      reviewLoading = false;
    }
  }

  function setMode(next) {
    mode = next;
    if (mode === "review") loadReviewEvents();
  }

  $: startPositionLabel = START_POSITIONS.find((p) => p.value === startPosition)?.label || "";

  onMount(() => {
    fetchMatches();
    loadMyAssignments();
  });
</script>

<svelte:head>
  <title>Quick Scout</title>
</svelte:head>

<div class="quickscout-page">
  <div class="page-header">
    <h2>Quick Scout</h2>
    <p class="muted">
      Position + four toggles - a fast, lightweight way to scout a match. Used to estimate each
      robot's share of the alliance score against real match results.
    </p>
  </div>

  <div class="mode-toggle btn-row">
    <button class="btn {mode === 'scout' ? 'btn-selected' : 'btn-outline'}" on:click={() => setMode('scout')}>
      Scout
    </button>
    <button class="btn {mode === 'review' ? 'btn-selected' : 'btn-outline'}" on:click={() => setMode('review')}>
      Review / Edit
    </button>
  </div>

  <div class="card picker-card">
    {#if loadNote}<p class="muted">{loadNote}</p>{/if}
    <div class="picker-row">
      <label class="form-label" for="qs-match">
        Match
        <select id="qs-match" class="form-select" bind:value={selectedMatchKey} on:change={onSelectMatchByKey} disabled={loadingMatches}>
          <option value="">-- Select match --</option>
          {#each matches as m}
            <option value={m.key}>{formatMatchLabel(m)}</option>
          {/each}
          <option value="__manual__">Manual / unofficial match...</option>
        </select>
      </label>

      {#if selectedMatchKey === "__manual__"}
        <label class="form-label" for="qs-manual-match">
          Match label
          <input id="qs-manual-match" class="form-input" bind:value={manualMatchLabel} placeholder="e.g. Practice 3" />
        </label>
        <label class="form-label" for="qs-manual-team">
          Team
          <input id="qs-manual-team" class="form-input" bind:value={manualTeamInput} placeholder="e.g. 971" />
        </label>
      {:else if teamsCurrentMatch.length > 0}
        <label class="form-label" for="qs-team">
          Team
          <select id="qs-team" class="form-select" bind:value={selectedTeam} on:change={() => { resetSessionState(); if (mode === 'review') loadReviewEvents(); }}>
            {#each teamsCurrentMatch as t}
              <option value={t}>{displayTeam(t)}{isMyAssignedRobot(selectedMatch?.key, t) ? ' (assigned to me)' : ''}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  </div>

  {#if !selectedMatch || !selectedTeam}
    <p class="muted">Pick a match and team to get started.</p>
  {:else if mode === "scout"}
    <div class="card">
      <h3>{formatMatchLabel(selectedMatch)} — Team {displayTeam(selectedTeam)}</h3>

      {#if !finished}
        <div class="scout-section">
          <span class="label">Starting Position</span>
          <div class="btn-row">
            {#each START_POSITIONS as p}
              <button
                class="btn {startPosition === p.value ? 'btn-selected' : 'btn-outline'} big-btn"
                on:click={() => chooseStart(p.value)}
              >{p.label}</button>
            {/each}
          </div>
        </div>

        <div class="scout-section">
          <span class="label">During the Match (tap to toggle)</span>
          <div class="flag-grid">
            {#each FLAGS as f}
              <button
                class="btn {holdTimers[`${f.key}_on`] ? 'btn-selected-active' : 'btn-outline'} big-btn flag-btn"
                on:click={() => toggleFlag(f.key)}
              >{f.label}{holdTimers[`${f.key}_on`] ? ' — ON' : ''}</button>
            {/each}
          </div>
        </div>

        <div class="scout-section">
          <span class="label">Live Timeline</span>
          <EventTimelineEditor events={scoutingEvents} startedAt={sessionStartedAt} editable={true} onUpdate={updateEventTimestamp} />
        </div>

        <button class="btn btn-success action-btn full-width" on:click={finishMatch}>
          Finish Match
        </button>
      {:else}
        <p class="muted">
          Saved. Started at <strong>{startPositionLabel || 'no position recorded'}</strong>.
          You can still drag the timeline below to correct a mistimed tap.
        </p>
        <EventTimelineEditor events={scoutingEvents} startedAt={sessionStartedAt} editable={true} onUpdate={updateEventTimestamp} />
        <button class="btn btn-outline action-btn full-width" on:click={scoutAnother}>
          Scout Another Robot
        </button>
      {/if}
    </div>
  {:else}
    <div class="card">
      <h3>{formatMatchLabel(selectedMatch)} — Team {displayTeam(selectedTeam)}</h3>
      {#if reviewLoading}
        <p class="muted">Loading...</p>
      {:else if reviewNote}
        <p class="muted">{reviewNote}</p>
      {:else}
        <EventTimelineEditor events={reviewEvents} editable={true} onUpdate={updateEventTimestamp} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .quickscout-page {
    max-width: 900px;
    margin: 0 auto;
    padding: var(--space-4, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 1.25rem);
  }
  .page-header h2 { margin: 0 0 var(--space-2, 0.5rem); }
  .mode-toggle { gap: var(--gap-2, 0.5rem); }
  .picker-card { padding: var(--space-4, 1rem); }
  .picker-row { display: flex; flex-wrap: wrap; gap: var(--gap-4, 1rem); align-items: flex-end; }
  .scout-section { margin-bottom: var(--space-5, 1.25rem); }
  .label {
    display: block;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-muted, #888);
    margin-bottom: var(--space-2, 0.5rem);
  }
  .big-btn { min-height: 3rem; font-size: 1rem; }
  .flag-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--gap-2, 0.5rem);
  }
  .flag-btn { font-weight: 600; }
  .btn-selected {
    background: var(--secondary, #222);
    color: var(--primary, #fff);
    border-color: var(--secondary, #222);
  }
  .btn-selected-active {
    background: var(--accent, #3a7);
    color: var(--on-primary, #fff);
    border-color: var(--accent, #3a7);
  }
  .full-width { width: 100%; }
  .action-btn { margin-top: var(--space-3, 0.75rem); }
</style>
