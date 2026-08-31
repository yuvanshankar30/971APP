<script>
  import { onMount, tick } from "svelte";
  import { userStore } from "$lib/stores/auth.js";
  import { getAuthHeader } from "$lib/supabase.js";
  import { fetchActiveScoutingEventKey, fetchAvailableScoutingEvents } from "$lib/scoutingEvent.js";
  import { fuelCountFromEvents } from "$lib/scoutingStats.js";
  import SeasonFilter from "$lib/components/SeasonFilter.svelte";
  import { BarChart3, FileText, RefreshCw } from "lucide-svelte";

  let user;
  userStore.subscribe((v) => (user = v));

  // Match / Team State
  let matches = [];
  let teamsCurrentMatch = [];
  let eventTeams = [];
  let selectedMatchKey = "";
  let selectedMatch = null;
  let selectedTeam = "";
  let manualMatchLabel = "";
  let manualTeamInput = "";
  let loadNote = "";
  let loadingMatches = false;
  let eventKey = ""; // globally active scouting event
  let selectedEventKey = null; // event being browsed, if different from active
  let availableEvents = [];
  let lastLoadedMatchesEventKey = null;

  // Every downstream fetch (TBA matches, Statbotics EPAs, manual match keys)
  // should use this, not the raw active eventKey - blank selectedEventKey
  // means "track whatever event is currently active."
  $: resolvedEventKey = selectedEventKey || eventKey;
  $: isViewingPastEvent = !!selectedEventKey && selectedEventKey !== eventKey;

  // Power ranking (TBA OPR) - fetched once per event alongside matches,
  // same endpoint /scouting already uses for the team-comparison table.
  // Keyed by team NUMBER (matches the old Statbotics key shape this
  // replaced - see issue #80), not "frcNNNN".
  let teamEPAs = new Map();
  $: selectedTeamEPA = selectedTeam
    ? teamEPAs.get(parseInt(String(selectedTeam).replace(/^frc/i, ""), 10))
    : null;
  // Manual matches (buildManualMatch) have a synthetic key that doesn't
  // exist on TBA - only real, TBA-sourced matches get a link.
  $: tbaMatchUrl =
    selectedMatch && !selectedMatch.manual
      ? `https://www.thebluealliance.com/match/${selectedMatch.key}`
      : null;

  // Session State
  let phase = "pre"; // pre, auto, teleop, endgame, finished
  let startPosition = ""; // left trench, left mound, center, right mound, right trench

  // Teleop Specific State
  let currentRole = "Scoring";
  let autoTopSection;
  let teleopTopSection;
  let matchNotes = "";
  let submittingMatch = false;

  // Endgame State
  let finalClimbPos = "N/A";
  let autoClimbPos = "N/A";
  let autoDead = false;

  // History / Logs
  let scoutingEvents = []; // current session events

  // Secondary Views
  let allCompetitionTeams = [];
  let teamsWithData = [];
  let selectedTeamForView = "";
  let viewMode = "scout"; // scout | schedule | analysis | view
  let teamEvents = [];
  let viewFilterMatch = "all";
  let viewLoading = false;
  let expandedSections = {};
  let myDataAssignments = {};
  let lastAssignmentUserId = null;
  let eventAnalysis = null;
  let analysisLoading = false;
  let analysisError = "";
  let exportingReport = false;
  let exportMessage = "";
  let exportDocumentUrl = "";
  function teamSort(a, b) {
    const numA = parseInt(String(a).replace(/\D/g, "")) || 0;
    const numB = parseInt(String(b).replace(/\D/g, "")) || 0;
    return numA - numB;
  }
  $: teamsForViewDropdown = (() => {
    const withData = new Set(teamsWithData);
    const fromComp = allCompetitionTeams.filter((t) => !withData.has(t));
    return [...teamsWithData, ...fromComp].sort(teamSort);
  })();
  function toggleSection(id) {
    expandedSections = { ...expandedSections, [id]: !expandedSections[id] };
  }

  $: myAssignmentCount = Object.keys(myDataAssignments).length;

  function handleButtonClick(e) {
    if (e.currentTarget) {
      e.currentTarget.blur();
    }
  }

  const ROLES = ["Scoring", "Shuttling", "Defense", "Counter Defense", "Dead"];
  const CLIMB_POSITIONS = ["N/A", "L1", "L2", "L3", "Failed"];

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
      key: `${resolvedEventKey || "manual"}_manual_${slug}`,
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
    const headers = {
      ...(options.headers || {}),
      ...(await getAuthHeader()),
    };
    return fetch(url, { ...options, headers });
  }

  function assignmentLookupKey(matchKey, teamKey) {
    return `${matchKey}::${teamKey}`;
  }

  function isMyAssignedRobot(matchKey, teamKey) {
    return !!myDataAssignments[assignmentLookupKey(matchKey, teamKey)];
  }

  function openSchedule() {
    viewMode = "schedule";
  }

  async function loadMyAssignments() {
    if (!user?.id) {
      myDataAssignments = {};
      return;
    }

    try {
      const res = await authFetch(
        `/api/scout-assignments?scouting_type=data&mine=1&user_id=${encodeURIComponent(user.id)}`,
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Failed to load assignments (${res.status})`);
      }

      const nextAssignments = {};
      for (const row of data.data || []) {
        if (row?.completed_at) continue;
        nextAssignments[assignmentLookupKey(row.match_key, row.team_key)] = true;
      }
      myDataAssignments = nextAssignments;
    } catch {
      myDataAssignments = {};
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
          scouting_type: "data",
          match_key: matchKey,
          team_key: teamKey,
          user_id: user.id,
        }),
      });
      await loadMyAssignments();
    } catch {
      // Ignore completion failures here; the submitted scouting data is more important.
    }
  }

  async function fetchMatches() {
    loadNote = "";
    if (!resolvedEventKey) {
      loadNote = "No event configured.";
      return;
    }
      loadingMatches = true;
    try {
      const res = await fetch(
        `/api/tba/event-matches?event_key=${encodeURIComponent(resolvedEventKey)}&comp_level=all`,
      );
      if (!res.ok) {
        const js = await res.json().catch(() => null);
        loadNote = js?.error || `Failed to load matches (${res.status})`;
        return;
      }
      const js = await res.json();
      if (!js?.success) {
        loadNote = js?.error || "Failed to load matches";
        return;
      }
      matches = (js.data || []).slice();
      eventTeams = [
        ...new Set(
          matches.flatMap((m) => [
            ...(m.alliances?.red?.team_keys || []),
            ...(m.alliances?.blue?.team_keys || []),
          ]),
        ),
      ].sort(teamSort);
      fetchTeamEPAs();
    } catch (e) {
      loadNote = e.message || "Load error";
    } finally {
      loadingMatches = false;
    }
  }

  // Non-fatal: OPR is a nice-to-have while scouting, not required to keep
  // working - a TBA outage shouldn't block match loading above.
  async function fetchTeamEPAs() {
    if (!resolvedEventKey) return;
    try {
      const res = await fetch(
        `/api/tba/event-oprs?event_key=${encodeURIComponent(resolvedEventKey)}`,
      );
      const js = await res.json().catch(() => null);
      if (js?.success && Array.isArray(js.data)) {
        teamEPAs = new Map(js.data.map((row) => [row.team, row]));
      }
    } catch (e) {
      // silent - EPA display just stays empty
    }
  }

  function onSelectMatchByKey() {
    if (selectedMatchKey === "__manual__") {
      selectedMatch = buildManualMatch(manualMatchLabel);
      const teamKey = normalizeTeamKey(manualTeamInput);
      teamsCurrentMatch = teamKey ? [teamKey] : [];
      selectedTeam = teamKey;
      resetSessionState();
      return;
    }
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
    resetSessionState();
  }

  $: if (selectedMatchKey === "__manual__") {
    selectedMatch = buildManualMatch(manualMatchLabel);
    const teamKey = normalizeTeamKey(manualTeamInput);
    teamsCurrentMatch = teamKey ? [teamKey] : [];
    selectedTeam = teamKey;
  }

  function resetSessionState() {
    phase = "pre";
    startPosition = "";
    currentRole = "Scoring";
    matchNotes = "";
    submittingMatch = false;
    finalClimbPos = "N/A";
    autoClimbPos = "N/A";
    autoDead = false;
    scoutingEvents = [];
    holdTimers = {};
  }

  async function record(event_type, event_value) {
    if (!selectedMatch || !selectedTeam) return;
    const payload = {
      action: "record-event",
      match_key: selectedMatch.key,
      match_number: selectedMatch.match_number,
      team_key: selectedTeam,
      phase: phase,
      event_type,
      event_value,
      user_id: user?.id || null,
      // Role remains useful context. Shift state was removed from the scout
      // workflow; every observation stands on its own instead.
      role: phase === "teleop" ? currentRole : null,
      on_shift: null,
    };

    // Optimistic UI update
    const tempEvent = { ...payload, created_at: new Date().toISOString() };
    scoutingEvents = [...scoutingEvents, tempEvent]; // append

    try {
      const res = await fetch("/datascout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeader()),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data?.success) {
        console.error("Failed to save event", data?.error);
      } else if (data.data?.id) {
        // Update the optimistic entry with the real DB ID
        const idx = scoutingEvents.findIndex(
          (e) =>
            e.created_at === tempEvent.created_at &&
            e.event_type === tempEvent.event_type,
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

  async function undoLast() {
    if (scoutingEvents.length === 0) return;
    const lastEvent = scoutingEvents[scoutingEvents.length - 1];

    // Remove from local state
    scoutingEvents = scoutingEvents.slice(0, -1);

    // Auto Dead Reversion Logic
    if (lastEvent.event_type === "dead_auto") {
      autoDead = lastEvent.event_value !== "true";
    }

    // Phase Reversion Logic
    if (lastEvent.event_type === "phase") {
      if (lastEvent.event_value === "begin_auto") phase = "pre";
      else if (lastEvent.event_value === "end_auto") {
        phase = "auto";
        void scrollAutoToTop();
      }
      else if (lastEvent.event_value === "finish_match") {
        phase = "teleop";
        void scrollTeleopToTop();
      }
    }

    if (lastEvent.id) {
      try {
        const res = await fetch("/datascout", {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            ...(await getAuthHeader()),
          },
          body: JSON.stringify({ id: lastEvent.id }),
        });
        const data = await res.json();
        if (!data?.success) {
          console.error("Failed to undo event in DB", data?.error);
        }
      } catch (e) {
        console.error("Undo error", e);
      }
    }

    // Batch Undo for Hold Actions (e.g. shooting_end -> shooting_start)
    if (lastEvent.event_type.endsWith("_end")) {
      undoLast();
      return;
    }

    // Batch Undo for Match Phase Setup
    const nextLast = scoutingEvents[scoutingEvents.length - 1];
    if (nextLast) {
      const isTeleopSetup =
        (lastEvent.event_type === "auto_climb_pos" &&
          nextLast.event_type === "role_update") ||
        (lastEvent.event_type === "role_update" &&
          nextLast.event_type === "phase" &&
          nextLast.event_value === "end_auto");

      const isAutoSetup =
        lastEvent.event_type === "phase" &&
        lastEvent.event_value === "begin_auto" &&
        nextLast.event_type === "auto_start_position";

      if (isTeleopSetup || isAutoSetup) {
        undoLast();
      }
    }
  }

  // Phase Actions
  function toggleAutoDead() {
    autoDead = !autoDead;
    record("dead_auto", String(autoDead));
  }
  function recordPickup(source) {
    record("pickup", source);
  }
  function recordPushing() {
    record("pushing", "outpost");
  }

  // Fuel counters (Shuttle / Hub): precise tap-counted scores, separate from
  // the existing shooting_start/shooting_end hold-duration estimate above -
  // that stays as-is (avoid two features fighting over one derived number).
  // Counts are derived from the session's own event log, same "aggregate
  // from discrete events" philosophy as everywhere else in this file, not a
  // separately-tracked running total. A "*_fuel_override" event lets a scout
  // type an exact count (e.g. after losing count, or correcting after the
  // fact); the derived value is the override's number plus any taps that
  // came after it, so older taps stay in the log for audit/undo purposes
  // instead of being deleted.
  function recordFuelScore(location) {
    record(`${location}_fuel`, "1");
  }
  function recordFuelOverride(location, rawValue) {
    const num = Math.round(Number(rawValue));
    if (!Number.isFinite(num) || num < 0) return;
    record(`${location}_fuel_override`, String(num));
  }
  let shuttleFuelOverrideInput = "";
  let hubFuelOverrideInput = "";
  $: shuttleFuelCount = fuelCountFromEvents(scoutingEvents, "shuttle");
  $: hubFuelCount = fuelCountFromEvents(scoutingEvents, "hub");
  // Phase transitions
  function chooseStart(pos) {
    startPosition = pos;
    record("auto_start_position", pos);
  }
  function beginAuto() {
    phase = "auto";
    void scrollAutoToTop();
    record("phase", "begin_auto");
  }
  function endAuto() {
    phase = "teleop";
    void scrollTeleopToTop();
    record("phase", "end_auto");
    record("role_update", currentRole);
    record("auto_climb_pos", autoClimbPos);
  }
  function beginEndgame() {
    phase = "endgame";
    record("phase", "begin_endgame");
  }

  async function scrollSectionToTop(sectionOrGetter) {
    await tick();
    if (typeof window === "undefined") return;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(resolve),
      ));
    const section = typeof sectionOrGetter === "function"
      ? sectionOrGetter()
      : sectionOrGetter;
    if (!section) return;
    const top = section.getBoundingClientRect().top + window.scrollY;
    const navHeader = document.querySelector(".nav-header");
    const headerOffset = navHeader instanceof HTMLElement
      ? navHeader.getBoundingClientRect().height + 8
      : 0;
    window.scrollTo({ top: Math.max(0, top - headerOffset), behavior: "smooth" });
  }

  async function scrollAutoToTop() {
    await scrollSectionToTop(() => autoTopSection);
  }

  async function scrollTeleopToTop() {
    await scrollSectionToTop(() => teleopTopSection);
  }

  async function saveMatchNotes() {
    const trimmedNotes = String(matchNotes || "").trim();
    if (!trimmedNotes || !selectedMatch || !selectedTeam) return;

    const payload = {
      action: "save-note",
      match_key: selectedMatch.key,
      match_number: selectedMatch.match_number,
      team_key: selectedTeam,
      notes: trimmedNotes,
      user_id: user?.id || null,
    };

    const res = await authFetch("/notescout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      throw new Error(data?.error || `Failed to save notes (${res.status})`);
    }
  }

  async function submitMatch() {
    if (submittingMatch || !selectedMatch || !selectedTeam) return;

    submittingMatch = true;
    loadNote = "";

    try {
      await saveMatchNotes();
      await record("climb_pos", finalClimbPos);
      await record("phase", "finish_match");
      await completeMyAssignment(selectedMatch.key, selectedTeam);
      phase = "finished";
    } catch (e) {
      loadNote = e.message || "Failed to submit match";
    } finally {
      submittingMatch = false;
    }
  }

  // Hold-to-record Handlers (Shooting, Climbing, Pick Up, Pushing)
  let holdTimers = {};

  function startAction(actionName, value) {
    const key = `${actionName}_${value}`;
    if (holdTimers[key]) return;

    // Record start
    record(`${actionName}_start`, value);
    holdTimers = { ...holdTimers, [key]: true };
  }

  function endAction(actionName, value) {
    const key = `${actionName}_${value}`;
    if (!holdTimers[key]) return;
    record(`${actionName}_end`, value);
    const newTimers = { ...holdTimers };
    delete newTimers[key];
    holdTimers = newTimers;
  }

  function startVisualAction(key, actionFn) {
    if (holdTimers[key]) return;
    if (actionFn) actionFn();
    holdTimers = { ...holdTimers, [key]: true };
  }

  function endVisualAction(key) {
    if (!holdTimers[key]) return;
    const newTimers = { ...holdTimers };
    delete newTimers[key];
    holdTimers = newTimers;
  }

  // Teleop Toggles
  function setRole(r) {
    currentRole = r;
    record("role_update", r);
  }

  // Viewing Data
  async function loadTeamsWithData() {
    try {
      const res = await authFetch("/datascout?list_teams=1");
      const data = await res.json();
      if (data?.success) {
        teamsWithData = data.data || [];
      }
    } catch {
      teamsWithData = [];
    }
  }

  $: viewMatchKeys = (() => {
    const keys = [...new Set(teamEvents.map((e) => e.match_key).filter(Boolean))];
    keys.sort((a, b) => {
      const numA = parseInt(a.split("_").pop().replace(/\D/g, "")) || 0;
      const numB = parseInt(b.split("_").pop().replace(/\D/g, "")) || 0;
      return numA - numB;
    });
    return keys;
  })();

  $: filteredEvents =
    viewFilterMatch === "all"
      ? teamEvents
      : teamEvents.filter((e) => e.match_key === viewFilterMatch);

  // Main computed stats object
  $: viewStats = (() => {
    const events = filteredEvents;
    if (!events || events.length === 0) return null;

    const byMatch = {};
    for (const e of events) {
      if (!byMatch[e.match_key]) byMatch[e.match_key] = [];
      byMatch[e.match_key].push(e);
    }
    const matchKeys = Object.keys(byMatch);
    const matchCount = matchKeys.length;

    // --- Fuel ---
    let totalFuel = 0, totalAutoFuel = 0, totalTeleopFuel = 0;
    let autoShuttlingFuel = 0, autoScoringFuel = 0, teleopShuttlingFuel = 0, teleopScoringFuel = 0;
    for (const mk of matchKeys) {
      const mEvents = byMatch[mk];
      const speedEvt = mEvents.find((e) => e.event_type === "rank_speed");
      const speed = speedEvt ? parseFloat(speedEvt.event_value) || 5 : 5;
      const shootStarts = [];
      for (const e of mEvents) {
        if (e.event_type === "shooting_start") shootStarts.push(e);
        else if (e.event_type === "shooting_end" && shootStarts.length > 0) {
          const start = shootStarts.shift();
          const dur = (new Date(e.created_at) - new Date(start.created_at)) / 1000;
          if (dur > 0 && dur < 300) {
            const fuel = dur * speed;
            totalFuel += fuel;
            if (start.phase === "auto") {
              totalAutoFuel += fuel;
              if (start.event_value === "shuttling") autoShuttlingFuel += fuel;
              else autoScoringFuel += fuel;
            } else {
              totalTeleopFuel += fuel;
              if (start.event_value === "shuttling") teleopShuttlingFuel += fuel;
              else teleopScoringFuel += fuel;
            }
          }
        }
      }
    }
    const avgFuel = matchCount > 0 ? totalFuel / matchCount : 0;
    const avgAutoFuel = matchCount > 0 ? totalAutoFuel / matchCount : 0;
    const avgTeleopFuel = matchCount > 0 ? totalTeleopFuel / matchCount : 0;
    const avgAutoShuttling = matchCount > 0 ? autoShuttlingFuel / matchCount : 0;
    const avgAutoScoring = matchCount > 0 ? autoScoringFuel / matchCount : 0;
    const avgTeleopShuttling = matchCount > 0 ? teleopShuttlingFuel / matchCount : 0;
    const avgTeleopScoring = matchCount > 0 ? teleopScoringFuel / matchCount : 0;

    const speedVals = events.filter((e) => e.event_type === "rank_speed").map((e) => parseFloat(e.event_value) || 0);
    const avgSpeed = speedVals.length > 0 ? speedVals.reduce((a, b) => a + b, 0) / speedVals.length : 0;
    const accVals = events.filter((e) => e.event_type === "rank_accuracy").map((e) => parseFloat(e.event_value) || 0);
    const avgAccuracy = accVals.length > 0 ? accVals.reduce((a, b) => a + b, 0) / accVals.length : 0;
    const drvVals = events.filter((e) => e.event_type === "rank_driving").map((e) => parseFloat(e.event_value) || 0);
    const avgDriving = drvVals.length > 0 ? drvVals.reduce((a, b) => a + b, 0) / drvVals.length : 0;

    // --- Climb Times per match (for stat cards) ---
    const climbTimes = matchKeys.map((mk) => {
      const mEvents = byMatch[mk];
      const climbEvt = mEvents.find((e) => e.event_type === "climb_pos");
      const pos = climbEvt ? climbEvt.event_value : "N/A";
      let climbTime = null;
      const starts = [];
      for (const e of mEvents) {
        if (e.event_type === "climbing_start" && (e.phase === "teleop" || e.phase === "endgame")) starts.push(e);
        else if (e.event_type === "climbing_end" && starts.length > 0) {
          const s = starts.shift();
          const dur = (new Date(e.created_at) - new Date(s.created_at)) / 1000;
          if (dur > 0 && dur < 300) climbTime = (climbTime || 0) + dur;
        }
      }
      return { matchLabel: mk.split("_").pop().toUpperCase(), climbTime, climbPos: pos };
    });

    // --- Climb distribution: Auto (N/A, L1, Failed) and Teleop (N/A, L1, L2, L3, Failed) ---
    const autoClimbDist = { none: { count: 0, totalTime: 0 }, L1: { count: 0, totalTime: 0 }, failed: { count: 0, totalTime: 0 } };
    const teleopClimbDist = { none: { count: 0, totalTime: 0 }, L1: { count: 0, totalTime: 0 }, L2: { count: 0, totalTime: 0 }, L3: { count: 0, totalTime: 0 }, failed: { count: 0, totalTime: 0 } };

    for (const mk of matchKeys) {
      const mEvents = byMatch[mk];
      // Auto climb: auto_climb_pos (N/A, L1, or Failed) and climbing_start/end with phase=auto
      let autoPos = "N/A";
      const autoClimbStarts = [];
      let autoTime = 0;
      for (const e of mEvents) {
        if (e.event_type === "auto_climb_pos" && e.event_value) autoPos = e.event_value;
        if (e.event_type === "climbing_start" && e.phase === "auto") autoClimbStarts.push(e);
        else if (e.event_type === "climbing_end" && e.phase === "auto" && autoClimbStarts.length > 0) {
          const s = autoClimbStarts.shift();
          const dur = (new Date(e.created_at) - new Date(s.created_at)) / 1000;
          if (dur > 0 && dur < 300) autoTime += dur;
        }
      }
      if (autoPos === "N/A" || !autoPos) {
        autoClimbDist.none.count++;
      } else if (autoPos === "Failed" || autoPos === "failed") {
        autoClimbDist.failed.count++;
      } else {
        autoClimbDist.L1.count++;
        autoClimbDist.L1.totalTime += autoTime;
      }

      // Teleop climb: climb_pos and climbing_start/end (teleop/endgame)
      const climbEvt = mEvents.find((e) => e.event_type === "climb_pos");
      const teleopPos = climbEvt ? climbEvt.event_value : "N/A";
      const teleopStarts = [];
      let teleopTime = 0;
      for (const e of mEvents) {
        if ((e.event_type === "climbing_start" && (e.phase === "teleop" || e.phase === "endgame"))) teleopStarts.push(e);
        else if (e.event_type === "climbing_end" && teleopStarts.length > 0) {
          const s = teleopStarts.shift();
          const dur = (new Date(e.created_at) - new Date(s.created_at)) / 1000;
          if (dur > 0 && dur < 300) teleopTime += dur;
        }
      }
      const posKey = teleopPos === "N/A" || !teleopPos ? "none" : (teleopPos === "Failed" || teleopPos === "failed" ? "failed" : teleopPos);
      if (teleopClimbDist[posKey]) {
        teleopClimbDist[posKey].count++;
        if (posKey !== "none" && posKey !== "failed") teleopClimbDist[posKey].totalTime += teleopTime;
      }
    }

    // --- Pickups ---
    const autoPickups = { ground: 0, depot: 0, outpost: 0 };
    events.filter((e) => e.event_type === "pickup" && e.phase === "auto").forEach((e) => {
      const v = (e.event_value || "").toLowerCase();
      if (autoPickups.hasOwnProperty(v)) autoPickups[v]++;
    });
    const teleopPickups = { ground: 0, depot: 0, outpost: 0 };
    events.filter((e) => e.event_type === "pickup" && e.phase === "teleop").forEach((e) => {
      const v = (e.event_value || "").toLowerCase();
      if (teleopPickups.hasOwnProperty(v)) teleopPickups[v]++;
    });

    // --- Role times ---
    const roleTimes = { Scoring: 0, Shuttling: 0, Defense: 0, "Counter Defense": 0, Dead: 0 };
    for (const mk of matchKeys) {
      const mEvents = byMatch[mk];
      const teleopEvts = mEvents
        .filter((e) => e.phase === "teleop" || (e.event_type === "phase" && (e.event_value === "end_auto" || e.event_value === "finish_match")))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      let currentRole = null, roleStartTime = null;
      for (const e of teleopEvts) {
        if (e.event_type === "role_update") {
          if (currentRole && roleStartTime && roleTimes.hasOwnProperty(currentRole)) {
            const dur = (new Date(e.created_at) - new Date(roleStartTime)) / 1000;
            if (dur > 0 && dur < 600) roleTimes[currentRole] += dur;
          }
          currentRole = e.event_value;
          roleStartTime = e.created_at;
        } else if (e.event_type === "phase" && e.event_value === "finish_match") {
          if (currentRole && roleStartTime && roleTimes.hasOwnProperty(currentRole)) {
            const dur = (new Date(e.created_at) - new Date(roleStartTime)) / 1000;
            if (dur > 0 && dur < 600) roleTimes[currentRole] += dur;
          }
          currentRole = null;
        }
      }
    }

    // --- Dead in Auto ---
    const autoDeadMatches = matchKeys.filter((mk) =>
      byMatch[mk].some((e) => e.event_type === "dead_auto" && e.event_value === "true")
    ).length;
    const autoDeadRate = matchCount > 0 ? autoDeadMatches / matchCount : 0;

    // --- Auto climb rate / avg time ---
    let autoClimbTimeTotal = 0, autoClimbTimeCount = 0, autoClimbedCount = 0;
    for (const mk of matchKeys) {
      const mEvents = byMatch[mk];
      const autoClimbStarts = [];
      let matchAutoTime = 0;
      let didAutoClimb = false;
      for (const e of mEvents) {
        if (e.event_type === "auto_climb_pos" && e.event_value !== "N/A" && e.event_value !== "Failed") didAutoClimb = true;
        if (e.event_type === "climbing_start" && e.phase === "auto") autoClimbStarts.push(e);
        else if (e.event_type === "climbing_end" && e.phase === "auto" && autoClimbStarts.length > 0) {
          const s = autoClimbStarts.shift();
          const dur = (new Date(e.created_at) - new Date(s.created_at)) / 1000;
          if (dur > 0 && dur < 300) { matchAutoTime += dur; didAutoClimb = true; }
        }
      }
      if (matchAutoTime > 0) { autoClimbTimeTotal += matchAutoTime; autoClimbTimeCount++; }
      if (didAutoClimb) autoClimbedCount++;
    }
    const avgAutoClimbTime = autoClimbTimeCount > 0 ? autoClimbTimeTotal / autoClimbTimeCount : null;
    const autoClimbRate = matchCount > 0 ? autoClimbedCount / matchCount : 0;

    // --- Per-match data for accordion mini bars ---
    const roleTimesByMatch = {};
    const shootingDistAutoByMatch = {};
    const shootingDistTeleopByMatch = {};
    const autoPickupsByMatch = {};
    const teleopPickupsByMatch = {};
    const autoClimbDistByMatch = {};
    const teleopClimbDistByMatch = {};

    for (const mk of matchKeys) {
      const mEvents = byMatch[mk];
      const label = mk.split("_").pop().toUpperCase();

      const rTimes = { Scoring: 0, Shuttling: 0, Defense: 0, "Counter Defense": 0, Dead: 0 };
      const teleopEvts = mEvents
        .filter((e) => e.phase === "teleop" || (e.event_type === "phase" && (e.event_value === "end_auto" || e.event_value === "finish_match")))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      let cr = null, crStart = null;
      for (const e of teleopEvts) {
        if (e.event_type === "role_update") {
          if (cr && crStart && rTimes.hasOwnProperty(cr)) {
            const d = (new Date(e.created_at) - new Date(crStart)) / 1000;
            if (d > 0 && d < 600) rTimes[cr] += d;
          }
          cr = e.event_value;
          crStart = e.created_at;
        } else if (e.event_type === "phase" && e.event_value === "finish_match") {
          if (cr && crStart && rTimes.hasOwnProperty(cr)) {
            const d = (new Date(e.created_at) - new Date(crStart)) / 1000;
            if (d > 0 && d < 600) rTimes[cr] += d;
          }
          cr = null;
        }
      }
      const rt = rTimes.Scoring + rTimes.Shuttling + rTimes.Defense + (rTimes["Counter Defense"] || 0) + rTimes.Dead;
      roleTimesByMatch[mk] = { label, ...rTimes, totalTime: rt };

      const speedEvt = mEvents.find((e) => e.event_type === "rank_speed");
      const spd = speedEvt ? parseFloat(speedEvt.event_value) || 5 : 5;
      let autoSh = 0, autoSc = 0, teleSh = 0, teleSc = 0;
      const ss = [];
      for (const e of mEvents) {
        if (e.event_type === "shooting_start") ss.push(e);
        else if (e.event_type === "shooting_end" && ss.length > 0) {
          const st = ss.shift();
          const d = (new Date(e.created_at) - new Date(st.created_at)) / 1000;
          if (d > 0 && d < 300) {
            const f = d * spd;
            if (st.phase === "auto") {
              if (st.event_value === "shuttling") autoSh += f; else autoSc += f;
            } else {
              if (st.event_value === "shuttling") teleSh += f; else teleSc += f;
            }
          }
        }
      }
      const autoShootTime = (autoSh + autoSc) / (spd || 1);
      const teleopShootTime = (teleSh + teleSc) / (spd || 1);
      shootingDistAutoByMatch[mk] = { label, shuttling: autoSh, scoring: autoSc, totalTime: autoShootTime };
      shootingDistTeleopByMatch[mk] = { label, shuttling: teleSh, scoring: teleSc, totalTime: teleopShootTime };

      const aP = { ground: 0, depot: 0, outpost: 0 };
      const tP = { ground: 0, depot: 0, outpost: 0 };
      mEvents.filter((e) => e.event_type === "pickup" && e.phase === "auto").forEach((e) => {
        const v = (e.event_value || "").toLowerCase();
        if (aP.hasOwnProperty(v)) aP[v]++;
      });
      mEvents.filter((e) => e.event_type === "pickup" && e.phase === "teleop").forEach((e) => {
        const v = (e.event_value || "").toLowerCase();
        if (tP.hasOwnProperty(v)) tP[v]++;
      });
      autoPickupsByMatch[mk] = { label, ...aP };
      teleopPickupsByMatch[mk] = { label, ...tP };

      let aPos = "N/A", aT = 0;
      const aStarts = [];
      for (const e of mEvents) {
        if (e.event_type === "auto_climb_pos" && e.event_value) aPos = e.event_value;
        if (e.event_type === "climbing_start" && e.phase === "auto") aStarts.push(e);
        else if (e.event_type === "climbing_end" && e.phase === "auto" && aStarts.length > 0) {
          const s = aStarts.shift();
          const d = (new Date(e.created_at) - new Date(s.created_at)) / 1000;
          if (d > 0 && d < 300) aT += d;
        }
      }
      const aKey = aPos === "N/A" || !aPos ? "none" : (aPos === "Failed" || aPos === "failed" ? "failed" : "L1");
      autoClimbDistByMatch[mk] = { label, none: aKey === "none" ? 1 : 0, L1: aKey === "L1" ? 1 : 0, failed: aKey === "failed" ? 1 : 0, l1Time: aKey === "L1" ? aT : 0 };

      const climbEvt = mEvents.find((e) => e.event_type === "climb_pos");
      const tPos = climbEvt ? climbEvt.event_value : "N/A";
      const tStarts = [];
      let tT = 0;
      for (const e of mEvents) {
        if (e.event_type === "climbing_start" && (e.phase === "teleop" || e.phase === "endgame")) tStarts.push(e);
        else if (e.event_type === "climbing_end" && tStarts.length > 0) {
          const s = tStarts.shift();
          const d = (new Date(e.created_at) - new Date(s.created_at)) / 1000;
          if (d > 0 && d < 300) tT += d;
        }
      }
      const tKey = tPos === "N/A" || !tPos ? "none" : (tPos === "Failed" || tPos === "failed" ? "failed" : tPos);
      teleopClimbDistByMatch[mk] = {
        label,
        none: tKey === "none" ? 1 : 0,
        L1: tKey === "L1" ? 1 : 0,
        L2: tKey === "L2" ? 1 : 0,
        L3: tKey === "L3" ? 1 : 0,
        failed: tKey === "failed" ? 1 : 0,
        climbTime: ["L1", "L2", "L3"].includes(tKey) ? tT : 0,
      };
    }

    return {
      matchCount,
      avgFuel: viewFilterMatch === "all" ? avgFuel : totalFuel,
      avgAutoFuel: viewFilterMatch === "all" ? avgAutoFuel : totalAutoFuel,
      avgTeleopFuel: viewFilterMatch === "all" ? avgTeleopFuel : totalTeleopFuel,
      avgSpeed, avgAccuracy, avgDriving,
      avgAutoClimbTime, autoClimbRate,
      climbTimes,
      autoPickups, teleopPickups,
      roleTimes,
      shootingDist: {
        auto: { shuttling: avgAutoShuttling, scoring: avgAutoScoring },
        teleop: { shuttling: avgTeleopShuttling, scoring: avgTeleopScoring },
      },
      autoClimbDist,
      teleopClimbDist,
      autoDeadMatches,
      autoDeadRate,
      roleTimesByMatch,
      shootingDistAutoByMatch,
      shootingDistTeleopByMatch,
      autoPickupsByMatch,
      teleopPickupsByMatch,
      autoClimbDistByMatch,
      teleopClimbDistByMatch,
    };
  })();

  async function viewTeamEvents() {
    if (!selectedTeamForView) return;
    viewMode = "view";
    const res = await authFetch(
      "/datascout?team_key=" + encodeURIComponent(selectedTeamForView),
    );
    const data = await res.json();
    if (data?.success) {
      teamEvents = data.data || [];
    }
    viewLoading = false;
  }
  $: analysisTeams = eventAnalysis?.summary?.teams || [];
  $: analysisMaxReports = Math.max(1, ...analysisTeams.map((team) => team.total || 0));

  async function openAnalysis() {
    if (!resolvedEventKey) return;
    viewMode = "analysis";
    analysisLoading = true;
    analysisError = "";
    exportMessage = "";
    exportDocumentUrl = "";
    try {
      const res = await authFetch(`/api/scouting-report?event_key=${encodeURIComponent(resolvedEventKey)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || "Could not load event scouting data.");
      eventAnalysis = data;
    } catch (error) {
      eventAnalysis = null;
      analysisError = error?.message || "Could not load event scouting data.";
    } finally {
      analysisLoading = false;
    }
  }

  async function exportGoogleDoc() {
    if (!resolvedEventKey || exportingReport) return;
    exportingReport = true;
    exportMessage = "";
    exportDocumentUrl = "";
    try {
      const res = await authFetch("/api/scouting-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "export-google-doc", event_key: resolvedEventKey })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || "Could not export the Google Doc.");
      exportDocumentUrl = data.data.url;
      exportMessage = "Google Doc created and shared with your signed-in Google account.";
    } catch (error) {
      exportMessage = error?.message || "Could not export the Google Doc.";
    } finally {
      exportingReport = false;
    }
  }

  function backToScout() {
    viewMode = "scout";
    viewFilterMatch = "all";
    teamEvents = [];
    eventAnalysis = null;
    analysisError = "";
  }

  async function loadEventOptions() {
    eventKey = (await fetchActiveScoutingEventKey()) || "";
    availableEvents = await fetchAvailableScoutingEvents();
  }

  onMount(() => {
    loadEventOptions();
    loadMyAssignments();
  });

  $: {
    const currentAssignmentUserId = user?.id || null;
    if (currentAssignmentUserId !== lastAssignmentUserId) {
      lastAssignmentUserId = currentAssignmentUserId;
      loadMyAssignments();
    }
  }

  // Re-fetch matches whenever the resolved event changes - covers both the
  // initial async load of the active event key and the user switching the
  // event dropdown afterward.
  $: {
    if (resolvedEventKey !== lastLoadedMatchesEventKey) {
      lastLoadedMatchesEventKey = resolvedEventKey;
      fetchMatches();
    }
  }
</script>

<svelte:window on:contextmenu|preventDefault />

<!-- Header -->
<div class="page-header card">
  <div>
    <h2 style="margin:0">Data Scouting</h2>
    {#if resolvedEventKey}
      <div class="sub-label">{resolvedEventKey}</div>
    {/if}
    {#if loadNote}<div class="note">{loadNote}</div>{/if}
    {#if isViewingPastEvent}
      <div class="note">
        Viewing past event {selectedEventKey}, not the active event ({eventKey || "none set"}). Anything
        recorded here will be saved under {selectedEventKey} too — switch back to "Current Event" before
        scouting a live match.
      </div>
    {/if}
  </div>

  <div class="page-actions">
    <SeasonFilter
      options={availableEvents}
      bind:value={selectedEventKey}
      allLabel={`Current Event (${eventKey || "none set"})`}
    />
    <div class="form-group match-select">
      <span class="label" for="matchSelect">Match</span>
      <select
        id="matchSelect"
        class="form-select"
        bind:value={selectedMatchKey}
        on:change={onSelectMatchByKey}
        disabled={loadingMatches}
      >
        <option value="">-- choose --</option>
        <option value="__manual__">Manual / Unofficial Match</option>
        {#each matches as m}<option value={m.key}
            >{formatMatchLabel(m)}</option
          >{/each}
      </select>
    </div>
    <div class="schedule-action">
      {#if viewMode === "schedule" || viewMode === "analysis" || viewMode === "view"}
        <button class="btn btn-secondary" on:click={backToScout}>
          &larr; Back to Scout
        </button>
      {:else}
        <button
          class="btn btn-secondary"
          on:click={openSchedule}
          disabled={loadingMatches || matches.length === 0}
        >
          Schedule
        </button>
        <button class="btn btn-secondary" on:click={openAnalysis} disabled={!resolvedEventKey}>
          <BarChart3 size={15} /> Event Analysis
        </button>
      {/if}
    </div>
  </div>
</div>

{#if viewMode === "schedule"}
  <div class="card">
    <div class="schedule-header">
      <div>
        <h3 style="margin:0">Match Schedule</h3>
        <p class="schedule-copy">
          {#if user?.id}
            Robots highlighted in yellow are your data scouting assignments.
          {:else}
            Sign in to see your highlighted scouting assignments.
          {/if}
        </p>
      </div>
      {#if user?.id}
        <div class="schedule-count">
          {myAssignmentCount} assignment{myAssignmentCount === 1 ? "" : "s"} highlighted
        </div>
      {/if}
    </div>

    {#if loadingMatches}
      <div class="empty-state">Loading schedule...</div>
    {:else if matches.length === 0}
      <div class="empty-state">No matches available for this event.</div>
    {:else}
      <div class="scroll-x">
        <table class="schedule-table">
          <thead>
            <tr>
              <th>Match</th>
              <th colspan="3" class="alliance blue">Blue Alliance</th>
              <th colspan="3" class="alliance red">Red Alliance</th>
            </tr>
            <tr>
              <th></th>
              {#each [1, 2, 3] as i}<th class="blue">B{i}</th>{/each}
              {#each [1, 2, 3] as i}<th class="red">R{i}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each matches as m}
              <tr>
                <td class="match-label-cell">{formatMatchLabel(m)}</td>
                {#each m.alliances?.blue?.team_keys || [] as t}
                  <td
                    class="schedule-cell blue"
                    class:assigned-cell={isMyAssignedRobot(m.key, t)}
                  >
                    <div class="schedule-team">{displayTeam(t)}</div>
                    {#if isMyAssignedRobot(m.key, t)}
                      <div class="schedule-tag">Your robot</div>
                    {/if}
                  </td>
                {/each}
                {#each m.alliances?.red?.team_keys || [] as t}
                  <td
                    class="schedule-cell red"
                    class:assigned-cell={isMyAssignedRobot(m.key, t)}
                  >
                    <div class="schedule-team">{displayTeam(t)}</div>
                    {#if isMyAssignedRobot(m.key, t)}
                      <div class="schedule-tag">Your robot</div>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
{:else if viewMode === "analysis"}
  <section class="card analysis-page">
    <div class="analysis-header">
      <div>
        <h3><BarChart3 size={20} /> Event Analysis</h3>
        <p>One view of every submitted scouting record for {resolvedEventKey}: Data Scouting, Match Scouting, Pit Scouting, notes, and released vision observations.</p>
      </div>
      <div class="analysis-actions">
        <button class="btn btn-outline" on:click={openAnalysis} disabled={analysisLoading} title="Refresh event analysis"><RefreshCw size={15} /></button>
        <button class="btn btn-primary" on:click={exportGoogleDoc} disabled={analysisLoading || exportingReport || !eventAnalysis}>
          <FileText size={15} /> {exportingReport ? "Exporting..." : "Export Google Doc"}
        </button>
      </div>
    </div>

    {#if analysisLoading}
      <div class="empty-state">Loading scouting data...</div>
    {:else if analysisError}
      <div class="empty-state">{analysisError}</div>
    {:else if eventAnalysis}
      {@const totals = eventAnalysis.summary.totals}
      <div class="stat-cards-grid analysis-totals">
        <div class="stat-card"><div class="stat-label">Teams covered</div><div class="stat-value">{totals.teams}</div></div>
        <div class="stat-card"><div class="stat-label">Data observations</div><div class="stat-value">{totals.data_events}</div></div>
        <div class="stat-card"><div class="stat-label">Match reports</div><div class="stat-value">{totals.match_entries}</div></div>
        <div class="stat-card"><div class="stat-label">Pit profiles</div><div class="stat-value">{totals.pit_entries}</div></div>
        <div class="stat-card"><div class="stat-label">Scout notes</div><div class="stat-value">{totals.notes}</div></div>
        <div class="stat-card" class:problem-total={totals.open_problems > 0}><div class="stat-label">Open ACE problems</div><div class="stat-value">{totals.open_problems}</div></div>
      </div>

      {#if exportMessage}
        <p class:export-error={exportMessage.startsWith("Could not")} class="export-message">
          {exportMessage}
          {#if exportDocumentUrl}<a href={exportDocumentUrl} target="_blank" rel="noopener noreferrer">Open Google Doc</a>{/if}
        </p>
      {/if}

      <section class="analysis-section">
        <div class="analysis-section-header">
          <h4>Scouting Coverage by Team</h4>
          <span>Each bar combines all submitted report types.</span>
        </div>
        {#if analysisTeams.length}
          <div class="coverage-chart">
            {#each analysisTeams.slice(0, 20) as team}
              <div class="coverage-row">
                <div class="coverage-team">{displayTeam(team.team_key)}</div>
                <div class="coverage-track" title={`${team.total} total reports`}>
                  <div class="coverage-bar" style={`width:${Math.max(4, team.total / analysisMaxReports * 100)}%`}>
                    <span>{team.total}</span>
                  </div>
                </div>
                <div class="coverage-sources">D {team.data_events} · M {team.match_entries} · P {team.pit_entries} · N {team.notes}</div>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-muted">No submitted scouting records yet.</p>
        {/if}
      </section>

      <section class="analysis-section team-records">
        <div class="analysis-section-header">
          <h4>All Collected Team Data</h4>
          <span>Open a team to see each scouting source represented in Data Scouting.</span>
        </div>
        {#each analysisTeams as team}
          {@const pit = eventAnalysis.data.pit_entries.find((entry) => entry.team_key === team.team_key)}
          {@const matchEntries = eventAnalysis.data.match_entries.filter((entry) => entry.team_key === team.team_key)}
          {@const notes = eventAnalysis.data.notes.filter((entry) => entry.team_key === team.team_key)}
          {@const problems = eventAnalysis.data.pit_problems.filter((entry) => entry.team_key === team.team_key && !entry.resolved)}
          <details class="team-record">
            <summary>
              <strong>Team {displayTeam(team.team_key)}</strong>
              <span>{team.total} records</span>
            </summary>
            <div class="record-grid">
              <div><span class="label">Data scouting</span><p>{team.data_events} recorded observations, including any released vision observations.</p></div>
              <div><span class="label">Match scouting</span><p>{matchEntries.length ? `${matchEntries.length} report${matchEntries.length === 1 ? "" : "s"} submitted.` : "No match report submitted."}</p></div>
              <div><span class="label">Pit scouting</span><p>{pit ? `${pit.robot_archetype || "Robot profile"}${pit.estimated_bps != null ? ` · ${pit.estimated_bps} estimated BPS` : ""}` : "No pit profile submitted."}</p></div>
              <div><span class="label">Notes and problems</span><p>{notes.length} note{notes.length === 1 ? "" : "s"}{problems.length ? ` · ${problems.length} open ACE problem${problems.length === 1 ? "" : "s"}` : ""}</p></div>
            </div>
            {#if notes.length}
              <div class="record-notes">
                {#each notes.slice(0, 4) as note}<p>{note.notes}</p>{/each}
              </div>
            {/if}
          </details>
        {/each}
      </section>
    {/if}
  </section>
{:else if viewMode === "view"}
  <!-- View Mode -->
  <div class="card">
    <div class="view-header">
      <button class="btn btn-secondary" on:click={backToScout}>&larr; Back to Scout</button>
      <div class="view-title-row">
        <h3 style="margin:0">Team {displayTeam(selectedTeamForView)}</h3>
        {#if viewStats}
          <span class="matches-count">{viewStats.matchCount} match{viewStats.matchCount !== 1 ? "es" : ""} scouted</span>
        {/if}
      </div>
      <div class="form-group">
        <span class="label">Filter Match</span>
        <select class="form-select" bind:value={viewFilterMatch}>
          <option value="all">All Matches</option>
          {#each viewMatchKeys as mk}
            <option value={mk}>{mk.split("_").pop().toUpperCase()}</option>
          {/each}
        </select>
      </div>
    </div>

    {#if viewLoading}
      <div class="empty-state">Loading...</div>
    {:else if !viewStats}
      <div class="empty-state">No scouting data available for this team.</div>
    {:else}
      <!-- Stat Cards -->
      <div class="stat-cards-grid">
        <div class="stat-card">
          <div class="stat-label">Total Fuel (est.)</div>
          <div class="stat-value">{Math.round(viewStats.avgFuel)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Auto Fuel (est.)</div>
          <div class="stat-value">{Math.round(viewStats.avgAutoFuel)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Teleop Fuel (est.)</div>
          <div class="stat-value">{Math.round(viewStats.avgTeleopFuel)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Shooting Speed</div>
          <div class="stat-value">{viewStats.avgSpeed.toFixed(1)}<span class="stat-suffix"> f/s</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Shooting Accuracy</div>
          <div class="stat-value">{viewStats.avgAccuracy.toFixed(1)}<span class="stat-suffix">/5</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Driver Rank</div>
          <div class="stat-value">{viewStats.avgDriving.toFixed(1)}<span class="stat-suffix">/5</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">L1 Auto Climb Avg</div>
          <div class="stat-value">{viewStats.avgAutoClimbTime !== null ? viewStats.avgAutoClimbTime.toFixed(1) + "s" : "—"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Auto Climb Rate</div>
          <div class="stat-value">{viewStats.autoClimbRate.toFixed(2)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Dead in Auto</div>
          <div class="stat-value">{viewStats.autoDeadMatches}<span class="stat-suffix"> / {viewStats.matchCount}</span></div>
        </div>
      </div>

      <!-- Role Distribution -->
      {@const totalRoleTime = Object.values(viewStats.roleTimes).reduce((a, b) => a + b, 0)}
      {#if totalRoleTime > 0}
        <div class="view-section">
          <span class="label">Role Distribution</span>
          <div class="legend-row">
            <span class="legend-item"><span class="legend-dot" style="background:var(--scout-purple)"></span>Scoring</span>
            <span class="legend-item"><span class="legend-dot" style="background:var(--scout-orange)"></span>Shuttling</span>
            <span class="legend-item"><span class="legend-dot" style="background:var(--scout-danger)"></span>Defense</span>
            <span class="legend-item"><span class="legend-dot" style="background:var(--scout-success)"></span>Counter-Defense</span>
            <span class="legend-item"><span class="legend-dot" style="background:var(--scout-pink)"></span>Dead</span>
          </div>
          <div class="pickup-bar-row">
            <div class="stacked-bar pickup-bar" style="flex:1">
              {#if viewStats.roleTimes.Scoring > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.roleTimes.Scoring / totalRoleTime * 100).toFixed(1)}%;background:var(--scout-purple)" title="Scoring {(viewStats.roleTimes.Scoring / totalRoleTime * 100).toFixed(0)}%"></div>
              {/if}
              {#if viewStats.roleTimes.Shuttling > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.roleTimes.Shuttling / totalRoleTime * 100).toFixed(1)}%;background:var(--scout-orange)" title="Shuttling {(viewStats.roleTimes.Shuttling / totalRoleTime * 100).toFixed(0)}%"></div>
              {/if}
              {#if viewStats.roleTimes.Defense > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.roleTimes.Defense / totalRoleTime * 100).toFixed(1)}%;background:var(--scout-danger)" title="Defense {(viewStats.roleTimes.Defense / totalRoleTime * 100).toFixed(0)}%"></div>
              {/if}
              {#if viewStats.roleTimes["Counter Defense"] > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.roleTimes['Counter Defense'] / totalRoleTime * 100).toFixed(1)}%;background:var(--scout-success)" title="Counter Defense {(viewStats.roleTimes['Counter Defense'] / totalRoleTime * 100).toFixed(0)}%"></div>
              {/if}
              {#if viewStats.roleTimes.Dead > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.roleTimes.Dead / totalRoleTime * 100).toFixed(1)}%;background:var(--scout-pink)" title="Dead {(viewStats.roleTimes.Dead / totalRoleTime * 100).toFixed(0)}%"></div>
              {/if}
            </div>
            {#if viewFilterMatch === "all" && viewStats.matchCount > 1}
              <button type="button" class="btn-accordion" on:click={() => toggleSection('role')} title="Show per-match breakdown">
                {expandedSections['role'] ? '▼' : '▶'}
              </button>
            {/if}
          </div>
          {#if viewFilterMatch === "all" && expandedSections['role'] && viewStats.matchCount > 1}
            <div class="mini-bars-row">
              {#each viewMatchKeys as mk}
                {@const d = viewStats.roleTimesByMatch?.[mk]}
                {#if d}
                  {@const rt = d.Scoring + d.Shuttling + d.Defense + (d["Counter Defense"]||0) + d.Dead}
                  <div class="mini-bar-col">
                    <div class="mini-bar-vertical">
                      {#if rt > 0}
                        {#if d.Scoring > 0}
                          <div class="mini-bar-seg" style="flex:{d.Scoring};background:var(--scout-purple)"></div>
                        {/if}
                        {#if d.Shuttling > 0}
                          <div class="mini-bar-seg" style="flex:{d.Shuttling};background:var(--scout-orange)"></div>
                        {/if}
                        {#if d.Defense > 0}
                          <div class="mini-bar-seg" style="flex:{d.Defense};background:var(--scout-danger)"></div>
                        {/if}
                        {#if (d["Counter Defense"]||0) > 0}
                          <div class="mini-bar-seg" style="flex:{(d["Counter Defense"]||0)};background:var(--scout-success)"></div>
                        {/if}
                        {#if d.Dead > 0}
                          <div class="mini-bar-seg" style="flex:{d.Dead};background:var(--scout-pink)"></div>
                        {/if}
                      {:else}
                        <div class="mini-bar-seg empty-bar" style="flex:1"></div>
                      {/if}
                    </div>
                    <div class="mini-bar-label">{d.label}{#if (d.totalTime || 0) > 0} ({Math.round(d.totalTime)}s){/if}</div>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Shooting Distribution Auto -->
      {@const autoShootTotal = viewStats.shootingDist.auto.shuttling + viewStats.shootingDist.auto.scoring}
      <div class="view-section">
        <span class="label">Shooting Distribution Auto (Fuel)</span>
        <div class="legend-row">
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-orange)"></span>Shuttling</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-purple)"></span>Scoring</span>
        </div>
        <div class="pickup-bar-row">
          <div class="stacked-bar pickup-bar">
            {#if autoShootTotal > 0}
              {#if viewStats.shootingDist.auto.shuttling > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.shootingDist.auto.shuttling / autoShootTotal * 100).toFixed(1)}%;background:var(--scout-orange)" title="Shuttling {Math.round(viewStats.shootingDist.auto.shuttling)}"></div>
              {/if}
              {#if viewStats.shootingDist.auto.scoring > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.shootingDist.auto.scoring / autoShootTotal * 100).toFixed(1)}%;background:var(--scout-purple)" title="Scoring {Math.round(viewStats.shootingDist.auto.scoring)}"></div>
              {/if}
            {:else}
              <div class="bar-seg empty-bar" style="flex-basis:100%">No Data</div>
            {/if}
          </div>
          {#if viewFilterMatch === "all" && viewStats.matchCount > 1}
            <button type="button" class="btn-accordion" on:click={() => toggleSection('shootAuto')} title="Show per-match breakdown">
              {expandedSections['shootAuto'] ? '▼' : '▶'}
            </button>
          {:else}
            <span class="pickup-total">{Math.round(autoShootTotal)}</span>
          {/if}
        </div>
        {#if viewFilterMatch === "all" && expandedSections['shootAuto'] && viewStats.matchCount > 1}
          <div class="mini-bars-row">
            {#each viewMatchKeys as mk}
              {@const d = viewStats.shootingDistAutoByMatch?.[mk]}
              {#if d}
                {@const tot = d.shuttling + d.scoring}
                <div class="mini-bar-col">
                  <div class="mini-bar-vertical">
                    {#if tot > 0}
                      {#if d.shuttling > 0}
                        <div class="mini-bar-seg" style="flex:{d.shuttling};background:var(--scout-orange)"></div>
                      {/if}
                      {#if d.scoring > 0}
                        <div class="mini-bar-seg" style="flex:{d.scoring};background:var(--scout-purple)"></div>
                      {/if}
                    {:else}
                      <div class="mini-bar-seg empty-bar" style="flex:1"></div>
                    {/if}
                  </div>
                  <div class="mini-bar-label">{d.label}{#if (d.totalTime || 0) > 0} ({(d.totalTime).toFixed(1)}s){/if}</div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Shooting Distribution Teleop -->
      {@const teleopShootTotal = viewStats.shootingDist.teleop.shuttling + viewStats.shootingDist.teleop.scoring}
      <div class="view-section">
        <span class="label">Shooting Distribution Teleop (Fuel)</span>
        <div class="legend-row">
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-orange)"></span>Shuttling</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-purple)"></span>Scoring</span>
        </div>
        <div class="pickup-bar-row">
          <div class="stacked-bar pickup-bar">
            {#if teleopShootTotal > 0}
              {#if viewStats.shootingDist.teleop.shuttling > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.shootingDist.teleop.shuttling / teleopShootTotal * 100).toFixed(1)}%;background:var(--scout-orange)" title="Shuttling {Math.round(viewStats.shootingDist.teleop.shuttling)}"></div>
              {/if}
              {#if viewStats.shootingDist.teleop.scoring > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.shootingDist.teleop.scoring / teleopShootTotal * 100).toFixed(1)}%;background:var(--scout-purple)" title="Scoring {Math.round(viewStats.shootingDist.teleop.scoring)}"></div>
              {/if}
            {:else}
              <div class="bar-seg empty-bar" style="flex-basis:100%">No Data</div>
            {/if}
          </div>
          {#if viewFilterMatch === "all" && viewStats.matchCount > 1}
            <button type="button" class="btn-accordion" on:click={() => toggleSection('shootTeleop')} title="Show per-match breakdown">
              {expandedSections['shootTeleop'] ? '▼' : '▶'}
            </button>
          {:else}
            <span class="pickup-total">{Math.round(teleopShootTotal)}</span>
          {/if}
        </div>
        {#if viewFilterMatch === "all" && expandedSections['shootTeleop'] && viewStats.matchCount > 1}
          <div class="mini-bars-row">
            {#each viewMatchKeys as mk}
              {@const d = viewStats.shootingDistTeleopByMatch?.[mk]}
              {#if d}
                {@const tot = d.shuttling + d.scoring}
                <div class="mini-bar-col">
                  <div class="mini-bar-vertical">
                    {#if tot > 0}
                      {#if d.shuttling > 0}
                        <div class="mini-bar-seg" style="flex:{d.shuttling};background:var(--scout-orange)"></div>
                      {/if}
                      {#if d.scoring > 0}
                        <div class="mini-bar-seg" style="flex:{d.scoring};background:var(--scout-purple)"></div>
                      {/if}
                    {:else}
                      <div class="mini-bar-seg empty-bar" style="flex:1"></div>
                    {/if}
                  </div>
                  <div class="mini-bar-label">{d.label}{#if (d.totalTime || 0) > 0} ({(d.totalTime).toFixed(1)}s){/if}</div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Pickup Auto -->
      {@const autoTotal = viewStats.autoPickups.ground + viewStats.autoPickups.depot + viewStats.autoPickups.outpost}
      <div class="view-section">
        <span class="label">Pickup Auto</span>
        <div class="legend-row">
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-orange)"></span>Ground</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-purple)"></span>Outpost</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-pink)"></span>Depot</span>
        </div>
        <div class="pickup-bar-row">
          <div class="stacked-bar pickup-bar">
            {#if autoTotal > 0}
              {#if viewStats.autoPickups.ground > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.autoPickups.ground / autoTotal * 100).toFixed(1)}%;background:var(--scout-orange)" title="Ground {viewStats.autoPickups.ground}"></div>
              {/if}
              {#if viewStats.autoPickups.outpost > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.autoPickups.outpost / autoTotal * 100).toFixed(1)}%;background:var(--scout-purple)" title="Outpost {viewStats.autoPickups.outpost}"></div>
              {/if}
              {#if viewStats.autoPickups.depot > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.autoPickups.depot / autoTotal * 100).toFixed(1)}%;background:var(--scout-pink)" title="Depot {viewStats.autoPickups.depot}"></div>
              {/if}
            {:else}
              <div class="bar-seg empty-bar" style="flex-basis:100%">No Data</div>
            {/if}
          </div>
          {#if viewFilterMatch === "all" && viewStats.matchCount > 1}
            <button type="button" class="btn-accordion" on:click={() => toggleSection('pickupAuto')} title="Show per-match breakdown">
              {expandedSections['pickupAuto'] ? '▼' : '▶'}
            </button>
          {:else}
            <span class="pickup-total">{autoTotal}</span>
          {/if}
        </div>
        {#if viewFilterMatch === "all" && expandedSections['pickupAuto'] && viewStats.matchCount > 1}
          <div class="mini-bars-row">
            {#each viewMatchKeys as mk}
              {@const d = viewStats.autoPickupsByMatch?.[mk]}
              {#if d}
                {@const tot = d.ground + d.depot + d.outpost}
                <div class="mini-bar-col">
                  <div class="mini-bar-vertical">
                    {#if tot > 0}
                      {#if d.ground > 0}
                        <div class="mini-bar-seg" style="flex:{d.ground};background:var(--scout-orange)"></div>
                      {/if}
                      {#if d.outpost > 0}
                        <div class="mini-bar-seg" style="flex:{d.outpost};background:var(--scout-purple)"></div>
                      {/if}
                      {#if d.depot > 0}
                        <div class="mini-bar-seg" style="flex:{d.depot};background:var(--scout-pink)"></div>
                      {/if}
                    {:else}
                      <div class="mini-bar-seg empty-bar" style="flex:1"></div>
                    {/if}
                  </div>
                  <div class="mini-bar-label">{d.label}</div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Pickup Teleop -->
      {@const teleopTotal = viewStats.teleopPickups.ground + viewStats.teleopPickups.depot + viewStats.teleopPickups.outpost}
      <div class="view-section">
        <span class="label">Pickup Teleop</span>
        <div class="legend-row">
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-orange)"></span>Ground</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-purple)"></span>Outpost</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-pink)"></span>Depot</span>
        </div>
        <div class="pickup-bar-row">
          <div class="stacked-bar pickup-bar">
            {#if teleopTotal > 0}
              {#if viewStats.teleopPickups.ground > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopPickups.ground / teleopTotal * 100).toFixed(1)}%;background:var(--scout-orange)" title="Ground {viewStats.teleopPickups.ground}"></div>
              {/if}
              {#if viewStats.teleopPickups.outpost > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopPickups.outpost / teleopTotal * 100).toFixed(1)}%;background:var(--scout-purple)" title="Outpost {viewStats.teleopPickups.outpost}"></div>
              {/if}
              {#if viewStats.teleopPickups.depot > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopPickups.depot / teleopTotal * 100).toFixed(1)}%;background:var(--scout-pink)" title="Depot {viewStats.teleopPickups.depot}"></div>
              {/if}
            {:else}
              <div class="bar-seg empty-bar" style="flex-basis:100%">No Data</div>
            {/if}
          </div>
          {#if viewFilterMatch === "all" && viewStats.matchCount > 1}
            <button type="button" class="btn-accordion" on:click={() => toggleSection('pickupTeleop')} title="Show per-match breakdown">
              {expandedSections['pickupTeleop'] ? '▼' : '▶'}
            </button>
          {:else}
            <span class="pickup-total">{teleopTotal}</span>
          {/if}
        </div>
        {#if viewFilterMatch === "all" && expandedSections['pickupTeleop'] && viewStats.matchCount > 1}
          <div class="mini-bars-row">
            {#each viewMatchKeys as mk}
              {@const d = viewStats.teleopPickupsByMatch?.[mk]}
              {#if d}
                {@const tot = d.ground + d.depot + d.outpost}
                <div class="mini-bar-col">
                  <div class="mini-bar-vertical">
                    {#if tot > 0}
                      {#if d.ground > 0}
                        <div class="mini-bar-seg" style="flex:{d.ground};background:var(--scout-orange)"></div>
                      {/if}
                      {#if d.outpost > 0}
                        <div class="mini-bar-seg" style="flex:{d.outpost};background:var(--scout-purple)"></div>
                      {/if}
                      {#if d.depot > 0}
                        <div class="mini-bar-seg" style="flex:{d.depot};background:var(--scout-pink)"></div>
                      {/if}
                    {:else}
                      <div class="mini-bar-seg empty-bar" style="flex:1"></div>
                    {/if}
                  </div>
                  <div class="mini-bar-label">{d.label}</div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Climb Time Stat Cards -->
      {@const l1Times = viewStats.climbTimes.filter((c) => c.climbPos === "L1" && c.climbTime != null)}
      {@const l2Times = viewStats.climbTimes.filter((c) => c.climbPos === "L2" && c.climbTime != null)}
      {@const l3Times = viewStats.climbTimes.filter((c) => c.climbPos === "L3" && c.climbTime != null)}
      <div class="view-section">
        <span class="label">Climb Time Teleop</span>
        <div class="stat-cards-grid three-col">
          <div class="stat-card">
            <div class="stat-label">L1 Teleop Climb Time</div>
            <div class="stat-value">{l1Times.length > 0 ? (l1Times.reduce((a, c) => a + c.climbTime, 0) / l1Times.length).toFixed(1) + "s" : "—"}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">L2 Teleop Climb Time</div>
            <div class="stat-value">{l2Times.length > 0 ? (l2Times.reduce((a, c) => a + c.climbTime, 0) / l2Times.length).toFixed(1) + "s" : "—"}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">L3 Teleop Climb Time</div>
            <div class="stat-value">{l3Times.length > 0 ? (l3Times.reduce((a, c) => a + c.climbTime, 0) / l3Times.length).toFixed(1) + "s" : "—"}</div>
          </div>
        </div>
      </div>

      <!-- Climb Time Distribution Auto (None, L1, Failed) -->
      {@const autoClimbTotal = viewStats.autoClimbDist.none.count + viewStats.autoClimbDist.L1.count + viewStats.autoClimbDist.failed.count}
      <div class="view-section">
        <span class="label">Climb Time Distribution Auto</span>
        <div class="legend-row">
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-secondary)"></span>None</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-info)"></span>L1</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-danger)"></span>Failed</span>
        </div>
        <div class="pickup-bar-row">
          <div class="stacked-bar pickup-bar" style="flex:1">
            {#if autoClimbTotal > 0}
              {#if viewStats.autoClimbDist.none.count > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.autoClimbDist.none.count / autoClimbTotal * 100).toFixed(1)}%;background:var(--scout-secondary)" title="None {viewStats.autoClimbDist.none.count} matches">None</div>
              {/if}
              {#if viewStats.autoClimbDist.L1.count > 0}
                {@const avgL1 = (viewStats.autoClimbDist.L1.totalTime / viewStats.autoClimbDist.L1.count).toFixed(1)}
                <div class="bar-seg" style="flex-basis:{(viewStats.autoClimbDist.L1.count / autoClimbTotal * 100).toFixed(1)}%;background:var(--scout-info)" title="L1: {viewStats.autoClimbDist.L1.count} matches, avg {avgL1}s">{avgL1}s</div>
              {/if}
              {#if viewStats.autoClimbDist.failed.count > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.autoClimbDist.failed.count / autoClimbTotal * 100).toFixed(1)}%;background:var(--scout-danger)" title="Failed {viewStats.autoClimbDist.failed.count} matches">Failed</div>
              {/if}
            {:else}
              <div class="bar-seg empty-bar" style="flex-basis:100%">—</div>
            {/if}
          </div>
          {#if viewFilterMatch === "all" && viewStats.matchCount > 1}
            <button type="button" class="btn-accordion" on:click={() => toggleSection('climbAuto')} title="Show per-match breakdown">
              {expandedSections['climbAuto'] ? '▼' : '▶'}
            </button>
          {/if}
        </div>
        {#if viewFilterMatch === "all" && expandedSections['climbAuto'] && viewStats.matchCount > 1}
          <div class="mini-bars-row">
            {#each viewMatchKeys as mk}
              {@const d = viewStats.autoClimbDistByMatch?.[mk]}
              {#if d}
                {@const tot = d.none + d.L1 + d.failed}
                <div class="mini-bar-col">
                  <div class="mini-bar-vertical">
                    {#if tot > 0}
                      {#if d.none > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-secondary)"></div>
                      {/if}
                      {#if d.L1 > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-info)"></div>
                      {/if}
                      {#if d.failed > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-danger)"></div>
                      {/if}
                    {:else}
                      <div class="mini-bar-seg empty-bar" style="flex:1"></div>
                    {/if}
                  </div>
                  <div class="mini-bar-label">{d.label}{#if (d.l1Time || 0) > 0} ({(d.l1Time).toFixed(1)}s){/if}</div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Climb Time Distribution Teleop (None, L1, L2, L3, Failed) -->
      {@const teleopClimbTotal = viewStats.teleopClimbDist.none.count + viewStats.teleopClimbDist.L1.count + viewStats.teleopClimbDist.L2.count + viewStats.teleopClimbDist.L3.count + viewStats.teleopClimbDist.failed.count}
      <div class="view-section">
        <span class="label">Climb Time Distribution Teleop</span>
        <div class="legend-row">
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-secondary)"></span>None</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-info)"></span>L1</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-teal)"></span>L2</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-purple)"></span>L3</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--scout-danger)"></span>Failed</span>
        </div>
        <div class="pickup-bar-row">
          <div class="stacked-bar pickup-bar" style="flex:1">
            {#if teleopClimbTotal > 0}
              {#if viewStats.teleopClimbDist.none.count > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopClimbDist.none.count / teleopClimbTotal * 100).toFixed(1)}%;background:var(--scout-secondary)" title="None {viewStats.teleopClimbDist.none.count} matches">None</div>
              {/if}
              {#if viewStats.teleopClimbDist.L1.count > 0}
                {@const avgL1T = (viewStats.teleopClimbDist.L1.totalTime / viewStats.teleopClimbDist.L1.count).toFixed(1)}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopClimbDist.L1.count / teleopClimbTotal * 100).toFixed(1)}%;background:var(--scout-info)" title="L1: {viewStats.teleopClimbDist.L1.count} matches, avg {avgL1T}s">{avgL1T}s</div>
              {/if}
              {#if viewStats.teleopClimbDist.L2.count > 0}
                {@const avgL2T = (viewStats.teleopClimbDist.L2.totalTime / viewStats.teleopClimbDist.L2.count).toFixed(1)}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopClimbDist.L2.count / teleopClimbTotal * 100).toFixed(1)}%;background:var(--scout-teal)" title="L2: {viewStats.teleopClimbDist.L2.count} matches, avg {avgL2T}s">{avgL2T}s</div>
              {/if}
              {#if viewStats.teleopClimbDist.L3.count > 0}
                {@const avgL3T = (viewStats.teleopClimbDist.L3.totalTime / viewStats.teleopClimbDist.L3.count).toFixed(1)}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopClimbDist.L3.count / teleopClimbTotal * 100).toFixed(1)}%;background:var(--scout-purple)" title="L3: {viewStats.teleopClimbDist.L3.count} matches, avg {avgL3T}s">{avgL3T}s</div>
              {/if}
              {#if viewStats.teleopClimbDist.failed.count > 0}
                <div class="bar-seg" style="flex-basis:{(viewStats.teleopClimbDist.failed.count / teleopClimbTotal * 100).toFixed(1)}%;background:var(--scout-danger)" title="Failed {viewStats.teleopClimbDist.failed.count} matches">Failed</div>
              {/if}
            {:else}
              <div class="bar-seg empty-bar" style="flex-basis:100%">—</div>
            {/if}
          </div>
          {#if viewFilterMatch === "all" && viewStats.matchCount > 1}
            <button type="button" class="btn-accordion" on:click={() => toggleSection('climbTeleop')} title="Show per-match breakdown">
              {expandedSections['climbTeleop'] ? '▼' : '▶'}
            </button>
          {/if}
        </div>
        {#if viewFilterMatch === "all" && expandedSections['climbTeleop'] && viewStats.matchCount > 1}
          <div class="mini-bars-row">
            {#each viewMatchKeys as mk}
              {@const d = viewStats.teleopClimbDistByMatch?.[mk]}
              {#if d}
                {@const tot = d.none + d.L1 + d.L2 + d.L3 + d.failed}
                <div class="mini-bar-col">
                  <div class="mini-bar-vertical">
                    {#if tot > 0}
                      {#if d.none > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-secondary)"></div>
                      {/if}
                      {#if d.L1 > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-info)"></div>
                      {/if}
                      {#if d.L2 > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-teal)"></div>
                      {/if}
                      {#if d.L3 > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-purple)"></div>
                      {/if}
                      {#if d.failed > 0}
                        <div class="mini-bar-seg" style="flex:1;background:var(--scout-danger)"></div>
                      {/if}
                    {:else}
                      <div class="mini-bar-seg empty-bar" style="flex:1"></div>
                    {/if}
                  </div>
                  <div class="mini-bar-label">{d.label}{#if (d.climbTime || 0) > 0} ({(d.climbTime).toFixed(1)}s){/if}</div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <!-- Scouting Console -->
  <div class="card console">
    {#if selectedMatchKey === "__manual__"}
      <div class="manual-match-setup">
        <div class="form-group">
          <label class="label" for="manualMatchLabel">Manual Match Label</label>
          <input
            id="manualMatchLabel"
            class="form-input"
            bind:value={manualMatchLabel}
            placeholder="Practice 1"
          />
        </div>
        <div class="form-group">
          <label class="label" for="manualTeamInput">Team</label>
          <input
            id="manualTeamInput"
            class="form-input"
            bind:value={manualTeamInput}
            list="event-team-options"
            placeholder="971 or frc971"
          />
          <datalist id="event-team-options">
            {#each eventTeams as team}
              <option value={displayTeam(team)}></option>
              <option value={team}></option>
            {/each}
          </datalist>
        </div>
      </div>
    {/if}

    {#if !selectedMatch || !selectedTeam}
      {#if selectedMatchKey === "__manual__"}
        <div class="empty-state">Enter a manual match label and team to begin scouting.</div>
      {:else}
        <div class="empty-state">Please select a match to begin scouting.</div>
      {/if}
    {:else}
      <!-- Header Info -->
      <div class="console-header">
        <div class="info-block">
          <span class="label">Match</span>
          <div class="val">
            {formatMatchLabel(selectedMatch)}
            {#if tbaMatchUrl}
              <a
                href={tbaMatchUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="tba-link"
                title="View this match on The Blue Alliance"
              >TBA ↗</a>
            {/if}
          </div>
        </div>
        <div class="info-block" style="flex-grow:1">
          <span class="label" for="teamScout">Team</span>
          {#if selectedMatchKey === "__manual__"}
            <input
              id="teamScout"
              class="form-input large"
              bind:value={manualTeamInput}
              list="event-team-options"
              placeholder="971 or frc971"
            />
          {:else}
            <select
              id="teamScout"
              class="form-select large"
              bind:value={selectedTeam}
            >
              {#each teamsCurrentMatch as t}<option value={t}
                  >{displayTeam(t)}</option
                >{/each}
            </select>
          {/if}
        </div>
        {#if selectedTeamEPA}
          <div class="info-block" title="TBA OPR - overall power ranking">
            <span class="label">OPR (Rank {selectedTeamEPA.rank ?? "—"})</span>
            <div class="val">{selectedTeamEPA.epa?.toFixed(1) ?? "—"}</div>
          </div>
        {/if}
        <div class="info-block">
          <span class="label">Phase</span>
          <div class="phase-badge {phase}">{phase.toUpperCase()}</div>
        </div>
        <div class="undo-block">
          <button
            class="btn btn-danger undo-btn"
            on:click={(e) => {
              handleButtonClick(e);
              undoLast();
            }}
            disabled={scoutingEvents.length === 0}
            title="Undo last action"
          >
            UNDO
          </button>
        </div>
      </div>

      <hr class="divider" />

      <!-- PRE PHASE -->
      {#if phase === "pre"}
        <div class="phase-section pre-state">
          <span class="label">Auto Start Position</span>
          <div class="btn-row">
            {#each [
              { label: "Left Trench", value: "left trench" },
              { label: "Left Mound", value: "left mound" },
              { label: "Center", value: "center" },
              { label: "Right Mound", value: "right mound" },
              { label: "Right Trench", value: "right trench" },
            ] as p}
              <button
                class="btn {startPosition === p.value
                  ? 'btn-selected'
                  : 'btn-outline'} big-btn"
                on:click={(e) => {
                  handleButtonClick(e);
                  chooseStart(p.value);
                }}>{p.label}</button
              >
            {/each}
          </div>
          <button
            class="btn btn-success action-btn full-width"
            disabled={!startPosition}
            on:click={(e) => {
              handleButtonClick(e);
              beginAuto();
            }}
          >
            START MATCH (AUTO)
          </button>
        </div>
      {/if}

      <!-- AUTO PHASE -->
      {#if phase === "auto"}
        <div
          class="phase-section auto-phase auto-phase-main"
          bind:this={autoTopSection}
        >
          <div class="auto-live-zone">
            <div class="auto-live-middle" class:auto-disabled={autoDead}>
              <span class="label">Pick Up</span>
              <div class="btn-grid auto-grid auto-pickup-grid auto-panel">
                <button
                  class="btn {holdTimers['pickup_ground']
                    ? 'btn-selected'
                    : 'btn-outline'} big-btn"
                  disabled={autoDead}
                  on:mousedown={() =>
                    startVisualAction("pickup_ground", () =>
                      recordPickup("ground"),
                    )}
                  on:mouseup={() => endVisualAction("pickup_ground")}
                  on:mouseleave={() => endVisualAction("pickup_ground")}
                  on:touchstart|preventDefault={() =>
                    startVisualAction("pickup_ground", () =>
                      recordPickup("ground"),
                    )}
                  on:touchend|preventDefault={() =>
                    endVisualAction("pickup_ground")}>Ground</button
                >
                <button
                  class="btn {holdTimers['pickup_depot']
                    ? 'btn-selected'
                    : 'btn-outline'} big-btn"
                  disabled={autoDead}
                  on:mousedown={() =>
                    startVisualAction("pickup_depot", () =>
                      recordPickup("depot"))}
                  on:mouseup={() => endVisualAction("pickup_depot")}
                  on:mouseleave={() => endVisualAction("pickup_depot")}
                  on:touchstart|preventDefault={() =>
                    startVisualAction("pickup_depot", () =>
                      recordPickup("depot"))}
                  on:touchend|preventDefault={() =>
                    endVisualAction("pickup_depot")}>Depot</button
                >
                <button
                  class="btn {holdTimers['pickup_outpost']
                    ? 'btn-selected'
                    : 'btn-outline'} big-btn"
                  disabled={autoDead}
                  on:mousedown={() =>
                    startVisualAction("pickup_outpost", () =>
                      recordPickup("outpost"),
                    )}
                  on:mouseup={() => endVisualAction("pickup_outpost")}
                  on:mouseleave={() => endVisualAction("pickup_outpost")}
                  on:touchstart|preventDefault={() =>
                    startVisualAction("pickup_outpost", () =>
                      recordPickup("outpost"),
                    )}
                  on:touchend|preventDefault={() =>
                    endVisualAction("pickup_outpost")}>Outpost</button
                >
              </div>
            </div>

            <div class="auto-live-middle" class:auto-disabled={autoDead}>
              <span class="label">Shooting (Hold)</span>
              <div class="btn-grid auto-grid auto-shoot-grid auto-panel">
                <button
                  class="btn {holdTimers['shooting_shuttling']
                    ? 'btn-selected-blue'
                    : 'btn-outline'} big-btn"
                  disabled={autoDead}
                  on:mousedown={() => startAction("shooting", "shuttling")}
                  on:mouseup={() => endAction("shooting", "shuttling")}
                  on:touchstart|preventDefault={() =>
                    startAction("shooting", "shuttling")}
                  on:touchend|preventDefault={() =>
                    endAction("shooting", "shuttling")}>Shuttling</button
                >

                <button
                  class="btn {holdTimers['shooting_scoring']
                    ? 'btn-selected-blue'
                    : 'btn-outline'} big-btn"
                  disabled={autoDead}
                  on:mousedown={() => startAction("shooting", "scoring")}
                  on:mouseup={() => endAction("shooting", "scoring")}
                  on:touchstart|preventDefault={() =>
                    startAction("shooting", "scoring")}
                  on:touchend|preventDefault={() =>
                    endAction("shooting", "scoring")}>Scoring</button
                >
              </div>
            </div>

            <div class="auto-live-bottom">
              <span class="label">Climbing (Hold)</span>
              <button
                class="btn {holdTimers['climbing_generic']
                  ? 'btn-selected-blue'
                  : 'btn-outline'} big-btn full-width auto-climb-btn"
                disabled={autoDead}
                on:mousedown={() => startAction("climbing", "generic")}
                on:mouseup={() => endAction("climbing", "generic")}
                on:touchstart|preventDefault={() =>
                  startAction("climbing", "generic")}
                on:touchend|preventDefault={() =>
                  endAction("climbing", "generic")}>Climbing</button
              >

              <div class="auto-panel">
                <div class="form-group">
                  <span class="label">Auto Climb Position</span>
                  <div class="btn-grid auto-grid auto-climb-grid">
                    {#each ["N/A", "L1", "Failed"] as p}
                      <button
                        class="btn {autoClimbPos === p
                          ? 'btn-selected'
                          : 'btn-outline'} big-btn"
                        disabled={autoDead}
                        on:click={(e) => {
                          handleButtonClick(e);
                          autoClimbPos = p;
                        }}>{p}</button
                      >
                    {/each}
                  </div>
                </div>

              <div class="auto-bottom-row">
                <button
                  class="btn {autoDead ? 'btn-danger' : 'btn-outline'} action-btn auto-dead-btn"
                  on:click={(e) => {
                    handleButtonClick(e);
                    toggleAutoDead();
                  }}
                >
                  {autoDead ? "DEAD" : "DEAD"}
                </button>
                <button
                  class="btn btn-success action-btn auto-next-btn"
                  on:click={(e) => {
                    handleButtonClick(e);
                    endAuto();
                  }}
                >
                  START TELEOP
                </button>
              </div>
              </div>
            </div>
          </div>
        </div>
      {/if}

      <!-- TELEOP PHASE -->
      {#if phase === "teleop"}
        <div
          class="phase-section teleop-phase teleop-phase-main"
          bind:this={teleopTopSection}
        >
          <div class="teleop-live-zone">
            <div class="teleop-config teleop-panel">
              <div class="role-selector">
                <span class="label">Current robot role / status</span>
                <div class="btn-grid teleop-option-grid teleop-role-grid">
                  {#each ROLES as r}
                    <button
                      class="btn {currentRole === r
                        ? 'btn-selected'
                        : 'btn-outline'} big-btn"
                      on:click={(e) => {
                        handleButtonClick(e);
                        setRole(r);
                      }}>{r === "Dead" ? "Disabled / Dead" : r}</button
                    >
                  {/each}
                </div>
              </div>
            </div>

            <div class="teleop-live-middle">
              <span class="label">Robot action — hold only while it is happening</span>
              <p class="control-help">These buttons time what the robot is doing; they do not add scored fuel.</p>
              <div class="btn-grid teleop-action-grid teleop-panel">
                <button
                  class="btn {holdTimers['shooting_shuttling']
                    ? 'btn-selected-blue'
                    : 'btn-outline'} big-btn"
                  on:mousedown={() => startAction("shooting", "shuttling")}
                  on:mouseup={() => endAction("shooting", "shuttling")}
                  on:touchstart|preventDefault={() =>
                    startAction("shooting", "shuttling")}
                  on:touchend|preventDefault={() =>
                    endAction("shooting", "shuttling")}>Shuttling fuel</button
                >

                <button
                  class="btn {holdTimers['pushing_outpost_tele']
                    ? 'btn-selected'
                    : 'btn-outline'} big-btn"
                  on:mousedown={() =>
                    startVisualAction("pushing_outpost_tele", () =>
                      recordPushing(),
                    )}
                  on:mouseup={() => endVisualAction("pushing_outpost_tele")}
                  on:mouseleave={() => endVisualAction("pushing_outpost_tele")}
                  on:touchstart|preventDefault={() =>
                    startVisualAction("pushing_outpost_tele", () =>
                      recordPushing(),
                    )}
                  on:touchend|preventDefault={() =>
                    endVisualAction("pushing_outpost_tele")}
                  >Feeding outpost</button
                >
                <button
                  class="btn {holdTimers['shooting_scoring']
                    ? 'btn-selected-blue'
                    : 'btn-outline'} big-btn teleop-action-wide"
                  on:mousedown={() => startAction("shooting", "scoring")}
                  on:mouseup={() => endAction("shooting", "scoring")}
                  on:touchstart|preventDefault={() =>
                    startAction("shooting", "scoring")}
                  on:touchend|preventDefault={() =>
                    endAction("shooting", "scoring")}>Shooting at hub</button
                >
              </div>
            </div>

            <div class="teleop-live-middle">
              <span class="label">Scored fuel — tap once per fuel</span>
              <p class="control-help">Each tap adds exactly one to the displayed total.</p>
              <div class="btn-grid teleop-action-grid teleop-panel">
                <button
                  class="btn btn-outline big-btn fuel-count-btn"
                  on:click={(e) => {
                    handleButtonClick(e);
                    recordFuelScore("shuttle");
                  }}
                >
                  +1 Shuttle
                  <span class="fuel-count-badge">{shuttleFuelCount}</span>
                </button>
                <button
                  class="btn btn-outline big-btn fuel-count-btn"
                  on:click={(e) => {
                    handleButtonClick(e);
                    recordFuelScore("hub");
                  }}
                >
                  +1 Hub
                  <span class="fuel-count-badge">{hubFuelCount}</span>
                </button>
              </div>
              <details class="fuel-corrections">
                <summary>Correct a total</summary>
              <div class="fuel-override-row">
                <div class="fuel-override-input">
                  <label for="shuttleFuelOverride">Set Shuttle total</label>
                  <input
                    id="shuttleFuelOverride"
                    type="number"
                    min="0"
                    inputmode="numeric"
                    bind:value={shuttleFuelOverrideInput}
                    placeholder={String(shuttleFuelCount)}
                  />
                  <button
                    class="btn btn-sm btn-outline"
                    disabled={shuttleFuelOverrideInput === ""}
                    on:click={() => {
                      recordFuelOverride("shuttle", shuttleFuelOverrideInput);
                      shuttleFuelOverrideInput = "";
                    }}>Set</button
                  >
                </div>
                <div class="fuel-override-input">
                  <label for="hubFuelOverride">Set Hub total</label>
                  <input
                    id="hubFuelOverride"
                    type="number"
                    min="0"
                    inputmode="numeric"
                    bind:value={hubFuelOverrideInput}
                    placeholder={String(hubFuelCount)}
                  />
                  <button
                    class="btn btn-sm btn-outline"
                    disabled={hubFuelOverrideInput === ""}
                    on:click={() => {
                      recordFuelOverride("hub", hubFuelOverrideInput);
                      hubFuelOverrideInput = "";
                    }}>Set</button
                  >
                </div>
              </div>
              </details>
            </div>

            <div class="teleop-live-bottom">
              <span class="label">Climbing (Hold)</span>
              <button
                class="btn {holdTimers['climbing_generic']
                  ? 'btn-selected-blue'
                  : 'btn-outline'} big-btn full-width teleop-climb-btn"
                on:mousedown={() => startAction("climbing", "generic")}
                on:mouseup={() => endAction("climbing", "generic")}
                on:touchstart|preventDefault={() =>
                  startAction("climbing", "generic")}
                on:touchend|preventDefault={() =>
                  endAction("climbing", "generic")}>Climbing</button
              >
            </div>
          </div>
        </div>

        <hr class="divider" />

        <div class="phase-section teleop-phase teleop-phase-secondary">
          <div class="form-group mt-1">
            <span class="label">Endgame result</span>
            <div class="btn-grid teleop-option-grid teleop-climb-grid">
              {#each CLIMB_POSITIONS as p}
                <button
                  class="btn {finalClimbPos === p
                    ? 'btn-selected'
                    : 'btn-outline'} big-btn"
                  on:click={(e) => {
                    handleButtonClick(e);
                    finalClimbPos = p;
                  }}>{p}</button
                >
              {/each}
            </div>
          </div>

          <div class="form-group mt-1">
            <label class="label" for="matchNotes">Notes (optional)</label>
            <textarea
              id="matchNotes"
              class="form-input match-notes-input"
              rows="4"
              bind:value={matchNotes}
              placeholder="Anything important for strategy? Leave blank if not."
            ></textarea>
          </div>

          <div class="spacer"></div>
          <button
            class="btn btn-success action-btn full-width teleop-submit-btn"
            style="margin-bottom: 2rem;"
            disabled={submittingMatch}
            on:click={(e) => {
              handleButtonClick(e);
              submitMatch();
            }}
          >
            {submittingMatch ? "SUBMITTING..." : "SUBMIT MATCH"}
          </button>
        </div>
      {/if}

      <!-- ENDGAME PHASE -->

      <!-- FINISHED PHASE -->
      {#if phase === "finished"}
        <div class="finished-state">
          <h3>Match Submitted!</h3>
          <p>Select a new match or team to scout again.</p>
          <button class="btn btn-outline" on:click={onSelectMatchByKey}
            >Reset for next team</button
          >
        </div>
      {/if}

      <!-- Live Event Feed (Mini) -->
      {#if scoutingEvents.length > 0}
        <div class="mini-log">
          <div class="log-header">Session Log ({scoutingEvents.length})</div>
          <div class="log-entries">
            {#each [...scoutingEvents].reverse().slice(0, 5) as e}
              <div class="log-entry">
                {e.phase.toUpperCase()[0]} - {e.event_type}: {e.event_value ||
                  ""}
                {#if e.role}[{e.role}]{/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .manual-match-setup {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--gap-3);
    margin-bottom: var(--gap-3);
  }

  /* Reuse main variables from global css if available, else standard fallback */
  :root {
    --scout-primary: var(--chart-primary);
    --scout-secondary: var(--chart-secondary);
    --scout-success: var(--chart-success);
    --scout-danger: var(--chart-danger);
    --scout-dark: #212529;
    --scout-light: #f8f9fa;
    --scout-border: #dee2e6;
    /* Categorical chart colors (match role / climb level) - same idea as
       the block above (a local, page-scoped token set instead of raw hex
       repeated dozens of times), extended to cover the colors this page's
       charts actually use that the original --scout-* set didn't. */
    --scout-purple: var(--chart-purple);
    --scout-orange: var(--chart-orange);
    --scout-pink: var(--chart-pink);
    --scout-info: var(--chart-info);
    --scout-teal: var(--chart-teal);
    --stage-height: 450px;
    --stage-width: 450px; /* Half of 900px */
    --full-travel: 900px;
    --ball-size: 1.5rem;
    --ball-peak: -300px;
    --ball-duration: 3s; /* 900px / 3s = 300px/s */
  }

  @media (max-width: 600px) {
    :root {
      --stage-height: 250px;
      --stage-width: 300px; /* Half of 600px */
      --full-travel: 600px;
      --ball-size: 1rem;
      --ball-peak: -150px;
      --ball-duration: 2s; /* 600px / 2s = 300px/s */
    }
  }

  .mt-1 {
    margin-top: 0.25rem;
  }
  .full-width {
    width: 100%;
  }
  .spacer {
    height: 0.5rem;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
  }
  .sub-label {
    font-size: 0.85rem;
    color: var(--scout-secondary);
  }
  .note {
    color: var(--scout-danger);
    font-size: 1rem;
    margin-top: 0.25rem;
  }

  .page-actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .assignment-team-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
    align-items: center;
  }
  .assignment-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    color: var(--scout-secondary);
    font-weight: 600;
  }
  .assignment-note {
    font-size: 0.7rem;
    color: var(--scout-secondary);
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }

  .card {
    background: white;
    border: 1px solid var(--scout-border);
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  }

  /* Console Header */
  .console-header {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.25rem;
    padding: 0.25rem 0;
  }
  .label,
  .form-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    color: var(--scout-secondary);
    display: block;
    margin-bottom: 0.1rem;
    font-weight: 600;
  }
  .info-block .val {
    font-size: 1rem;
    font-weight: bold;
  }
  .tba-link {
    margin-left: 0.4rem;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--scout-primary);
    text-decoration: none;
    white-space: nowrap;
  }
  .tba-link:hover {
    text-decoration: underline;
  }
  .undo-btn {
    padding: 0.8rem 0.6rem;
  }
  .phase-badge {
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.65rem;
    font-weight: 800;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border: 1px solid transparent;
    transition: all 0.2s;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    width: auto;
    min-width: 40px;
  }
  .undo-btn {
    background: var(--scout-danger); /* Match red */
    color: white;
  }
  .phase-badge {
    color: #fff;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
  }
  .phase-badge.pre {
    background: var(--scout-secondary); /* Grey */
    border: 1px solid #495057;
  }
  .phase-badge.auto {
    background: var(--scout-primary); /* Vibrant Blue */
    border: 1px solid #004085;
  }
  .phase-badge.teleop {
    background: var(--scout-purple); /* Deep Purple instead of Yellow/Orange */
    color: #fff;
    border: 1px solid #5a32a3;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
  }
  .phase-badge.endgame {
    background: var(--scout-danger); /* Vibrant Red */
    border: 1px solid #721c24;
  }
  .phase-badge.finished {
    background: var(--scout-success); /* Success Green */
    border: 1px solid #0f5132;
  }

  .finished-state {
    background: #e8f5e9; /* Light Green */
    padding: 2rem;
    border-radius: 4px;
    border: 2px dashed #a5d6a7;
    margin: 1rem 0;
    text-align: center;
    animation: fadeIn 0.5s ease-out;
  }
  .pre-state {
    background: #f1f3f5; /* Light Greyish Blue */
    padding: 1.5rem;
    border-radius: 12px;
    border: 1px solid var(--scout-border);
  }
  .finished-state h3 {
    color: #2e7d32;
    margin-bottom: 0.5rem;
  }
  .finished-state p {
    color: #4caf50;
    margin-bottom: 1.5rem;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .phase-title {
    font-size: 1.2rem;
    font-weight: 800;
    margin-bottom: 0.5rem;
    text-align: center;
    color: var(--scout-dark);
    letter-spacing: 1px;
    border-bottom: 1px solid var(--scout-border);
    padding-bottom: 0.25rem;
    text-transform: uppercase;
  }

  .divider {
    border: 0;
    border-top: 1px solid var(--scout-border);
    margin: 0.5rem 0;
  }
  .divider-sm {
    border: 0;
    border-top: 1px solid var(--scout-border);
    margin: 0.25rem 0;
  }

  /* Buttons */
  .btn {
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 1.5rem 0.9rem;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
    background: #e9ecef;
    -webkit-tap-highlight-color: transparent !important;
    user-select: none;
  }
  .btn:active {
    background: var(--scout-secondary) !important;
    color: white !important;
    box-shadow: none !important;
    outline: none !important;
    transition: none !important;
  }
  .btn:hover {
    background: #5a6268 !important;
    color: white !important;
    border-color: #545b62 !important;
  }
  .btn:focus,
  .btn:active:focus,
  .btn:focus-visible {
    outline: none !important;
    box-shadow: none !important;
  }
  .btn-outline:hover {
    background: var(--scout-secondary) !important;
    color: white !important;
    border-color: var(--scout-secondary) !important;
  }
  .btn-outline:focus {
    background: white !important;
    box-shadow: none !important;
  }
  .btn-primary {
    background: var(--scout-primary);
    color: white;
  }
  .btn-secondary {
    background: var(--scout-secondary);
    color: white;
  }
  .btn-success {
    background: var(--scout-success);
    color: white;
  }
  .btn-danger {
    background: var(--scout-danger);
    color: white;
  }
  .btn-warning {
    background: var(--scout-light);
    color: var(--scout-dark);
    border: 1px solid var(--scout-border);
  }
  .btn-outline {
    background: white;
    border-color: var(--scout-border);
  }

  .btn-outline-primary {
    background: white;
    border: 1px solid var(--scout-primary);
    color: var(--scout-primary);
  }

  .active {
    background: #e0e0e0 !important;
    color: black !important;
    border-color: #adb5bd !important;
  }

  .btn-selected {
    background: var(--scout-secondary) !important;
    color: white !important;
  }

  .btn-selected-blue {
    background: #cfe2ff !important;
    color: #004085 !important;
    border-color: #b6d4fe !important;
  }

  .btn-row {
    display: flex;
    gap: 0.2rem;
    flex-wrap: wrap;
    margin-bottom: 0.25rem;
  }
  .btn-row .btn {
    flex: 0 0 calc(33.33% - 0.15rem);
    min-width: 0;
  }
  .btn-grid {
    display: grid;
    width: 100%;
    gap: 0.35rem;
    margin-bottom: 0.25rem;
  }
  .big-btn {
    flex: 1;
    min-width: 70px;
    padding: 0.8rem 0.25rem;
    font-size: 0.8rem;
  }
  .action-btn {
    padding: 0.8rem;
    font-size: 1rem;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  /* Live Phase Layout */
  .teleop-config {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .auto-phase,
  .teleop-phase {
    gap: 0.6rem;
  }
  .auto-phase-main,
  .teleop-phase-main {
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    min-height: calc(100dvh - 12rem);
  }
  .auto-live-zone,
  .teleop-live-zone {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-height: calc(100dvh - 12rem);
    padding: 0.1rem 0.1rem 0.35rem;
  }
  .auto-bottom-row {
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    width: 100%;
  }
  .auto-bottom-row .auto-dead-btn {
    flex: 0 0 30%;
    /* match the height of the START TELEOP button */
    min-height: clamp(4.5rem, 10dvh, 6rem);
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .auto-bottom-row .auto-next-btn {
    flex: 1 1 70%;
  }
  .auto-disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .auto-live-middle,
  .teleop-live-middle {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1 1 auto;
  }
  .control-help {
    margin: 0 0 0.25rem;
    color: var(--text-muted, #6b7280);
    font-size: 0.76rem;
    line-height: 1.35;
  }
  .auto-live-bottom,
  .teleop-live-bottom {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: auto;
  }
  .teleop-phase-secondary {
    min-height: 0;
  }
  .auto-panel,
  .teleop-panel {
    border: 1px solid var(--scout-border);
    background: #f8f9fb;
    border-radius: 10px;
    padding: 0.5rem;
  }
  .auto-pickup-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-auto-rows: minmax(clamp(4.75rem, 11dvh, 7rem), 1fr);
    align-items: stretch;
  }
  .auto-shoot-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: minmax(clamp(4.75rem, 11dvh, 7rem), 1fr);
    align-items: stretch;
  }
  .auto-climb-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .teleop-option-grid {
    grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    grid-auto-flow: dense;
  }
  .teleop-action-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: minmax(clamp(4.75rem, 11dvh, 7rem), 1fr);
    align-items: stretch;
  }
  .teleop-action-wide {
    grid-column: 1 / -1;
  }
  .fuel-count-btn {
    flex-direction: column;
    gap: 0.3rem;
  }
  .fuel-count-badge {
    font-size: 1.4rem;
    font-weight: 700;
    line-height: 1;
  }
  .fuel-corrections {
    margin-top: 0.6rem;
    color: var(--text-muted, #6b7280);
    font-size: 0.78rem;
  }
  .fuel-corrections summary { cursor: pointer; }
  .fuel-override-row {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.6rem;
  }
  .fuel-override-input {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .fuel-override-input label {
    font-size: 0.72rem;
    color: var(--text-muted, #6b7280);
    white-space: nowrap;
  }
  .fuel-override-input input {
    width: 3.5rem;
    padding: 0.3rem;
    font-size: 0.85rem;
  }
  .teleop-climb-grid {
    grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr));
  }
  .auto-phase .big-btn,
  .teleop-phase .big-btn {
    min-height: clamp(4.2rem, 9dvh, 6rem);
    padding: 0.85rem 0.45rem;
    font-size: clamp(0.9rem, 2.2vw, 1.05rem);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .auto-climb-btn,
  .teleop-climb-btn {
    min-height: clamp(5.75rem, 13dvh, 8rem);
  }
  .auto-next-btn {
    min-height: clamp(4.5rem, 10dvh, 6rem);
  }
  .teleop-submit-btn {
    min-height: clamp(4.5rem, 10dvh, 6rem);
  }
  .chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .chip {
    border: 1px solid var(--scout-border);
    background: white;
    border-radius: 4px;
    padding: 0.25rem 0.75rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .shift-chip.on {
    background-color: #5dade2 !important; /* Softer blue */
    color: white !important;
    border-color: var(--scout-border) !important;
  }
  .shift-chip.off {
    background-color: #ec7063 !important; /* Softer red */
    color: white !important;
    border-color: var(--scout-border) !important;
  }

  /* Sliders */
  .range-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.6rem;
    color: var(--scout-secondary);
    margin-top: 0.15rem;
  }
  .current-val {
    text-align: center;
    font-weight: 500;
    font-size: 0.65rem;
    color: var(--scout-secondary);
    margin-top: -0.2rem;
  }
  .slider {
    width: 100%;
    margin: 0.25rem 0;
    height: 12px;
  }
  .match-notes-input {
    width: 100%;
    min-height: 6.5rem;
    resize: vertical;
  }

  /* Form Selects */
  .form-select {
    padding: 0.2rem 0.5rem;
    font-size: 0.85rem;
    border-radius: 4px;
    border: 1px solid var(--scout-border);
    background-color: white;
  }
  .form-select.large {
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
  }

  /* Logs */
  .mini-log {
    margin-top: 2rem;
    border-top: 1px solid var(--scout-border);
    padding-top: 0.5rem;
    opacity: 0.8;
  }
  .log-header {
    font-size: 0.8rem;
    font-weight: bold;
    text-transform: uppercase;
    color: var(--scout-secondary);
  }
  .log-entries {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .log-entry {
    font-size: 0.75rem;
    font-family: monospace;
  }

  /* Events View */
  .event-list {
    display: flex;
    flex-direction: column;
  }
  .event-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--scout-border);
  }
  .badg {
    font-size: 0.7rem;
    background: #eee;
    padding: 2px 4px;
    border-radius: 4px;
    text-transform: uppercase;
  }
  .match-badge {
    font-size: 0.7rem;
    background: var(--scout-dark);
    color: white;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .role-badge {
    font-size: 0.7rem;
    background: #d4e6f1;
    color: #1b4f72;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: bold;
  }
  .shift-badge {
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: bold;
  }
  .shift-badge.on {
    background: #d5f5e3;
    color: #186a3b;
  }
  .shift-badge.off {
    background: #fadbd8;
    color: #78281f;
  }
  .time {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--scout-secondary);
  }

  /* View Mode Styles */
  .view-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .view-title-row {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .matches-count {
    font-size: 0.8rem;
    color: var(--scout-secondary);
  }
  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--scout-secondary);
    font-size: 1rem;
  }
  .stat-cards-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .stat-cards-grid.three-col {
    grid-template-columns: repeat(3, 1fr);
  }
  .stat-card {
    background: #f1f3f5;
    border-radius: 4px;
    padding: 0.75rem;
    text-align: center;
    border: 1px solid var(--scout-border);
  }
  .stat-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    color: var(--scout-secondary);
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--scout-dark);
    line-height: 1.1;
  }
  .stat-suffix {
    font-size: 1rem;
    font-weight: 400;
    color: var(--scout-secondary);
  }
  .view-section {
    margin-bottom: 1rem;
  }
  .legend-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.4rem;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
    color: var(--scout-dark);
  }
  .legend-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .stacked-bar {
    display: flex;
    height: 30px;
    border-radius: 4px;
    overflow: hidden;
    background: #e9ecef;
  }
  .bar-seg {
    min-width: 2px;
    transition: flex-basis 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    color: rgba(0, 0, 0, 0.5);
    font-weight: 500;
  }
  .empty-bar {
    background: #f1f3f5 !important;
    color: #adb5bd;
    font-style: italic;
  }
  .pickup-bar {
    height: 24px;
  }
  .pickup-bar-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pickup-bar-row .stacked-bar {
    flex: 1;
  }
  .pickup-total {
    font-size: 0.75rem;
    color: var(--scout-secondary);
    font-weight: 600;
    white-space: nowrap;
  }
  .btn-accordion {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--scout-border);
    border-radius: 4px;
    background: #f1f3f5;
    cursor: pointer;
    font-size: 0.7rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--scout-dark);
  }
  .btn-accordion:hover {
    background: #e9ecef;
  }
  .mini-bars-row {
    display: flex;
    gap: 8px;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--scout-border);
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .mini-bar-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 0 0 32px;
  }
  .mini-bar-vertical {
    display: flex;
    flex-direction: column-reverse;
    height: 60px;
    width: 24px;
    min-width: 24px;
    border-radius: 4px;
    overflow: hidden;
    background: #e9ecef;
  }
  .mini-bar-seg {
    min-height: 2px;
    width: 100%;
  }
  .mini-bar-seg.empty-bar {
    background: #f1f3f5 !important;
  }
  .mini-bar-label {
    font-size: 0.6rem;
    color: var(--scout-secondary);
    font-weight: 600;
    margin-top: 3px;
    white-space: nowrap;
  }
  @media (max-width: 600px) {
    .stat-cards-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .stat-cards-grid.three-col {
      grid-template-columns: 1fr;
    }
    .view-header {
      flex-direction: column;
      align-items: stretch;
    }
    .view-title-row {
      flex-direction: column;
      gap: 0.25rem;
    }
    .schedule-header {
      flex-direction: column;
    }
    .schedule-count {
      width: 100%;
      text-align: center;
    }
    .stat-value {
      font-size: 1.5rem;
    }
  }

  /* Responsive */
  @media (max-width: 600px) {
    .page-header {
      flex-direction: column;
      align-items: stretch;
    }
    .page-actions {
      flex-direction: column;
    }
    .page-actions .form-group,
    .page-actions .row,
    .schedule-action {
      width: 100%;
    }
    .row select,
    .row button {
      flex: 1;
    }

    .console-header {
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    .info-block {
      width: auto;
      flex: 1;
    }
    .info-block:nth-child(2) {
      width: 100%;
      order: -1;
      margin-bottom: 0.25rem;
    }
    .undo-block {
      border-left: none;
      padding-left: 0;
      flex: 0 0 auto;
    }
    .undo-btn {
      padding: 0.8rem 0.6rem;
      font-size: 0.75rem;
      width: auto;
      min-width: 50px;
    }
    .phase-badge {
      padding: 0.25rem 0.6rem;
      font-size: 0.75rem;
      width: auto;
      min-width: 50px;
    }
    .info-block .val {
      font-size: 1rem;
    }
    .info-block .label {
      font-size: 0.65rem;
    }

    .big-btn {
      min-width: 45%;
      padding: 0.8rem 0.25rem;
      font-size: 0.85rem;
    }
    .auto-live-zone,
    .teleop-live-zone {
      min-height: calc(100dvh - 10.5rem);
      gap: 0.5rem;
      padding-bottom: 0.25rem;
    }
    .auto-pickup-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .auto-pickup-grid .btn:last-child {
      grid-column: 1 / -1;
    }
    .teleop-option-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .auto-climb-grid,
    .teleop-climb-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .auto-phase .big-btn,
    .teleop-phase .big-btn {
      min-height: clamp(4.5rem, 10dvh, 6rem);
      font-size: 0.95rem;
    }
    .action-btn {
      padding: 1rem;
      font-size: 1rem;
    }
    .btn {
      padding: 1.5rem 0.9rem;
      font-size: 1rem;
    }
    .spacer {
      height: 1rem;
    }
  }

  /* Animation Styles */
  .animation-stage {
    display: flex;
    align-items: flex-end; /* Align robot to bottom */
    background: var(--scout-light);
    border: 1px solid var(--scout-border);
    border-radius: 4px;
    height: var(--stage-height);
    width: var(--stage-width);
    max-width: 100%;
    margin: 0 auto 0.5rem auto; /* Centered */
    position: relative;
    overflow: hidden;
    margin-bottom: 0.5rem;
    padding: 0;
  }
  .robot-box {
    font-size: 2rem;
    z-index: 2;
    position: absolute;
    bottom: 10px;
    left: 10px;
  }
  .projectile-x {
    position: absolute;
    left: 40px;
    bottom: 30px;
    animation-name: shoot-ball-x;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
    z-index: 1;
  }
  .projectile-y {
    font-size: var(--ball-size);
    animation-name: shoot-ball-y;
    animation-duration: inherit;
    animation-iteration-count: infinite;
  }

  @keyframes shoot-ball-x {
    0% {
      transform: translateX(0);
      opacity: 0;
    }
    10% {
      opacity: 1;
    }
    100% {
      transform: translateX(var(--full-travel));
      opacity: 1; /* Don't fade out, let the container clip it */
    }
  }

  @keyframes shoot-ball-y {
    0% {
      transform: translateY(0);
      animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1); /* Quick up */
    }
    50% {
      transform: translateY(var(--ball-peak));
      animation-timing-function: cubic-bezier(
        0.32,
        0,
        0.67,
        0
      ); /* Gravity fall */
    }
    100% {
      transform: translateY(0);
    }
  }

  .scroll-x {
    overflow-x: auto;
  }

  .schedule-action {
    align-self: flex-end;
  }

  .schedule-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .schedule-copy {
    margin: 0.35rem 0 0;
    color: var(--secondary);
  }

  .schedule-count {
    flex: 0 0 auto;
    padding: 0.5rem 0.75rem;
    border-radius: 999px;
    background: rgba(255, 193, 7, 0.18);
    color: var(--text);
    font-weight: 700;
  }

  .schedule-table {
    width: 100%;
    min-width: 760px;
    border-collapse: separate;
    border-spacing: 0.35rem;
  }

  .schedule-table th,
  .schedule-table td {
    padding: 0.75rem 0.5rem;
    border: 1px solid var(--scout-border);
    border-radius: 0.9rem;
    text-align: center;
  }

  .schedule-table .alliance.blue,
  .schedule-table .schedule-cell.blue {
    background: var(--blue-soft);
  }

  .schedule-table .alliance.red,
  .schedule-table .schedule-cell.red {
    background: var(--red-soft);
  }

  .match-label-cell {
    min-width: 8rem;
    font-weight: 700;
    background: rgba(9, 62, 109, 0.08);
  }

  .schedule-cell {
    min-width: 6.5rem;
  }

  .schedule-cell.assigned-cell {
    background: #ffe066;
    border-color: #d1a100;
    box-shadow: inset 0 0 0 1px rgba(209, 161, 0, 0.35);
  }

  .schedule-team {
    font-size: 1rem;
    font-weight: 800;
  }

  .schedule-tag {
    margin-top: 0.35rem;
    font-size: 0.72rem;
    font-weight: 700;
    color: #6f5300;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .flex-1 {
    flex: 1;
  }

  .analysis-page { padding: 1.25rem; }
  .analysis-header, .analysis-section-header, .coverage-row, .team-record summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-3);
  }
  .analysis-header { align-items: flex-start; margin-bottom: var(--gap-4); }
  .analysis-header h3 { display: flex; align-items: center; gap: 0.45rem; margin: 0; }
  .analysis-header p, .analysis-section-header span { margin: 0.35rem 0 0; color: var(--scout-secondary); }
  .analysis-actions { display: flex; gap: 0.5rem; flex: 0 0 auto; }
  .analysis-actions .btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.65rem 0.8rem; }
  .analysis-totals { margin-bottom: var(--gap-4); }
  .problem-total { border-color: var(--scout-danger); background: color-mix(in srgb, var(--scout-danger) 8%, white); }
  .export-message { margin: 0 0 var(--gap-4); color: var(--scout-success); font-weight: 600; }
  .export-message a { margin-left: 0.5rem; color: var(--scout-primary); }
  .export-error { color: var(--scout-danger); }
  .analysis-section { border-top: 1px solid var(--scout-border); padding-top: var(--gap-4); margin-top: var(--gap-4); }
  .analysis-section h4 { margin: 0; font-size: 1rem; }
  .coverage-chart { display: grid; gap: 0.6rem; margin-top: var(--gap-3); }
  .coverage-row { display: grid; grid-template-columns: 4.5rem minmax(8rem, 1fr) minmax(12rem, auto); gap: 0.75rem; }
  .coverage-team { font-weight: 800; }
  .coverage-track { height: 1.35rem; overflow: hidden; background: var(--scout-light); border: 1px solid var(--scout-border); }
  .coverage-bar { height: 100%; min-width: 1.5rem; display: flex; align-items: center; justify-content: flex-end; padding-right: 0.35rem; box-sizing: border-box; color: white; background: var(--scout-primary); font-size: 0.72rem; font-weight: 800; transition: width 180ms ease; }
  .coverage-sources { font-size: 0.78rem; color: var(--scout-secondary); white-space: nowrap; }
  .team-records { display: grid; gap: 0.45rem; }
  .team-record { border: 1px solid var(--scout-border); background: var(--scout-light); }
  .team-record summary { padding: 0.75rem; cursor: pointer; list-style: none; }
  .team-record summary::-webkit-details-marker { display: none; }
  .team-record summary span { color: var(--scout-secondary); font-size: 0.8rem; }
  .record-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; padding: 0 0.75rem 0.75rem; }
  .record-grid p, .record-notes p { margin: 0.25rem 0 0; font-size: 0.86rem; line-height: 1.4; }
  .record-notes { margin: 0 0.75rem 0.75rem; padding: 0.6rem; border-left: 3px solid var(--scout-primary); background: white; }
  @media (max-width: 700px) {
    .analysis-header, .analysis-section-header { flex-direction: column; }
    .analysis-actions { width: 100%; }
    .analysis-actions .btn { flex: 1; justify-content: center; }
    .coverage-row { grid-template-columns: 3.25rem minmax(5rem, 1fr); }
    .coverage-sources { grid-column: 1 / -1; }
    .record-grid { grid-template-columns: 1fr; }
  }
</style>
