<script>
  import { onMount } from 'svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { AlertTriangle, Check, ChevronRight, ClipboardCheck, Flag, MapPinned, Route, RotateCcw, Timer, Trophy } from 'lucide-svelte';

  const START_POSITIONS = ['left trench', 'left mound', 'center', 'right mound', 'right trench'];
  const AUTO_ZONES = ['source', 'wing', 'neutral', 'opponent wing'];
  const POINT_BANDS = ['0', '1-2', '3-4', '5+'];
  const RATING_FIELDS = ['Shot accuracy', 'Driver awareness', 'Cycle speed', 'Defense', 'Reliability'];

  let phase = 'prematch';
  let matchNumber = '';
  let robotNumber = '';
  let alliance = 'red';
  let startingPosition = '';
  let autoStartZone = '';
  let autoPoints = '';
  let autoFinish = '';
  let ballSources = [];
  let autoMoved = '';
  let autoPath = [];
  let drawing = false;
  let ratings = Object.fromEntries(RATING_FIELDS.map((field) => [field, 0]));
  let teleopNotes = '';
  let crashOrBreak = false;
  let robotDisabled = '';
  let card = '';
  let driverSkill = 0;
  let pitProblem = false;
  let pitProblemDetails = '';
  let postNotes = '';
  let submitted = false;
  let eventKey = '';
  let saving = false;
  let error = '';

  $: assignmentReady = matchNumber.trim() && robotNumber.trim() && startingPosition;
  $: assignmentLabel = assignmentReady ? `Match ${matchNumber} · Robot ${robotNumber}` : 'Set your assignment';

  function selectPhase(nextPhase) {
    phase = nextPhase;
    submitted = false;
  }

  function toggleBallSource(source) {
    ballSources = ballSources.includes(source)
      ? ballSources.filter((item) => item !== source)
      : [...ballSources, source];
  }

  function pointFromEvent(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100))
    ];
  }

  function beginPath(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const point = pointFromEvent(event);
    drawing = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const last = autoPath[autoPath.length - 1];
    autoPath = !last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1.5
      ? [...autoPath, point]
      : autoPath;
  }

  function extendPath(event) {
    if (!drawing) return;
    const point = pointFromEvent(event);
    const last = autoPath[autoPath.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1.5) autoPath = [...autoPath, point];
  }

  function completePath(event) {
    if (!drawing) return;
    if (event.type === 'pointerup') extendPath(event);
    drawing = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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

  async function finishScout() {
    if (!assignmentReady) {
      phase = 'prematch';
      return;
    }
    if (!eventKey) {
      error = 'No active scouting event is set, so this report has nowhere to go.';
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
        auto_start_zone: autoStartZone,
        auto_points_band: autoPoints,
        auto_finish: autoFinish,
        auto_moved: autoMoved,
        ball_sources: ballSources,
        auto_path: autoPath,
        ratings,
        teleop_notes: teleopNotes,
        crash_or_break: crashOrBreak,
        robot_disabled: robotDisabled,
        // The UI says "None"; the stored vocabulary uses an empty string.
        card: card === 'none' ? '' : card,
        driver_skill: driverSkill,
        post_notes: postNotes
      });
      // Reported separately so a failure here is visible rather than losing
      // the whole match report, and so the pit crew's queue stays its own
      // record with its own lifecycle.
      if (pitProblem) {
        await post({
          action: 'report-pit-problem',
          event_key: eventKey,
          team_key: robotNumber.trim(),
          match_key: matchNumber.trim(),
          summary: pitProblemDetails.trim(),
          detail: postNotes.trim(),
          // Severity is re-derived server-side from robot_disabled; sending
          // it is a hint, not the decision.
          robot_disabled: robotDisabled
        });
      }
      submitted = true;
    } catch (exception) {
      error = exception.message;
    } finally {
      saving = false;
    }
  }

  onMount(async () => {
    eventKey = (await fetchActiveScoutingEventKey()) || '';
    const query = new URLSearchParams(window.location.search);
    matchNumber = query.get('match') || '';
    robotNumber = query.get('team') || '';
    alliance = query.get('alliance') === 'blue' ? 'blue' : 'red';
    startingPosition = query.get('start') || '';
  });
</script>

<svelte:head><title>Match Scouting</title></svelte:head>

