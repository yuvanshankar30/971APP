<script>
  import { onMount } from 'svelte';
  import RebuiltFieldMap from '$lib/components/RebuiltFieldMap.svelte';
  import { MATCH_RATING_FIELDS, TELEOP_ROLES, parseAutoPointsEstimate } from '$lib/matchScouting.js';
  import { getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { AlertTriangle, Check, ChevronRight, ClipboardCheck, MapPinned, Route, RotateCcw, Timer, Trophy } from 'lucide-svelte';

  const START_POSITIONS = ['left trench', 'left mound', 'center', 'right mound', 'right trench'];
  const RATING_FIELDS = MATCH_RATING_FIELDS;
  const TELEOP_RATING_FIELDS = RATING_FIELDS.filter((field) => field !== 'Driver awareness');
  const TELEOP_ROLE_LABELS = {
    Scoring: 'Scoring',
    Shuttling: 'Shuttling fuel',
    'Fuel collection': 'Intaking fuel',
    Defense: 'Defense'
  };
  const BALL_SOURCE_OPTIONS = [
    ['source', 'Source'],
    ['wing', 'Alliance wing'],
    ['neutral', 'Neutral zone'],
    ['opponent wing', 'Opponent wing'],
    ['human player', 'Human player'],
    ['floor', 'Loose fuel / floor']
  ];
  const AUTO_POINT_EXAMPLES = ['0', '20-40', '50-75', '100+'];

  let phase = 'prematch';
  let matchNumber = '';
  let robotNumber = '';
  let alliance = 'red';
  let startingPosition = '';
  let autoPoints = '';
  let autoMoved = '';
  let autoPath = [];
  let autoPathName = '';
  let savedAutoPaths = [];
  let savedPathLoading = false;
  let selectedSavedPathId = '';
  let savingPathFile = false;
  let pathFileMessage = '';
  let ballSources = [];
  let autoCollision = false;
  let autoCollisionNotes = '';
  let ratings = Object.fromEntries(RATING_FIELDS.map((field) => [field, 0]));
  let teleopRoles = [];
  let teleopNotes = '';
  let intakeSpeed = 0;
  let intakeJammed = false;
  let crashOrBreak = false;
  let robotDisabled = '';
  let card = '';
  let driverSkill = 0;
  let pitProblem = false;
  let pitProblemDetails = '';
  let postNotes = '';
  let submitted = false;
  let eventKey = '';
  let eventTeams = [];
  let saving = false;
  let error = '';

  $: assignmentReady = matchNumber.trim() && robotNumber.trim() && startingPosition;
  $: assignmentLabel = assignmentReady ? `Match ${matchNumber} · Robot ${robotNumber}` : 'Set your assignment';
  $: requiresPitReport = robotDisabled === 'disabled' || robotDisabled === 'died';
  $: shouldReportPitProblem = requiresPitReport || pitProblem;
  $: canFinish = !saving && !autoPointsInvalid && (!shouldReportPitProblem || pitProblemDetails.trim());
  $: autoPointsEstimate = parseAutoPointsEstimate(autoPoints);
  $: autoPointsInvalid = Boolean(autoPoints.trim()) && !autoPointsEstimate;

  function selectPhase(nextPhase) {
    phase = nextPhase;
    submitted = false;
  }

  function setRobotStatus(status) {
    robotDisabled = status;
    if (status === 'disabled' || status === 'died') pitProblem = true;
  }

  function toggleTeleopRole(role) {
    teleopRoles = teleopRoles.includes(role)
      ? teleopRoles.filter((entry) => entry !== role)
      : [...teleopRoles, role];
  }

  function toggleBallSource(source) {
    ballSources = ballSources.includes(source)
      ? ballSources.filter((entry) => entry !== source)
      : [...ballSources, source];
  }

  // Rating profile as a star/radar. Five axes on an identical 0-5 scale for one
  // robot in one match, which is the case a radar is actually good for: the
  // shape itself is the signal - a spiky robot reads differently from a
  // balanced one at a glance. The usual complaint about radars is that exact
  // values are hard to read off, so every axis carries its number as a label
  // too; the shape is a summary, not the only encoding.
  const STAR_MAX = 5;
  const STAR_SIZE = 260;
  const STAR_CENTER = STAR_SIZE / 2;
  const STAR_RADIUS = 84;

  function starPoint(index, value, count) {
    // Start at 12 o'clock and go clockwise, which is how these are read.
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    const distance = (Math.max(0, Math.min(STAR_MAX, value)) / STAR_MAX) * STAR_RADIUS;
    return [STAR_CENTER + Math.cos(angle) * distance, STAR_CENTER + Math.sin(angle) * distance];
  }

  function starPolygon(values, count, scale = 1) {
    return values
      .map((value, index) => starPoint(index, value * scale, count).map((n) => n.toFixed(1)).join(','))
      .join(' ');
  }

  $: starFields = RATING_FIELDS.map((field) => ({ field, value: Number(ratings[field]) || 0 }));
  $: starShape = starPolygon(starFields.map((entry) => entry.value), starFields.length);
  // Rings at each whole rating, so a reader can count outward instead of
  // estimating a distance.
  $: starRings = [1, 2, 3, 4, 5].map((ring) =>
    starPolygon(starFields.map(() => STAR_MAX), starFields.length, ring / STAR_MAX));
  $: ratedCount = starFields.filter((entry) => entry.value > 0).length;

  async function post(body) {
    const response = await fetch('/api/matchscout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload.data;
  }

  async function loadEventTeams(key) {
    if (!key) return;
    try {
      const response = await fetch(`/api/tba/event-teams?event_key=${encodeURIComponent(key)}`);
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success) {
        eventTeams = (payload.data || []).sort((a, b) => Number(a.team_number) - Number(b.team_number));
      }
    } catch {
      eventTeams = [];
    }
  }

  function normalizeRobotNumber(event) {
    robotNumber = String(event.currentTarget?.value || '').replace(/\D/g, '').slice(0, 6);
    savedAutoPaths = [];
    selectedSavedPathId = '';
  }

  async function loadSavedAutoPaths() {
    if (!eventKey || !robotNumber.trim()) {
      savedAutoPaths = [];
      return;
    }
    savedPathLoading = true;
    try {
      const response = await fetch(
        `/api/matchscout?resource=auto-paths&event_key=${encodeURIComponent(eventKey)}&team_key=${encodeURIComponent(robotNumber.trim())}`,
        { headers: await getAuthHeader() }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not load saved auto paths.');
      savedAutoPaths = payload.data || [];
    } catch (exception) {
      error = exception.message;
      savedAutoPaths = [];
    } finally {
      savedPathLoading = false;
    }
  }

  async function openAutoPhase() {
    selectPhase('auto');
    await loadSavedAutoPaths();
  }

  function loadSelectedAutoPath() {
    if (!selectedSavedPathId) return;
    const saved = savedAutoPaths.find((entry) => String(entry.id) === selectedSavedPathId);
    if (!saved) return;
    autoPath = saved.path.map((point) => [...point]);
    autoPathName = saved.name;
    alliance = saved.alliance === 'blue' ? 'blue' : saved.alliance === 'red' ? 'red' : alliance;
    pathFileMessage = `Loaded “${saved.name}”.`;
  }

  async function saveAutoPathAsNewFile() {
    pathFileMessage = '';
    if (!eventKey || !robotNumber.trim()) {
      pathFileMessage = 'Select a robot before saving a path file.';
      return;
    }
    if (!autoPathName.trim()) {
      pathFileMessage = 'Enter a path name first.';
      return;
    }
    if (autoPath.length < 2) {
      pathFileMessage = 'Draw a path before saving the file.';
      return;
    }
    savingPathFile = true;
    try {
      const saved = await post({
        action: 'save-auto-path',
        event_key: eventKey,
        team_key: robotNumber.trim(),
        name: autoPathName,
        alliance,
        path: autoPath
      });
      await loadSavedAutoPaths();
      selectedSavedPathId = String(saved.id);
      pathFileMessage = `Saved “${saved.name}” as a new path file.`;
    } catch (exception) {
      pathFileMessage = exception.message;
    } finally {
      savingPathFile = false;
    }
  }

  async function finishScout() {
    if (!assignmentReady) {
      phase = 'prematch';
      return;
    }
    if (!eventKey) {
      error = 'No active scouting event is set, so this report has nowhere to go.';
      return;
    }
    if (shouldReportPitProblem && !pitProblemDetails.trim()) {
      phase = 'postmatch';
      error = 'Describe what the pit crew needs to inspect before submitting.';
      return;
    }
    if (autoPath.length && !autoPathName.trim()) {
      phase = 'auto';
      error = 'Name the drawn autonomous path before submitting.';
      return;
    }
    saving = true;
    error = '';
    try {
      await post({
        action: 'save-entry',
        event_key: eventKey,
        match_key: matchNumber.trim(),
        team_key: robotNumber.trim(),
        alliance,
        starting_position: startingPosition,
        auto_points_estimate: autoPoints,
        auto_moved: autoMoved,
        ball_sources: ballSources,
        auto_collision: autoCollision,
        auto_collision_notes: autoCollision ? autoCollisionNotes : '',
        auto_path_name: autoPathName,
        auto_path: autoPath,
        ratings,
        teleop_roles: teleopRoles,
        teleop_notes: teleopNotes,
        intake_speed: intakeSpeed || null,
        intake_jammed: intakeJammed,
        crash_or_break: crashOrBreak,
        robot_disabled: robotDisabled,
        // The UI says "None"; the stored vocabulary uses an empty string.
        card: card === 'none' ? '' : card,
        driver_skill: driverSkill,
        post_notes: postNotes,
        report_pit_problem: shouldReportPitProblem,
        pit_problem_summary: pitProblemDetails,
        pit_problem_detail: postNotes
      });
      submitted = true;
    } catch (exception) {
      error = exception.message;
    } finally {
      saving = false;
    }
  }

  onMount(async () => {
    eventKey = (await fetchActiveScoutingEventKey()) || '';
    await loadEventTeams(eventKey);
    const query = new URLSearchParams(window.location.search);
    matchNumber = query.get('match') || '';
    robotNumber = query.get('team') || '';
    alliance = query.get('alliance') === 'blue' ? 'blue' : 'red';
    startingPosition = query.get('start') || '';
  });
</script>

<svelte:head><title>Match Scouting</title></svelte:head>

<main class="match-scouting-page" class:alliance-red={alliance === 'red'} class:alliance-blue={alliance === 'blue'}>
  <header class="page-header">
    <div class="header-content">
      <h1><ClipboardCheck size={22} /> Match Scouting</h1>
      <p>{assignmentReady ? 'Assigned robot ready for a match report.' : 'Enter the match handoff to begin.'}</p>
    </div>
    <div class="assignment-chip" class:red={alliance === 'red'} class:blue={alliance === 'blue'}>
      <span>{assignmentLabel}</span>
      {#if assignmentReady}<b>{alliance}</b>{/if}
    </div>
  </header>

  <div class="scouting-shell">
    <aside class="stage-nav" aria-label="Match scouting stages">
      <button class:active={phase === 'prematch'} on:click={() => selectPhase('prematch')}><MapPinned size={18} /><span>Pre-match</span><small>01</small></button>
      <button class:active={phase === 'auto'} on:click={openAutoPhase}><Route size={18} /><span>Auto</span><small>02</small></button>
      <button class:active={phase === 'teleop'} on:click={() => selectPhase('teleop')}><Timer size={18} /><span>Teleop</span><small>03</small></button>
      <button class:active={phase === 'postmatch'} on:click={() => selectPhase('postmatch')}><Trophy size={18} /><span>Post-match</span><small>04</small></button>
    </aside>

    <section class="match-workspace">
      {#if !submitted && assignmentReady}
        <div class="persistent-status" class:urgent={requiresPitReport}>
          <div><span class="field-label">Robot status</span><small>Available throughout the match</small></div>
          <div class="choice-grid status-buttons">
            <button class:chosen={robotDisabled === 'no'} on:click={() => setRobotStatus('no')}>Active</button>
            <button class:chosen={robotDisabled === 'disabled'} on:click={() => setRobotStatus('disabled')}>Disabled</button>
            <button class:chosen={robotDisabled === 'died'} on:click={() => setRobotStatus('died')}>Died</button>
          </div>
        </div>
      {/if}
      {#if submitted}
        <div class="submitted-state">
          <div class="submitted-icon"><Check size={28} /></div>
          <h2>Match {matchNumber} &middot; Robot {robotNumber}</h2>
          <p>Saved. Here is how you rated them.</p>

          {#if ratedCount}
            <figure class="rating-star">
              <svg viewBox={`0 0 ${STAR_SIZE} ${STAR_SIZE}`} role="img"
                   aria-label={`Rating profile: ${starFields.map((entry) => `${entry.field} ${entry.value} of ${STAR_MAX}`).join(', ')}`}>
                {#each starRings as ring, index}
                  <polygon points={ring} class="star-ring" class:outer={index === starRings.length - 1} />
                {/each}
                {#each starFields as entry, index}
                  <line x1={STAR_CENTER} y1={STAR_CENTER}
                        x2={starPoint(index, STAR_MAX, starFields.length)[0]}
                        y2={starPoint(index, STAR_MAX, starFields.length)[1]} class="star-spoke" />
                {/each}
                <polygon points={starShape} class="star-shape" />
                {#each starFields as entry, index}
                  {#if entry.value > 0}
                    <circle cx={starPoint(index, entry.value, starFields.length)[0]}
                            cy={starPoint(index, entry.value, starFields.length)[1]}
                            r="4" class="star-node" />
                  {/if}
                {/each}
                {#each starFields as entry, index}
                  <text
                    x={starPoint(index, STAR_MAX + 0.9, starFields.length)[0]}
                    y={starPoint(index, STAR_MAX + 0.9, starFields.length)[1]}
                    class="star-axis-index">{index + 1}</text>
                {/each}
              </svg>
              <figcaption class="star-legend">
                {#each starFields as entry}
                  <span class="star-legend-row" class:unrated={!entry.value}>
                    <span class="star-legend-index">{starFields.indexOf(entry) + 1}</span>
                    <span class="star-legend-label">{entry.field}</span>
                    <span class="star-legend-value">{entry.value || '—'}</span>
                  </span>
                {/each}
              </figcaption>
            </figure>
          {:else}
            <p class="star-empty">No ratings were recorded for this robot.</p>
          {/if}

          <button class="btn btn-primary" on:click={() => { submitted = false; selectPhase('prematch'); }}>Next assignment</button>
        </div>
      {:else if phase === 'prematch'}
        <div class="section-heading"><div><span class="eyebrow">Pre-match</span><h2>Match assignment</h2><p>Set the robot and its opening location before the field goes live.</p></div><MapPinned size={20} /></div>
        <div class="assignment-grid">
          <label>Match #<input class="form-input" inputmode="numeric" placeholder="14" bind:value={matchNumber} /></label>
          <label>
            Robot #
            <input
              class="form-input"
              inputmode="numeric"
              placeholder="Start typing a team number"
              list="event-team-options"
              autocomplete="off"
              value={robotNumber}
              on:input={normalizeRobotNumber}
            />
            <datalist id="event-team-options">
              {#each eventTeams as team}
                <option value={team.team_number}>{team.nickname || team.name || `Team ${team.team_number}`}</option>
              {/each}
            </datalist>
          </label>
          <fieldset><legend>Alliance</legend><div class="segmented"><button class:chosen={alliance === 'red'} class="red-choice" on:click={() => alliance = 'red'}>Red</button><button class:chosen={alliance === 'blue'} class="blue-choice" on:click={() => alliance = 'blue'}>Blue</button></div></fieldset>
        </div>
        <div class="start-position-block">
          <span class="field-label">Starting position</span>
          <div class="position-grid">
            {#each START_POSITIONS as position}
              <button class:chosen={startingPosition === position} on:click={() => startingPosition = position}>{position}</button>
            {/each}
          </div>
        </div>
        <div class="section-footer"><span>{assignmentReady ? `Robot ${robotNumber} is ready to scout.` : 'Match, robot, and starting position are required.'}</span><button class="btn btn-primary" disabled={!assignmentReady} on:click={openAutoPhase}>Begin auto <ChevronRight size={16} /></button></div>
      {:else if phase === 'auto'}
        <div class="section-heading"><div><span class="eyebrow">Autonomous</span><h2>Auto report</h2><p>Record whether auto ran, roughly how much fuel scored, and optionally draw the path.</p></div><Route size={20} /></div>
        <div class="auto-layout">
          <div class="auto-controls">
            <div class="control-group"><span class="field-label">Did autonomous run?</span><div class="segmented"><button class:chosen={autoMoved === 'ran'} on:click={() => autoMoved = 'ran'}>Yes</button><button class:chosen={autoMoved === 'did-not-run'} on:click={() => autoMoved = 'did-not-run'}>No</button></div></div>
            <div class="control-group auto-points-control">
              <label for="auto-points-estimate" class="field-label">Estimated points scored</label>
              <small class="field-help">Enter an exact estimate, a range such as 40-60, or a lower bound such as 100+. Optional.</small>
              <input
                id="auto-points-estimate"
                class="form-input auto-points-input"
                class:invalid={autoPointsInvalid}
                inputmode="decimal"
                placeholder="e.g. 40-60 or 100+"
                bind:value={autoPoints}
              />
              <div class="choice-grid point-examples" aria-label="Quick auto point estimates">
                {#each AUTO_POINT_EXAMPLES as example}
                  <button class:chosen={autoPoints === example} on:click={() => autoPoints = example}>{example}</button>
                {/each}
              </div>
              {#if autoPointsEstimate?.kind === 'range'}
                <small class="estimate-result">Analytics estimate: <strong>{autoPointsEstimate.average} points</strong> (midpoint of {autoPointsEstimate.input}).</small>
              {:else if autoPointsEstimate?.kind === 'lower-bound'}
                <small class="estimate-result">Analytics estimate: <strong>at least {autoPointsEstimate.average} points</strong> (conservative lower bound).</small>
              {:else if autoPointsEstimate}
                <small class="estimate-result">Analytics estimate: <strong>{autoPointsEstimate.average} points</strong>.</small>
              {:else if autoPointsInvalid}
                <small class="estimate-error">Use a number, a low-high range, or a value ending in +.</small>
              {/if}
            </div>
            <fieldset class="control-group">
              <legend class="field-label">Where did the robot collect fuel?</legend>
              <small class="field-help">Select every location observed during autonomous.</small>
              <div class="choice-grid auto-source-grid">
                {#each BALL_SOURCE_OPTIONS as source}
                  <button
                    class:chosen={ballSources.includes(source[0])}
                    on:click={() => toggleBallSource(source[0])}
                  >{source[1]}</button>
                {/each}
              </div>
            </fieldset>
            <div class="control-group">
              <span class="field-label">Collision with another robot?</span>
              <div class="segmented">
                <button class:chosen={!autoCollision} on:click={() => (autoCollision = false)}>No</button>
                <button class:chosen={autoCollision} on:click={() => (autoCollision = true)}>Yes</button>
              </div>
              {#if autoCollision}
                <textarea
                  class="form-input collision-notes"
                  rows="2"
                  maxlength="500"
                  placeholder="Which robot, where, and what happened?"
                  bind:value={autoCollisionNotes}
                ></textarea>
              {/if}
            </div>
          </div>
          <div class="path-panel">
            <div class="path-heading">
              <div><span class="field-label">Robot path (optional)</span><small>AdvantageScope-style 2026 field; your alliance wall is always on the left.</small></div>
              <button class="btn btn-sm" on:click={() => autoPath = []} disabled={!autoPath.length}><RotateCcw size={14} /> Clear</button>
            </div>
            <div class="saved-path-controls">
              <label for="auto-path-name">
                Path name
                <input
                  id="auto-path-name"
                  class="form-input"
                  maxlength="120"
                  placeholder="e.g. Center four-piece"
                  bind:value={autoPathName}
                />
              </label>
              <label for="saved-auto-path">
                Saved path files
                <select id="saved-auto-path" class="form-input" bind:value={selectedSavedPathId} disabled={savedPathLoading || !savedAutoPaths.length}>
                  <option value="">{savedPathLoading ? 'Loading...' : savedAutoPaths.length ? 'Choose a saved path' : 'No saved paths yet'}</option>
                  {#each savedAutoPaths as saved}
                    <option value={saved.id}>{saved.name}</option>
                  {/each}
                </select>
              </label>
            </div>
            <div class="path-file-actions">
              <button class="btn btn-outline" on:click={loadSelectedAutoPath} disabled={!selectedSavedPathId || savedPathLoading}>Load file</button>
              <button class="btn btn-primary" on:click={saveAutoPathAsNewFile} disabled={savingPathFile || autoPath.length < 2 || !autoPathName.trim()}>
                {savingPathFile ? 'Saving...' : 'Save as new file'}
              </button>
            </div>
            {#if pathFileMessage}<small class="path-file-message">{pathFileMessage}</small>{/if}
            <RebuiltFieldMap {alliance} bind:path={autoPath} />
            {#if autoPath.length && !autoPathName.trim()}<small class="estimate-error">Name this path so it can be reopened later.</small>{/if}
            <small class="field-source">Simplified from the official WPILib/AdvantageScope 2026 REBUILT 2D field view for legibility on scouting devices.</small>
          </div>
        </div>
        <div class="section-footer"><button class="btn" on:click={() => selectPhase('prematch')}>Back</button><button class="btn btn-primary" disabled={autoPointsInvalid} on:click={() => selectPhase('teleop')}>Continue to teleop <ChevronRight size={16} /></button></div>
      {:else if phase === 'teleop'}
        <div class="section-heading"><div><span class="eyebrow">Teleop</span><h2>Driver and robot performance</h2><p>Record the roles you actually saw and rate only what you could judge confidently. Every field remains optional.</p></div><Timer size={20} /></div>
        <fieldset class="teleop-roles">
          <legend class="field-label">Observed roles</legend>
          <small class="field-help">Select every role this robot meaningfully performed.</small>
          <div class="choice-grid role-grid">
            {#each TELEOP_ROLES as role}
              <button class:chosen={teleopRoles.includes(role)} on:click={() => toggleTeleopRole(role)}>{TELEOP_ROLE_LABELS[role] || role}</button>
            {/each}
          </div>
        </fieldset>
        <div class="ratings-grid">
          <div class="ratings-heading"><span class="field-label">Optional 1-5 ratings</span><small>1 = poor, 5 = excellent. Leave untouched when not observed.</small></div>
          {#each TELEOP_RATING_FIELDS as field}
            <div class="rating-row"><span>{field}</span><div class="rating-buttons">{#each [1, 2, 3, 4, 5] as value}<button aria-label={`${field}: ${value} of 5`} class:chosen={ratings[field] === value} on:click={() => ratings = { ...ratings, [field]: value }}>{value}</button>{/each}</div></div>
          {/each}
        </div>
        <div class="intake-observations">
          <div class="control-group">
            <span class="field-label">Intake speed</span>
            <small class="field-help">1 = slow, 3 = fast. Leave blank if it was not observed.</small>
            <div class="rating-buttons large">
              {#each [1, 2, 3] as value}
                <button class:chosen={intakeSpeed === value} on:click={() => (intakeSpeed = value)}>{value}</button>
              {/each}
            </div>
          </div>
          <label class="incident-toggle intake-jam-toggle">
            <input type="checkbox" bind:checked={intakeJammed} />
            <span><AlertTriangle size={17} /> Intake jammed during the match</span>
          </label>
        </div>
        <label class="notes-label scouter-notes">Real-scout observations (optional)<textarea class="form-input" rows="9" placeholder="What did the robot actually do? Note repeatable strengths, defense response, cycle consistency, field awareness, or anything the numbers miss." bind:value={teleopNotes}></textarea></label>
        <label class="incident-toggle"><input type="checkbox" bind:checked={crashOrBreak} /><span><AlertTriangle size={17} /> Crash or mechanical break</span></label>
        <div class="section-footer"><button class="btn" on:click={() => selectPhase('auto')}>Back</button><button class="btn btn-primary" on:click={() => selectPhase('postmatch')}>Continue to post-match <ChevronRight size={16} /></button></div>
      {:else}
        <div class="section-heading"><div><span class="eyebrow">Post-match</span><h2>Match outcome</h2><p>Close out the report and flag anything the ACE Team needs to inspect.</p></div><Trophy size={20} /></div>
        <div class="post-grid"><fieldset><legend>Cards</legend><div class="choice-grid"><button class:chosen={card === 'none'} on:click={() => card = 'none'}>None</button><button class:chosen={card === 'yellow'} on:click={() => card = 'yellow'}>Yellow</button><button class:chosen={card === 'red'} on:click={() => card = 'red'}>Red</button></div></fieldset></div>
        <div class="control-group"><span class="field-label">Driver skill</span><div class="rating-buttons large">{#each [1, 2, 3, 4, 5] as value}<button class:chosen={driverSkill === value} on:click={() => driverSkill = value}>{value}</button>{/each}</div></div>
        <div class="control-group"><span class="field-label">Driver awareness</span><div class="rating-buttons large">{#each [1, 2, 3, 4, 5] as value}<button class:chosen={ratings['Driver awareness'] === value} on:click={() => ratings = { ...ratings, 'Driver awareness': value }}>{value}</button>{/each}</div></div>
        {#if requiresPitReport}
          <div class="required-handoff"><AlertTriangle size={17} /><span>An ACE Team report is required because this robot was {robotDisabled}.</span></div>
        {:else}
          <label class="incident-toggle"><input type="checkbox" bind:checked={pitProblem} /><span><AlertTriangle size={17} /> Send a problem to the ACE Team</span></label>
        {/if}
        {#if shouldReportPitProblem}
          <label class="notes-label pit-report-field">Problem for ACE Team (required)<textarea class="form-input" required rows="3" placeholder="What failed, and what should the ACE Team inspect before the next match?" bind:value={pitProblemDetails}></textarea></label>
        {/if}
        <label class="notes-label scouter-notes">Post-match scout notes (optional)<textarea class="form-input" rows="8" placeholder="Anything strategy should know that the structured fields missed? Leave blank if not." bind:value={postNotes}></textarea></label>
        <div class="section-footer"><button class="btn" on:click={() => selectPhase('teleop')}>Back</button><button class="btn btn-primary" on:click={finishScout} disabled={!canFinish}>{saving ? 'Saving...' : 'Finish match scouting'} <Check size={16} /></button></div>
        {#if error}<p class="submit-error">{error}</p>{/if}
      {/if}
    </section>
  </div>
</main>

<style>
  .submit-error { margin:var(--space-2) 0 0; color:var(--danger); font-size:.85rem; }
  .match-scouting-page { max-width:1200px; margin:0 auto; padding:var(--space-4); }
  .match-scouting-page { transition:background-color 160ms ease, box-shadow 160ms ease; clip-path:inset(0 -100vmax); }
  .match-scouting-page.alliance-red { background:color-mix(in srgb, var(--red-base) 8%, transparent); box-shadow:0 0 0 100vmax color-mix(in srgb, var(--red-base) 8%, transparent); }
  .match-scouting-page.alliance-blue { background:color-mix(in srgb, var(--blue-base) 8%, transparent); box-shadow:0 0 0 100vmax color-mix(in srgb, var(--blue-base) 8%, transparent); }
  h1,h2 { margin:0; } h1 { display:flex; align-items:center; gap:var(--gap-2); } h2 { font-size:1.2rem; }
  .assignment-chip { display:flex; align-items:center; gap:var(--gap-2); border:1px solid var(--border); padding:var(--space-2) var(--space-3); background:var(--surface-2); font-size:.85rem; }
  .assignment-chip b { text-transform:uppercase; font-size:.72rem; } .assignment-chip.red b { color:var(--red-strong); } .assignment-chip.blue b { color:var(--blue-strong); }
  .scouting-shell { display:grid; grid-template-columns:12rem minmax(0,1fr); gap:var(--gap-4); align-items:start; }
  .stage-nav { position:sticky; top:var(--space-4); display:grid; border:1px solid var(--border); background:var(--surface-1); }
  .stage-nav button { display:flex; gap:var(--gap-2); align-items:center; min-height:3.25rem; padding:var(--space-3); border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text-muted); text-align:left; cursor:pointer; }
  .stage-nav button:last-child { border-bottom:0; } .stage-nav button.active { color:var(--text); background:var(--brand-gold-soft); box-shadow:inset 3px 0 0 var(--brand-gold-base); } .stage-nav button:disabled { cursor:not-allowed; opacity:.5; }
  .stage-nav span,.eyebrow,.field-label { color:var(--text-muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; }
  .section-heading { display:flex; align-items:start; justify-content:space-between; gap:var(--gap-3); margin-bottom:var(--space-5); } .section-heading :global(svg) { color:var(--text-muted); }
  .persistent-status { display:flex; align-items:center; justify-content:space-between; gap:var(--gap-3); margin-bottom:var(--space-4); padding:var(--space-3) var(--space-4); border:1px solid var(--border); border-left:3px solid var(--green-base); background:var(--surface-2); }
  .persistent-status.urgent { border-left-color:var(--red-base); background:var(--red-soft); }
  .persistent-status > div:first-child { display:grid; gap:2px; }
  .persistent-status small,.path-heading small,.field-help { color:var(--text-muted); font-size:.75rem; }
  .status-buttons { margin-top:0; }
  .assignment-grid,.post-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--gap-4); } label,fieldset { display:grid; gap:var(--space-2); color:var(--text-muted); font-size:.8rem; } fieldset { margin:0; padding:0; border:0; } legend { padding:0; }
  .segmented,.choice-grid,.position-grid,.rating-buttons { display:flex; flex-wrap:wrap; gap:var(--gap-2); } .segmented button,.choice-grid button,.position-grid button,.rating-buttons button { min-height:var(--control-height); padding:0 var(--space-3); border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface-1); color:var(--text); cursor:pointer; }
  .segmented button.chosen,.choice-grid button.chosen,.position-grid button.chosen,.rating-buttons button.chosen { border-color:var(--brand-gold-strong); background:var(--brand-gold-soft); color:var(--secondary); font-weight:600; } .segmented .red-choice.chosen { border-color:var(--red-base); background:var(--red-soft); } .segmented .blue-choice.chosen { border-color:var(--blue-base); background:var(--blue-soft); }
  .start-position-block,.control-group,.notes-label,.incident-toggle { margin-top:var(--space-5); } .position-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); margin-top:var(--space-2); } .position-grid button { min-height:4rem; text-transform:capitalize; }
  .section-footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--gap-3); margin-top:var(--space-6); padding-top:var(--space-4); border-top:1px solid var(--border); color:var(--text-muted); font-size:.82rem; } .section-footer .btn { display:inline-flex; align-items:center; gap:var(--gap-2); }
  .auto-layout { display:grid; grid-template-columns:minmax(18rem,.9fr) minmax(18rem,1.1fr); gap:var(--space-6); } .auto-controls { display:grid; align-content:start; gap:var(--space-1); } .choice-grid { margin-top:var(--space-2); }
  .auto-points-input { margin-top:var(--space-2); font-size:1.1rem; font-variant-numeric:tabular-nums; }
  .auto-points-input.invalid { border-color:var(--danger); }
  .point-examples { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); }
  .estimate-result { color:var(--text-muted); }
  .estimate-result strong { color:var(--text); }
  .estimate-error { color:var(--danger); }
  .auto-source-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
  .collision-notes { margin-top:var(--space-2); resize:vertical; }
  .path-panel { display:grid; gap:var(--space-2); } .path-heading { display:flex; justify-content:space-between; align-items:center; gap:var(--gap-3); } .path-heading > div { display:grid; gap:2px; }
  .saved-path-controls { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--gap-3); margin:var(--space-2) 0; }
  .path-file-actions { display:flex; flex-wrap:wrap; gap:var(--gap-2); }
  .path-file-message { color:var(--text-muted); }
  .field-source { color:var(--text-muted); font-size:.68rem; line-height:1.35; }
  .teleop-roles { margin-bottom:var(--space-4); padding:var(--space-4); border:1px solid var(--border); background:var(--surface-2); }
  .role-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); }
  .ratings-grid { display:grid; gap:var(--space-3); } .ratings-heading { display:flex; justify-content:space-between; gap:var(--gap-3); padding-bottom:var(--space-2); border-bottom:1px solid var(--border); } .ratings-heading small { color:var(--text-muted); } .rating-row { display:flex; align-items:center; justify-content:space-between; gap:var(--gap-4); padding-bottom:var(--space-3); border-bottom:1px solid var(--border); } .rating-row span { font-size:.9rem; } .rating-buttons button { width:2.25rem; padding:0; } .rating-buttons.large button { width:3rem; min-height:2.5rem; }
  .notes-label textarea { resize:vertical; min-height:7rem; line-height:1.5; } .scouter-notes textarea { min-height:12rem; } .incident-toggle { display:flex; grid-template-columns:auto 1fr; align-items:center; color:var(--text); font-size:.9rem; } .incident-toggle span { display:flex; align-items:center; gap:var(--gap-2); } .incident-toggle :global(svg) { color:var(--red-base); }
  .pit-report-field { margin-top:var(--space-3); }
  .intake-observations { display:grid; grid-template-columns:minmax(0,1fr) minmax(16rem,1fr); gap:var(--gap-4); align-items:end; margin-top:var(--space-5); }
  .intake-jam-toggle { margin-top:0; }
  .required-handoff { display:flex; align-items:flex-start; gap:var(--gap-2); margin-top:var(--space-5); padding:var(--space-3) var(--space-4); border-left:3px solid var(--red-base); background:var(--red-soft); color:var(--text); font-size:.88rem; }
  .required-handoff :global(svg) { flex:none; color:var(--red-base); }
  /* One series, so no legend box is needed for identity - the axis labels
     name each value directly, and the numbers sit beside the shape so the
     chart is never the only encoding. Grid and spokes stay recessive; only
     the shape carries the accent. */
  .rating-star { display:grid; grid-template-columns:auto minmax(0,11rem); gap:var(--gap-4); align-items:center; margin:0; }
  .rating-star svg { width:min(260px, 60vw); height:auto; overflow:visible; }
  .star-ring { fill:none; stroke:var(--border); stroke-width:1; }
  .star-ring.outer { stroke:var(--text-muted); opacity:.45; }
  .star-spoke { stroke:var(--border); stroke-width:1; }
  .star-shape {
    fill:color-mix(in srgb, var(--brand-gold-base, #d9a413) 26%, transparent);
    stroke:var(--brand-gold-base, #d9a413);
    stroke-width:2;
    stroke-linejoin:round;
  }
  .star-node { fill:var(--brand-gold-base, #d9a413); stroke:var(--surface-1); stroke-width:2; }
  .star-legend { display:grid; gap:2px; text-align:left; }
  .star-legend-row { display:flex; align-items:baseline; gap:var(--gap-2); font-size:.82rem; padding:2px 0; border-bottom:1px solid var(--border); }
  .star-legend-label { flex:1; }
  .star-axis-index, .star-legend-index {
    font-size:.68rem;
    font-variant-numeric:tabular-nums;
    fill:var(--text-muted);
    color:var(--text-muted);
  }
  .star-axis-index { text-anchor:middle; dominant-baseline:middle; }
  .star-legend-index { min-width:1ch; }
  .star-legend-label { color:var(--text-muted); }
  .star-legend-value { font-variant-numeric:tabular-nums; font-weight:600; color:var(--text); }
  .star-legend-row.unrated .star-legend-value { color:var(--text-muted); font-weight:400; }
  .star-empty { color:var(--text-muted); font-size:.85rem; }
  @media (max-width:560px) {
    .rating-star { grid-template-columns:1fr; justify-items:center; }
    .star-legend { width:min(260px, 80vw); }
  }
  .submitted-state { min-height:32rem; display:grid; place-content:center; justify-items:center; gap:var(--space-3); text-align:center; } .submitted-state p { margin:0; color:var(--text-muted); } .submitted-icon { display:grid; place-items:center; width:3.5rem; height:3.5rem; background:var(--green-soft); color:var(--green-strong); border-radius:50%; }
  @media (max-width:850px) { .scouting-shell { grid-template-columns:1fr; } .stage-nav { position:static; grid-template-columns:repeat(4,1fr); } .stage-nav button { flex-direction:column; justify-content:center; text-align:center; padding:var(--space-2); } .assignment-grid,.post-grid,.auto-layout,.intake-observations { grid-template-columns:1fr; } .position-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:560px) { .match-scouting-page { padding:var(--space-3); } .page-header { align-items:flex-start; } .assignment-chip { width:100%; justify-content:space-between; } .stage-nav { grid-template-columns:repeat(2,1fr); } .rating-row,.ratings-heading { align-items:flex-start; flex-direction:column; } .point-examples,.role-grid,.saved-path-controls { grid-template-columns:repeat(1,1fr); } .persistent-status { align-items:stretch; flex-direction:column; } }

  /* Match Scouting intentionally shares Pit Scouting's focused field-workspace language. */
  .match-scouting-page { max-width:1160px; }
  .match-scouting-page .page-header { margin-bottom:var(--space-5); }
  .assignment-chip { min-height:2.7rem; background:var(--surface-1); border-radius:0; }
  .assignment-chip.red { border-left:3px solid var(--red-base); }
  .assignment-chip.blue { border-left:3px solid var(--blue-base); }
  .scouting-shell { grid-template-columns:13.5rem minmax(0, 1fr); gap:var(--space-4); }
  .stage-nav { gap:var(--space-1); padding:var(--space-2); border-radius:0; }
  .stage-nav button { display:grid; grid-template-columns:1.4rem 1fr auto; min-height:3.2rem; padding:var(--space-2); border-bottom:0; }
  .stage-nav button.active { box-shadow:inset 3px 0 0 var(--brand-gold-strong); }
  .stage-nav button small { font-size:.7rem; color:var(--text-muted); }
  .match-workspace { min-height:42rem; padding:var(--space-5); border:1px solid var(--border); background:var(--surface-1); }
  .section-heading { margin-bottom:var(--space-5); }
  .section-heading p { max-width:38rem; margin:.45rem 0 0; color:var(--text-muted); font-size:.87rem; line-height:1.45; }
  .section-heading > :global(svg) { padding:.55rem; box-sizing:content-box; border:1px solid var(--border); color:var(--text-muted); }
  .assignment-grid { grid-template-columns:1fr 1fr 1.25fr; padding:var(--space-4); border:1px solid var(--border); background:var(--surface-2); }
  .start-position-block { padding:var(--space-4); border:1px solid var(--border); border-top:0; margin-top:0; }
  .position-grid button { position:relative; min-height:5.25rem; text-transform:capitalize; }
  .position-grid button.chosen::after { content:''; position:absolute; left:50%; bottom:.65rem; width:.35rem; height:.35rem; border-radius:50%; background:var(--brand-gold-strong); transform:translateX(-50%); }
  .auto-layout { padding:var(--space-4); border:1px solid var(--border); background:var(--surface-2); }
  .auto-controls { gap:var(--space-3); }
  .control-group { margin-top:0; }
  .path-panel { padding:var(--space-3); border:1px solid var(--border); background:var(--surface-1); }
  .ratings-grid { padding:var(--space-4); border:1px solid var(--border); }
  .rating-row:last-child { padding-bottom:0; border-bottom:0; }
  .rating-buttons button { border-radius:50%; }
  .notes-label { padding:var(--space-4); border:1px solid var(--border); }
  .incident-toggle { padding:var(--space-3) var(--space-4); border-left:3px solid var(--red-base); background:var(--red-soft); }
  .post-grid { padding:var(--space-4); border:1px solid var(--border); background:var(--surface-2); }
  .post-grid { grid-template-columns:1fr; }
  .submitted-state { background:var(--surface-2); }
  @media (max-width:850px) {
    .scouting-shell { grid-template-columns:1fr; }
    .stage-nav button { grid-template-columns:1fr; justify-items:center; text-align:center; }
    .stage-nav button small { display:none; }
  }
  @media (max-width:560px) {
    .match-workspace { padding:var(--space-4); }
    .assignment-grid { grid-template-columns:1fr; }
    .start-position-block { padding:var(--space-3); }
  }
</style>
