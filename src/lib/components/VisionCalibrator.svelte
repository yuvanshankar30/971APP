<script>
  // Click-to-draw calibration for one camera view, replacing hand-typed JSON
  // for the field mask, goal zones, start zones, and homography. Draws against
  // a paused frame of the view's own recording, which is the only way to know
  // where the field actually sits in this camera's image.
  //
  // Two coordinate spaces, deliberately: every polygon (mask, goal, start) is
  // normalized 0-1 so one calibration survives a resolution change (see
  // build_mask/point_in_zone in vision_runner.py), while homography source
  // points are raw pixels of the source video, because field_point() applies
  // the matrix to pixel-space box centres.
  import { calibrationPointFromClick, solveHomography } from '$lib/homography.js';

  export let view;
  export let onSave = async () => {};
  export let busy = false;

  // Exactly the values written for auto_start_position by the scouting
  // surfaces that record it. Vision
  // has to speak the same vocabulary or the released event is unreadable
  // alongside hand-scouted matches.
  const START_POSITIONS = ['left trench', 'left mound', 'center', 'right mound', 'right trench'];

  let mode = 'mask';
  let player;
  let frame;
  let maskPoints = (view.field_mask || []).map((point) => [...point]);
  let zones = (view.goal_zones || []).map((zone) => ({ ...zone, polygon: (zone.polygon || []).map((p) => [...p]) }));
  let startZones = (view.start_zones || []).map((zone) => ({ ...zone, polygon: (zone.polygon || []).map((p) => [...p]) }));
  let activeZoneIndex = -1;
  let activeStartIndex = -1;
  let homographyPoints = (view.calibration_points || []).map((point) => ({ ...point }));
  let message = '';

  $: activeZone = activeZoneIndex >= 0 ? zones[activeZoneIndex] : null;
  $: activeStartZone = activeStartIndex >= 0 ? startZones[activeStartIndex] : null;
  $: currentPolygon = mode === 'mask' ? maskPoints
    : mode === 'zones' ? (activeZone?.polygon || [])
    : mode === 'start' ? (activeStartZone?.polygon || [])
    : [];
  $: homographyMatrix = solveHomography(
    homographyPoints.map((point) => [point.x, point.y]),
    homographyPoints.map((point) => [Number(point.fieldX), Number(point.fieldY)])
  );

  function addPoint(event) {
    const point = calibrationPointFromClick(
      event,
      event.currentTarget.getBoundingClientRect(),
      player?.videoWidth,
      player?.videoHeight
    );
    if (!point) return;
    message = '';
    if (mode === 'mask') {
      maskPoints = [...maskPoints, point.normalized];
    } else if (mode === 'zones') {
      if (!activeZone) { message = 'Add or select a goal zone first.'; return; }
      activeZone.polygon = [...activeZone.polygon, point.normalized];
      zones = zones;
    } else if (mode === 'start') {
      if (!activeStartZone) { message = 'Add or select a start zone first.'; return; }
      activeStartZone.polygon = [...activeStartZone.polygon, point.normalized];
      startZones = startZones;
    } else if (homographyPoints.length < 4) {
      homographyPoints = [...homographyPoints, { x: point.pixels[0], y: point.pixels[1], fieldX: '', fieldY: '' }];
    } else {
      message = 'Four points is all a homography needs - undo one to move it.';
    }
  }

  function undo() {
    if (mode === 'mask') maskPoints = maskPoints.slice(0, -1);
    else if (mode === 'zones' && activeZone) { activeZone.polygon = activeZone.polygon.slice(0, -1); zones = zones; }
    else if (mode === 'start' && activeStartZone) { activeStartZone.polygon = activeStartZone.polygon.slice(0, -1); startZones = startZones; }
    else if (mode === 'homography') homographyPoints = homographyPoints.slice(0, -1);
  }

  function addStartZone() {
    const unused = START_POSITIONS.find((label) => !startZones.some((zone) => zone.label === label));
    startZones = [...startZones, { label: unused || START_POSITIONS[0], polygon: [] }];
    activeStartIndex = startZones.length - 1;
  }

  function removeStartZone(index) {
    startZones = startZones.filter((_, i) => i !== index);
    activeStartIndex = Math.min(activeStartIndex, startZones.length - 1);
  }

  function addZone() {
    zones = [...zones, { label: `Goal ${zones.length + 1}`, alliance: 'red', polygon: [] }];
    activeZoneIndex = zones.length - 1;
  }

  function removeZone(index) {
    zones = zones.filter((_, i) => i !== index);
    activeZoneIndex = Math.min(activeZoneIndex, zones.length - 1);
  }

  function polygonPoints(polygon) {
    // The overlay is a 0-100 viewBox so normalized coordinates map directly
    // and the drawing scales with however the video is laid out.
    return polygon.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
  }

  async function save() {
    message = '';
    const payload = { action: 'update-view', id: view.id };
    if (mode === 'mask' || maskPoints.length) payload.field_mask = maskPoints.length >= 3 ? maskPoints : null;
    payload.goal_zones = zones.filter((zone) => (zone.polygon || []).length >= 3);
    payload.start_zones = startZones.filter((zone) => (zone.polygon || []).length >= 3);
    if (homographyPoints.length === 4) {
      if (!homographyMatrix) {
        message = 'Those four points do not define a homography - three are collinear, or two are on top of each other. Move one and try again.';
        return;
      }
      payload.homography = homographyMatrix;
      payload.calibration_points = homographyPoints;
    }
    await onSave(payload);
    message = 'Calibration saved.';
  }