<main class="match-scouting-page">
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
      <button class:active={phase === 'auto'} on:click={() => selectPhase('auto')}><Route size={18} /><span>Auto</span><small>02</small></button>
      <button class:active={phase === 'teleop'} on:click={() => selectPhase('teleop')}><Timer size={18} /><span>Teleop</span><small>03</small></button>
      <button class:active={phase === 'postmatch'} on:click={() => selectPhase('postmatch')}><Trophy size={18} /><span>Post-match</span><small>04</small></button>
    </aside>

    <section class="match-workspace">
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
          <label>Robot #<input class="form-input" inputmode="numeric" placeholder="971" bind:value={robotNumber} /></label>
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
        <div class="section-footer"><span>{assignmentReady ? `Robot ${robotNumber} is ready to scout.` : 'Match, robot, and starting position are required.'}</span><button class="btn btn-primary" disabled={!assignmentReady} on:click={() => selectPhase('auto')}>Begin auto <ChevronRight size={16} /></button></div>
      {:else if phase === 'auto'}
        <div class="section-heading"><div><span class="eyebrow">Autonomous</span><h2>Auto report</h2><p>Capture what the robot attempted and where it traveled.</p></div><Route size={20} /></div>
        <div class="auto-layout">
          <div class="auto-controls">
            <div class="control-group"><span class="field-label">Starting zone</span><div class="choice-grid">{#each AUTO_ZONES as zone}<button class:chosen={autoStartZone === zone} on:click={() => autoStartZone = zone}>{zone}</button>{/each}</div></div>
            <div class="control-group"><span class="field-label">Estimated points</span><div class="choice-grid four">{#each POINT_BANDS as band}<button class:chosen={autoPoints === band} on:click={() => autoPoints = band}>{band}</button>{/each}</div></div>
            <div class="control-group"><span class="field-label">End action</span><div class="choice-grid"><button class:chosen={autoFinish === 'shoot'} on:click={() => autoFinish = 'shoot'}>Shoot</button><button class:chosen={autoFinish === 'climb'} on:click={() => autoFinish = 'climb'}>Climb</button><button class:chosen={autoFinish === 'none'} on:click={() => autoFinish = 'none'}>Neither</button></div></div>
            <div class="control-group"><span class="field-label">Ball source</span><div class="choice-grid">{#each ['alliance zone', 'neutral zone', 'human player'] as source}<button class:chosen={ballSources.includes(source)} on:click={() => toggleBallSource(source)}>{source}</button>{/each}</div></div>
            <div class="control-group"><span class="field-label">Did it run?</span><div class="segmented"><button class:chosen={autoMoved === 'ran'} on:click={() => autoMoved = 'ran'}>Ran</button><button class:chosen={autoMoved === 'did-not-run'} on:click={() => autoMoved = 'did-not-run'}>Did not run</button></div></div>
          </div>
          <div class="path-panel"><div class="path-heading"><span class="field-label">Robot path</span><button class="btn btn-sm" on:click={() => autoPath = []} disabled={!autoPath.length}><RotateCcw size={14} /> Clear</button></div><div class="field-board" role="application" aria-label="Draw the robot's autonomous path" on:pointerdown={beginPath} on:pointermove={extendPath} on:pointerup={completePath} on:pointercancel={completePath}><div class="field-line midline"></div><div class="field-zone top-zone"></div><div class="field-zone bottom-zone"></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{#if autoPath.length > 1}<polyline points={autoPath.map(([x, y]) => `${x},${y}`).join(' ')} />{/if}{#if autoPath.length}<circle cx={autoPath[0][0]} cy={autoPath[0][1]} r="2.2" class="path-start" />{/if}</svg></div></div>
        </div>
        <div class="section-footer"><button class="btn" on:click={() => selectPhase('prematch')}>Back</button><button class="btn btn-primary" on:click={() => selectPhase('teleop')}>Continue to teleop <ChevronRight size={16} /></button></div>
      {:else if phase === 'teleop'}
        <div class="section-heading"><div><span class="eyebrow">Teleop</span><h2>Driver and robot performance</h2><p>Use the ratings for the details that separate similar robots.</p></div><Timer size={20} /></div>
        <div class="ratings-grid">{#each RATING_FIELDS as field}<div class="rating-row"><span>{field}</span><div class="rating-buttons">{#each [1, 2, 3, 4, 5] as value}<button class:chosen={ratings[field] === value} on:click={() => ratings = { ...ratings, [field]: value }}>{value}</button>{/each}</div></div>{/each}</div>
        <label class="notes-label">Additional notes<textarea class="form-input" rows="5" placeholder="What mattered during teleop?" bind:value={teleopNotes}></textarea></label>
        <label class="incident-toggle"><input type="checkbox" bind:checked={crashOrBreak} /><span><AlertTriangle size={17} /> Crash or mechanical break</span></label>
        <div class="section-footer"><button class="btn" on:click={() => selectPhase('auto')}>Back</button><button class="btn btn-primary" on:click={() => selectPhase('postmatch')}>Continue to post-match <ChevronRight size={16} /></button></div>
      {:else}
        <div class="section-heading"><div><span class="eyebrow">Post-match</span><h2>Match outcome</h2><p>Close out the report and flag anything the pit crew needs to inspect.</p></div><Trophy size={20} /></div>
        <div class="post-grid"><fieldset><legend>Robot status</legend><div class="choice-grid"><button class:chosen={robotDisabled === 'no'} on:click={() => robotDisabled = 'no'}>Stayed active</button><button class:chosen={robotDisabled === 'disabled'} on:click={() => robotDisabled = 'disabled'}>Disabled</button><button class:chosen={robotDisabled === 'died'} on:click={() => robotDisabled = 'died'}>Died</button></div></fieldset><fieldset><legend>Cards</legend><div class="choice-grid"><button class:chosen={card === 'none'} on:click={() => card = 'none'}>None</button><button class:chosen={card === 'yellow'} on:click={() => card = 'yellow'}>Yellow</button><button class:chosen={card === 'red'} on:click={() => card = 'red'}>Red</button></div></fieldset></div>
        <div class="control-group"><span class="field-label">Driver skill</span><div class="rating-buttons large">{#each [1, 2, 3, 4, 5] as value}<button class:chosen={driverSkill === value} on:click={() => driverSkill = value}>{value}</button>{/each}</div></div>
        <label class="incident-toggle"><input type="checkbox" bind:checked={pitProblem} /><span><AlertTriangle size={17} /> Flag a problem for pit scouting</span></label>
        {#if pitProblem}
          <label class="notes-label pit-report-field">Problem for pit crew<textarea class="form-input" rows="3" placeholder="What should the pit crew inspect before the next match?" bind:value={pitProblemDetails}></textarea></label>
        {/if}
        <label class="notes-label">Freeform notes<textarea class="form-input" rows="5" placeholder="Anything strategy should know?" bind:value={postNotes}></textarea></label>
        <div class="section-footer"><button class="btn" on:click={() => selectPhase('teleop')}>Back</button><button class="btn btn-primary" on:click={finishScout} disabled={saving}>{saving ? 'Saving...' : 'Finish match scouting'} <Check size={16} /></button></div>
        {#if error}<p class="submit-error">{error}</p>{/if}
      {/if}
    </section>
  </div>
</main>

<style>
  .submit-error { margin:var(--space-2) 0 0; color:var(--danger); font-size:.85rem; }
  .match-scouting-page { max-width:1200px; margin:0 auto; padding:var(--space-4); }
  h1,h2 { margin:0; } h1 { display:flex; align-items:center; gap:var(--gap-2); } h2 { font-size:1.2rem; }
  .assignment-chip { display:flex; align-items:center; gap:var(--gap-2); border:1px solid var(--border); padding:var(--space-2) var(--space-3); background:var(--surface-2); font-size:.85rem; }
  .assignment-chip b { text-transform:uppercase; font-size:.72rem; } .assignment-chip.red b { color:var(--red-strong); } .assignment-chip.blue b { color:var(--blue-strong); }
  .scouting-shell { display:grid; grid-template-columns:12rem minmax(0,1fr); gap:var(--gap-4); align-items:start; }
  .stage-nav { position:sticky; top:var(--space-4); display:grid; border:1px solid var(--border); background:var(--surface-1); }
  .stage-nav button { display:flex; gap:var(--gap-2); align-items:center; min-height:3.25rem; padding:var(--space-3); border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text-muted); text-align:left; cursor:pointer; }
  .stage-nav button:last-child { border-bottom:0; } .stage-nav button.active { color:var(--text); background:var(--brand-gold-soft); box-shadow:inset 3px 0 0 var(--brand-gold-base); } .stage-nav button:disabled { cursor:not-allowed; opacity:.5; }
  .stage-nav span,.eyebrow,.field-label { color:var(--text-muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; }
  .section-heading { display:flex; align-items:start; justify-content:space-between; gap:var(--gap-3); margin-bottom:var(--space-5); } .section-heading :global(svg) { color:var(--text-muted); }
  .assignment-grid,.post-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--gap-4); } label,fieldset { display:grid; gap:var(--space-2); color:var(--text-muted); font-size:.8rem; } fieldset { margin:0; padding:0; border:0; } legend { padding:0; }
  .segmented,.choice-grid,.position-grid,.rating-buttons { display:flex; flex-wrap:wrap; gap:var(--gap-2); } .segmented button,.choice-grid button,.position-grid button,.rating-buttons button { min-height:var(--control-height); padding:0 var(--space-3); border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface-1); color:var(--text); cursor:pointer; }
  .segmented button.chosen,.choice-grid button.chosen,.position-grid button.chosen,.rating-buttons button.chosen { border-color:var(--brand-gold-strong); background:var(--brand-gold-soft); color:var(--secondary); font-weight:600; } .segmented .red-choice.chosen { border-color:var(--red-base); background:var(--red-soft); } .segmented .blue-choice.chosen { border-color:var(--blue-base); background:var(--blue-soft); }
  .start-position-block,.control-group,.notes-label,.incident-toggle { margin-top:var(--space-5); } .position-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); margin-top:var(--space-2); } .position-grid button { min-height:4rem; text-transform:capitalize; }
  .section-footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--gap-3); margin-top:var(--space-6); padding-top:var(--space-4); border-top:1px solid var(--border); color:var(--text-muted); font-size:.82rem; } .section-footer .btn { display:inline-flex; align-items:center; gap:var(--gap-2); }
  .auto-layout { display:grid; grid-template-columns:minmax(18rem,.9fr) minmax(18rem,1.1fr); gap:var(--space-6); } .auto-controls { display:grid; align-content:start; gap:var(--space-1); } .choice-grid { margin-top:var(--space-2); } .choice-grid.four { display:grid; grid-template-columns:repeat(4,1fr); }
  .path-panel { display:grid; gap:var(--space-2); } .path-heading { display:flex; justify-content:space-between; align-items:center; } .field-board { position:relative; aspect-ratio:1.8; overflow:hidden; border:1px solid var(--border); background:#edf3e9; cursor:crosshair; touch-action:none; } .field-line { position:absolute; background:#a4b09d; } .midline { top:0; bottom:0; left:50%; width:1px; } .field-zone { position:absolute; width:22%; height:18%; border:1px solid #a4b09d; } .top-zone { top:7%; left:39%; } .bottom-zone { bottom:7%; left:39%; } .field-board svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; } .field-board polyline { fill:none; stroke:var(--brand-gold-strong); stroke-width:1.2; stroke-linecap:round; stroke-linejoin:round; } .field-board .path-start { fill:var(--blue-base); }
  .ratings-grid { display:grid; gap:var(--space-3); } .rating-row { display:flex; align-items:center; justify-content:space-between; gap:var(--gap-4); padding-bottom:var(--space-3); border-bottom:1px solid var(--border); } .rating-row span { font-size:.9rem; } .rating-buttons button { width:2.25rem; padding:0; } .rating-buttons.large button { width:3rem; min-height:2.5rem; }
  .notes-label textarea { resize:vertical; min-height:7rem; } .incident-toggle { display:flex; grid-template-columns:auto 1fr; align-items:center; color:var(--text); font-size:.9rem; } .incident-toggle span { display:flex; align-items:center; gap:var(--gap-2); } .incident-toggle :global(svg) { color:var(--red-base); }
  .pit-report-field { margin-top:var(--space-3); }
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
  @media (max-width:850px) { .scouting-shell { grid-template-columns:1fr; } .stage-nav { position:static; grid-template-columns:repeat(4,1fr); } .stage-nav button { flex-direction:column; justify-content:center; text-align:center; padding:var(--space-2); } .assignment-grid,.post-grid,.auto-layout { grid-template-columns:1fr; } .position-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:560px) { .match-scouting-page { padding:var(--space-3); } .page-header { align-items:flex-start; } .assignment-chip { width:100%; justify-content:space-between; } .stage-nav { grid-template-columns:repeat(2,1fr); } .rating-row { align-items:flex-start; flex-direction:column; } .choice-grid.four { grid-template-columns:repeat(2,1fr); } }

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
  .field-board { background:#e7eee3; }
  .ratings-grid { padding:var(--space-4); border:1px solid var(--border); }
  .rating-row:last-child { padding-bottom:0; border-bottom:0; }
  .rating-buttons button { border-radius:50%; }
  .notes-label { padding:var(--space-4); border:1px solid var(--border); }
  .incident-toggle { padding:var(--space-3) var(--space-4); border-left:3px solid var(--red-base); background:var(--red-soft); }
  .post-grid { padding:var(--space-4); border:1px solid var(--border); background:var(--surface-2); }
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
