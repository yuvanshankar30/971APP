<script>
  import {
    AUTO_FIELD,
    AUTO_ROBOT_SIZE,
    autoCenterlineIntervals,
    autoPointToField,
    autoRobotCollision,
    canExtendAutoPath,
    continueAutoPath,
    robotBoundsAtAutoPoint
  } from '$lib/matchScouting.js';

  export let alliance = 'blue';
  export let path = [];

  let drawing = false;
  let hoverPoint = null;
  let inspectedPathIndex = 0;
  let blockedBy = null;
  const fieldWidth = AUTO_FIELD.width;
  const fieldHeight = AUTO_FIELD.height;

  $: ownColor = alliance === 'red' ? '#d12c36' : '#2468c7';
  $: opponentColor = alliance === 'red' ? '#2468c7' : '#d12c36';
  $: pathPoints = path.map(([x, y]) => `${x * 10},${y * 4.87}`).join(' ');
  $: inspectedPathIndex = Math.min(inspectedPathIndex, Math.max(0, path.length - 1));
  $: inspectedPoint = path.length ? path[inspectedPathIndex] : null;
  $: previewPoint = hoverPoint || inspectedPoint;
  $: previewBounds = previewPoint ? robotBoundsAtAutoPoint(previewPoint) : null;
  $: previewCollision = previewPoint ? autoRobotCollision(previewPoint) : null;
  $: crossingSegments = path.slice(1).flatMap((point, index) => {
    const start = path[index];
    const startField = autoPointToField(start);
    const endField = autoPointToField(point);
    return autoCenterlineIntervals(start, point).map(([from, to]) => ({
      x1: startField.x + (endField.x - startField.x) * from,
      y1: startField.y + (endField.y - startField.y) * from,
      x2: startField.x + (endField.x - startField.x) * to,
      y2: startField.y + (endField.y - startField.y) * to
    }));
  });
  $: crossingMarkers = path.reduce((markers, point, index) => {
    const bounds = robotBoundsAtAutoPoint(point);
    const verticalOverlap = bounds.x < fieldWidth / 2 && bounds.x + bounds.width > fieldWidth / 2;
    const horizontalOverlap = bounds.y < fieldHeight / 2 && bounds.y + bounds.height > fieldHeight / 2;
    const previous = index ? path[index - 1] : null;
    const previousBounds = previous ? robotBoundsAtAutoPoint(previous) : null;
    const wasVertical = previousBounds && previousBounds.x < fieldWidth / 2 && previousBounds.x + previousBounds.width > fieldWidth / 2;
    const wasHorizontal = previousBounds && previousBounds.y < fieldHeight / 2 && previousBounds.y + previousBounds.height > fieldHeight / 2;
    if ((!verticalOverlap || wasVertical) && (!horizontalOverlap || wasHorizontal)) return markers;
    const inchesPerPixel = AUTO_FIELD.robotSizeInches / AUTO_ROBOT_SIZE.width;
    const overlap = (min, max) => Math.max(0, Math.min(min, max)) * inchesPerPixel;
    markers.push({
      bounds,
      vertical: verticalOverlap && !wasVertical
        ? overlap(bounds.x + bounds.width - fieldWidth / 2, fieldWidth / 2 - bounds.x)
        : 0,
      horizontal: horizontalOverlap && !wasHorizontal
        ? overlap(bounds.y + bounds.height - fieldHeight / 2, fieldHeight / 2 - bounds.y)
        : 0
    });
    return markers;
  }, []);

  function pointFromEvent(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100))
    ];
  }

  function beginPath(event) {
    drawing = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = pointFromEvent(event);
    hoverPoint = point;
    const result = canExtendAutoPath(path, point);
    if (!result.allowed) {
      blockedBy = result.collision?.label || 'protected field geometry';
      appendSafeTerminalPoint(result);
      return;
    }
    blockedBy = null;
    path = continueAutoPath(path, point);
    inspectedPathIndex = path.length - 1;
  }

  function extendPath(event) {
    const point = pointFromEvent(event);
    hoverPoint = point;
    if (!drawing) return;
    const last = path[path.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 0.8) {
      const result = canExtendAutoPath(path, point);
      if (!result.allowed) {
        blockedBy = result.collision?.label || 'protected field geometry';
        appendSafeTerminalPoint(result);
        return;
      }
      blockedBy = null;
      path = [...path, point];
      inspectedPathIndex = path.length - 1;
    }
  }

  function completePath() {
    drawing = false;
  }

  function appendSafeTerminalPoint(result) {
    const safePoint = result?.lastSafePoint;
    const last = path.at(-1);
    if (!safePoint || !last || Math.hypot(safePoint[0] - last[0], safePoint[1] - last[1]) <= 0.1) return;
    path = [...path, safePoint];
    inspectedPathIndex = path.length - 1;
  }

  function clearPreview() {
    if (!drawing) hoverPoint = null;
  }