</script>

<div class="calibrator">
  <div class="calibrator-modes">
    <button class="btn btn-sm" class:active={mode === 'mask'} on:click={() => (mode = 'mask')}>Field mask</button>
    <button class="btn btn-sm" class:active={mode === 'zones'} on:click={() => (mode = 'zones')}>Goal zones</button>
    <button class="btn btn-sm" class:active={mode === 'start'} on:click={() => (mode = 'start')}>Start zones</button>
    <button class="btn btn-sm" class:active={mode === 'homography'} on:click={() => (mode = 'homography')}>Homography</button>
    <button class="btn btn-sm" on:click={undo} disabled={busy}>Undo point</button>
    <button class="btn btn-primary btn-sm" on:click={save} disabled={busy}>Save calibration</button>
  </div>

  <p class="calibrator-hint">
    {#if mode === 'mask'}
      Trace the playing field. Anything outside it — audience, scoreboard, the pits — is discarded before detection runs.
    {:else if mode === 'zones'}
      Outline each scoring target. A game piece whose trajectory ends inside one counts as scored, and is credited to whichever robot it was launched from.
    {:else if mode === 'start'}
      Outline the named starting regions. Whichever one a robot is sitting in when auto begins becomes its <code>auto_start_position</code> — the same field a scout picks by hand. Leave these blank and vision simply won't report it.
    {:else}
      Click four field landmarks you know the real coordinates of — corners work well — then type each one's field position. Any consistent unit.
    {/if}
  </p>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="calibrator-stage" bind:this={frame}>
    <video bind:this={player} src={view.signed_url} controls muted preload="metadata"></video>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" on:click={addPoint} role="presentation">
      {#if mode !== 'homography'}
        {#if currentPolygon.length >= 2}
          <polygon points={polygonPoints(currentPolygon)} class="drawn" />
        {/if}
        {#each currentPolygon as [x, y]}
          <circle cx={x * 100} cy={y * 100} r="1.1" class="handle" />
        {/each}
        {#if mode === 'zones'}
          {#each zones as zone, index}
            {#if index !== activeZoneIndex && (zone.polygon || []).length >= 3}
              <polygon points={polygonPoints(zone.polygon)} class="drawn other" />
            {/if}
          {/each}
        {:else if mode === 'start'}
          {#each startZones as zone, index}
            {#if index !== activeStartIndex && (zone.polygon || []).length >= 3}
              <polygon points={polygonPoints(zone.polygon)} class="drawn other" />
            {/if}
          {/each}
        {/if}
      {:else}
        {#each homographyPoints as point, index}
          <circle
            cx={(point.x / (player?.videoWidth || 1)) * 100}
            cy={(point.y / (player?.videoHeight || 1)) * 100}
            r="1.1"
            class="handle"
          />
          <text
            x={(point.x / (player?.videoWidth || 1)) * 100 + 1.6}
            y={(point.y / (player?.videoHeight || 1)) * 100}
          >{index + 1}</text>
        {/each}
      {/if}
    </svg>
  </div>

  {#if mode === 'zones'}
    <div class="zone-editor">
      <button class="btn btn-sm" on:click={addZone}>Add goal zone</button>
      {#each zones as zone, index}
        <div class="zone-row" class:active={index === activeZoneIndex}>
          <button class="btn btn-sm" on:click={() => (activeZoneIndex = index)}>{index === activeZoneIndex ? 'Drawing' : 'Draw'}</button>
          <input class="form-input" bind:value={zone.label} aria-label="Goal zone label" />
          <select class="form-input" bind:value={zone.alliance} aria-label="Goal zone alliance">
            <option value="red">red</option>
            <option value="blue">blue</option>
          </select>
          <span class="zone-count">{zone.polygon.length} pts</span>
          <button class="btn btn-sm" on:click={() => removeZone(index)}>Remove</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if mode === 'start'}
    <div class="zone-editor">
      <button class="btn btn-sm" on:click={addStartZone} disabled={startZones.length >= START_POSITIONS.length}>Add start zone</button>
      {#each startZones as zone, index}
        <div class="zone-row" class:active={index === activeStartIndex}>
          <button class="btn btn-sm" on:click={() => (activeStartIndex = index)}>{index === activeStartIndex ? 'Drawing' : 'Draw'}</button>
          <!-- A fixed list, not free text: the released value has to be one
               datascout also writes, or it's unreadable next to hand-scouted
               matches. -->
          <select class="form-input" bind:value={zone.label} aria-label="Start zone position">
            {#each START_POSITIONS as position}<option value={position}>{position}</option>{/each}
          </select>
          <span class="zone-count">{zone.polygon.length} pts</span>
          <button class="btn btn-sm" on:click={() => removeStartZone(index)}>Remove</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if mode === 'homography'}
    <div class="homography-editor">
      {#each homographyPoints as point, index}
        <div class="homography-row">
          <span>{index + 1}. pixel {Math.round(point.x)}, {Math.round(point.y)}</span>
          <input class="form-input" type="number" placeholder="field X" bind:value={point.fieldX} aria-label={`Point ${index + 1} field X`} />
          <input class="form-input" type="number" placeholder="field Y" bind:value={point.fieldY} aria-label={`Point ${index + 1} field Y`} />
        </div>
      {/each}
      <p class="calibrator-hint">
        {#if homographyPoints.length < 4}
          {4 - homographyPoints.length} more point{homographyPoints.length === 3 ? '' : 's'} to click.
        {:else if homographyMatrix}
          Solved. Saving will store the 3×3 matrix.
        {:else}
          These four points do not define a homography — three are collinear, or two coincide.
        {/if}
      </p>
    </div>
  {/if}

  {#if message}<p class="calibrator-message">{message}</p>{/if}
</div>

<style>
  .calibrator { display:grid; gap:var(--space-3); }
  .calibrator-modes { display:flex; flex-wrap:wrap; gap:var(--gap-2); }
  .calibrator-modes .active { border-color:var(--brand-gold-base,#d9a413); }
  .calibrator-hint { margin:0; color:var(--text-muted); font-size:.82rem; }
  .calibrator-message { margin:0; color:var(--text-muted); font-size:.82rem; }
  .calibrator-stage { position:relative; display:inline-block; width:min(100%, 56rem); max-width:100%; background:#000; }
  .calibrator-stage video { display:block; width:100%; max-width:100%; border-radius:var(--radius-md); }
  .calibrator-stage svg { position:absolute; inset:0; width:100%; height:100%; cursor:crosshair; }
  .drawn { fill:color-mix(in srgb, var(--brand-gold-base,#d9a413) 22%, transparent); stroke:var(--brand-gold-base,#d9a413); stroke-width:.4; }
  .drawn.other { fill:color-mix(in srgb, var(--text-muted) 12%, transparent); stroke:var(--text-muted); }
  .handle { fill:var(--brand-gold-base,#d9a413); }
  text { fill:var(--text); font-size:3px; dominant-baseline:middle; }
  .zone-editor, .homography-editor { display:grid; gap:var(--gap-2); }
  .zone-row, .homography-row { display:grid; grid-template-columns:auto minmax(6rem,1fr) auto auto auto; gap:var(--gap-2); align-items:center; }
  .zone-count { white-space:nowrap; }
  .homography-row { grid-template-columns:minmax(10rem,1fr) 7rem 7rem; }
  .zone-row.active { outline:1px solid var(--brand-gold-base,#d9a413); border-radius:var(--radius-sm); }
  .zone-count { color:var(--text-muted); font-size:.78rem; }
  @media (max-width:700px) {
    .zone-row, .homography-row { grid-template-columns:1fr; }
    .calibrator-modes .btn { flex:1 1 8rem; }
  }
</style>