</script>

<div class="field-map">
  <div
    class="field-board"
    role="application"
    aria-label={`Draw the optional autonomous path on an alliance-relative 2026 REBUILT field. The ${alliance} alliance wall is on the left.`}
    on:pointerdown={beginPath}
    on:pointermove={extendPath}
    on:pointerup={completePath}
    on:pointercancel={completePath}
    on:pointerleave={() => { completePath(); clearPreview(); }}
  >
  <svg viewBox={`0 0 ${fieldWidth} ${fieldHeight}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <rect class="carpet" x="8" y="8" width="984" height="471" />
    <path class="guardrail" d="M8 8H992V479H8Z" />
    <line class="center-line" x1="500" y1="8" x2="500" y2="479" />

    <!-- Alliance walls and starting lines. The map is alliance-relative: the
         scout's own wall is always left, matching AdvantageScope's selectable
         orientation while making red and blue paths directly comparable. -->
    <line class="alliance-wall" style={`stroke:${ownColor}`} x1="8" y1="8" x2="8" y2="479" />
    <line class="alliance-wall" style={`stroke:${opponentColor}`} x1="992" y1="8" x2="992" y2="479" />
    <line class="starting-line" style={`stroke:${ownColor}`} x1="258" y1="8" x2="258" y2="479" />
    <line class="starting-line" style={`stroke:${opponentColor}`} x1="742" y1="8" x2="742" y2="479" />

    <!-- Bumps and trenches, simplified from the WPILib/AdvantageScope 2026
         flat field so the important driveable geometry remains readable on a
         phone instead of becoming a photographic blur. -->
    <g style={`--alliance:${ownColor}`}>
      <rect class="bump" x="260" y="76" width="65" height="105" />
      <rect class="bump" x="260" y="306" width="65" height="105" />
      <rect class="trench" x="260" y="14" width="34" height="55" />
      <rect class="trench" x="260" y="418" width="34" height="55" />
    </g>
    <g style={`--alliance:${opponentColor}`}>
      <rect class="bump" x="675" y="76" width="65" height="105" />
      <rect class="bump" x="675" y="306" width="65" height="105" />
      <rect class="trench" x="706" y="14" width="34" height="55" />
      <rect class="trench" x="706" y="418" width="34" height="55" />
    </g>

    <!-- Hubs -->
    <g class="hub" style={`--alliance:${ownColor}`} transform="translate(292 244)">
      <rect x="-46" y="-46" width="92" height="92" />
      <polygon points="-24,-40 24,-40 40,-24 40,24 24,40 -24,40 -40,24 -40,-24" />
      <circle r="19" />
    </g>
    <g class="hub" style={`--alliance:${opponentColor}`} transform="translate(708 244)">
      <rect x="-46" y="-46" width="92" height="92" />
      <polygon points="-24,-40 24,-40 40,-24 40,24 24,40 -24,40 -40,24 -40,-24" />
      <circle r="19" />
    </g>

    <!-- Towers / outposts and fuel depots -->
    <path class="tower" style={`stroke:${ownColor}`} d="M8 211H68L91 244L68 277H8Z" />
    <path class="tower" style={`stroke:${opponentColor}`} d="M992 211H932L909 244L932 277H992Z" />
    <g class="depot" style={`--alliance:${ownColor}`}>
      <rect x="10" y="42" width="45" height="54" />
      <rect x="10" y="391" width="45" height="54" />
    </g>
    <g class="depot" style={`--alliance:${opponentColor}`}>
      <rect x="945" y="42" width="45" height="54" />
      <rect x="945" y="391" width="45" height="54" />
    </g>

    <rect class="neutral-fuel" x="455" y="117" width="90" height="253" />
    <g class="field-labels">
      <text x="35" y="466">{alliance} wall / start</text>
      <text x="500" y="466" text-anchor="middle">neutral zone</text>
      <text x="965" y="466" text-anchor="end">opponent wall</text>
      <text x="292" y="249" text-anchor="middle">hub</text>
      <text x="708" y="249" text-anchor="middle">hub</text>
    </g>

    {#if path.length > 1}
      <polyline class="robot-path-shadow" points={pathPoints} />
      <polyline class="robot-path" points={pathPoints} />
      {#each crossingSegments as segment}
        <line class="robot-path-crossing" {...segment} />
      {/each}
    {/if}
    {#each crossingMarkers as marker}
      <g class="crossing-footprint">
        <rect {...marker.bounds} />
        <text x={marker.bounds.x + marker.bounds.width / 2} y={marker.bounds.y - 6} text-anchor="middle">
          {marker.vertical ? `V ${marker.vertical.toFixed(1)} in` : ''}{marker.vertical && marker.horizontal ? ' / ' : ''}{marker.horizontal ? `H ${marker.horizontal.toFixed(1)} in` : ''}
        </text>
      </g>
    {/each}
    {#if previewBounds}
      <g class:blocked={!!previewCollision} class="robot-footprint-preview">
        <rect {...previewBounds} />
        <text x={previewBounds.x + previewBounds.width / 2} y={previewBounds.y + previewBounds.height / 2} text-anchor="middle">29 in</text>
      </g>
    {/if}
    {#if path.length}
      <circle class="path-start" cx={path[0][0] * 10} cy={path[0][1] * 4.87} r="9" />
      <circle class="path-end" cx={path[path.length - 1][0] * 10} cy={path[path.length - 1][1] * 4.87} r="7" />
    {/if}
  </svg>
  </div>
  <div class="path-inspector">
    <span>Robot footprint: 29 x 29 in</span>
    {#if path.length}
      <label>
        Inspect route position
        <input type="range" min="0" max={path.length - 1} step="1" bind:value={inspectedPathIndex} />
      </label>
      <span>{inspectedPathIndex + 1} / {path.length}</span>
    {/if}
    <span class="path-legend"><i class="normal"></i> Route <i class="crossing"></i> Centerline overlap</span>
  </div>
  {#if blockedBy}<small class="path-warning">Path stopped before the robot footprint reached the {blockedBy}.</small>{/if}
</div>

<style>
  .field-map { display:grid; gap:var(--space-2); }
  .field-board { position:relative; width:100%; aspect-ratio:2.053; overflow:hidden; border:1px solid var(--border); background:#5e605f; cursor:crosshair; touch-action:none; user-select:none; }
  svg { display:block; width:100%; height:100%; }
  .carpet { fill:#666866; }
  .guardrail { fill:none; stroke:#202221; stroke-width:7; }
  .center-line { stroke:#d9dad8; stroke-width:2; opacity:.8; }
  .alliance-wall { stroke-width:8; }
  .starting-line { stroke-width:3; opacity:.95; }
  .bump { fill:color-mix(in srgb, var(--alliance) 80%, #222); stroke:#151515; stroke-width:3; }
  .trench { fill:color-mix(in srgb, var(--alliance) 72%, #161616); stroke:#111; stroke-width:3; }
  .hub rect { fill:color-mix(in srgb, var(--alliance) 24%, #b9bab8); stroke:#171817; stroke-width:5; }
  .hub polygon { fill:#b9bab8; stroke:var(--alliance); stroke-width:7; }
  .hub circle { fill:#6d706d; stroke:#202220; stroke-width:3; }
  .tower { fill:#242625; stroke-width:4; }
  .depot rect { fill:#d6b52c; stroke:var(--alliance); stroke-width:4; }
  .neutral-fuel { fill:#d8b832; opacity:.55; stroke:#302b14; stroke-width:2; stroke-dasharray:5 5; }
  .field-labels { pointer-events:none; fill:#f5f5f0; font-family:var(--font-mono-stack); font-size:13px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
  .field-labels text:nth-last-child(-n+2) { fill:#181918; font-size:11px; }
  .robot-path-shadow { fill:none; stroke:#111; stroke-width:12; stroke-linecap:round; stroke-linejoin:round; opacity:.5; }
  .robot-path { fill:none; stroke:#ffd34e; stroke-width:7; stroke-linecap:round; stroke-linejoin:round; }
  .robot-path-crossing { stroke:#da3340; stroke-width:7; stroke-linecap:round; }
  .path-start { fill:#fff; stroke:#151515; stroke-width:4; }
  .path-end { fill:#ffd34e; stroke:#151515; stroke-width:3; }
  .robot-footprint-preview rect { fill:#e9f0f6; fill-opacity:.22; stroke:#f5f7f4; stroke-width:2; stroke-dasharray:5 3; }
  .robot-footprint-preview text { fill:#f7f7f4; font-size:10px; font-weight:700; pointer-events:none; }
  .robot-footprint-preview.blocked rect { fill:#da3340; fill-opacity:.28; stroke:#ff6874; }
  .robot-footprint-preview.blocked text { fill:#ffccd2; }
  .crossing-footprint rect { fill:#da3340; fill-opacity:.15; stroke:#ff6c75; stroke-width:2; stroke-dasharray:4 3; }
  .crossing-footprint text { fill:#ffd7da; stroke:#262222; stroke-width:3; paint-order:stroke; font-size:10px; font-weight:700; }
  .path-inspector { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-2); color:var(--text-muted); font-size:var(--font-xs); }
  .path-inspector label { display:flex; align-items:center; gap:var(--space-2); color:var(--text); }
  .path-inspector input { width:min(12rem, 36vw); accent-color:var(--brand-gold); }
  .path-legend { display:inline-flex; align-items:center; gap:5px; }
  .path-legend i { width:.7rem; height:.25rem; border-radius:2px; display:inline-block; }
  .path-legend .normal { background:#ffd34e; }
  .path-legend .crossing { background:#da3340; margin-left:var(--space-2); }
  .path-warning { color:var(--red-strong); }
</style>
