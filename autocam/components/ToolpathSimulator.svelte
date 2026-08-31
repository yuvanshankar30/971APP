<script>
  // 3D toolpath simulation for ROUTING jobs - see
  // docs/toolpath-simulation-plan.md for why turning is excluded and why
  // material removal (a later phase) uses a heightmap.
  //
  // These are route-level imports: Vite keeps them out of unrelated app routes,
  // but loading them with the simulator avoids a second dynamic module request
  // that left the viewer's startup overlay hanging in local development.
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import { FastForward, Pause, Play, RotateCcw, SkipForward } from 'lucide-svelte';
  import { parseToolpath3D, toolpathBounds3D, toolpathPositionAtDistance } from '../toolpathPreview.js';

  export let gcode = '';
  /** Cutter diameter in program units for single-tool jobs. */
  export let toolDiameter = null;
  /** Ordered routing tool sequence, when a job uses more than one cutter. */
  export let toolSequence = [];

  let container;
  let renderer, scene, camera, controls, frameId, resizeObserver, grid, axes, toolMesh;
  let disposed = false;
  let loading = true;
  let error = '';

  // Fusion colours a move by what it is, and CAM users read that scheme
  // fluently: yellow rapid, blue cutting, red ramp/plunge. Deliberately not
  // theme tokens - these carry domain meaning, not brand identity, and
  // recolouring them would make the view harder to read for anyone who has
  // used a CAM package.
  const MOVE_STYLES = {
    rapid: { color: 0xd8b400, label: 'Rapid', opacity: 0.55 },
    cut: { color: 0x2f6fd0, label: 'Cutting', opacity: 1 },
    ramp: { color: 0xd0342c, label: 'Ramp / plunge', opacity: 1 }
  };
  const KINDS = ['rapid', 'cut', 'ramp'];

  let visible = { rapid: true, cut: true, ramp: true };
  let toolpathVisible = true;
  let toolVisible = true;
  const lineObjects = {};
  let cutterDiameterInput = '';
  let initializedProgram = null;
  let playbackDistance = 0;
  let isPlaying = false;
  let playbackSpeed = 1;
  let lastPlaybackFrame = null;

  $: parsed = parseToolpath3D(gcode || '');
  $: moves = parsed.moves;
  $: bounds = toolpathBounds3D(moves);
  $: toolPosition = toolpathPositionAtDistance(moves, playbackDistance);
  $: activeToolIndex = toolPosition?.moveIndex === undefined ? 0 : (moves[toolPosition.moveIndex]?.toolIndex || 0);
  $: activeSequenceDiameter = Number(toolSequence?.[activeToolIndex]?.toolDiameter) || null;
  $: singleToolDiameter = Number(toolDiameter) || null;
  $: cutterDiameter = activeSequenceDiameter || singleToolDiameter || Number(cutterDiameterInput) || null;
  $: speedProgress = Math.max(0, Math.min(100, ((Number(playbackSpeed) - 0.25) / 3.75) * 100));
  $: moveCounts = KINDS.reduce((counts, kind) => {
    counts[kind] = moves.filter((move) => move.kind === kind).length;
    return counts;
  }, {});

  // A job may be edited while this modal stays open. Adopt its saved diameter
  // once, but preserve a deliberate manual value for old jobs that lack one.
  $: if (gcode !== initializedProgram) {
    initializedProgram = gcode;
    playbackDistance = 0;
    isPlaying = false;
    cutterDiameterInput = singleToolDiameter ? String(singleToolDiameter) : '';
  }

  // Rebuild whenever the program changes, but only once the scene exists.
  $: if (scene && moves) rebuildToolpath();
  $: if (scene && toolpathVisible !== undefined) applyVisibility(visible);
  $: if (scene && toolPosition && cutterDiameter !== undefined && toolVisible !== undefined) updateTool();

  function applyVisibility(state) {
    for (const kind of KINDS) {
      if (lineObjects[kind]) lineObjects[kind].visible = toolpathVisible && !!state[kind];
    }
  }

  function disposeToolpath() {
    for (const kind of KINDS) {
      const object = lineObjects[kind];
      if (!object) continue;
      scene.remove(object);
      object.geometry?.dispose?.();
      object.material?.dispose?.();
      lineObjects[kind] = null;
    }
  }

  function rebuildToolpath() {
    if (!scene) return;
    disposeToolpath();

    // One flat Float32Array per move class rather than an object per segment -
    // a real program is thousands of moves and this runs on every reparse.
    const buffers = {};
    for (const kind of KINDS) buffers[kind] = [];
    for (const move of moves) {
      const target = buffers[move.kind] || buffers.cut;
      target.push(move.from.x, move.from.y, move.from.z, move.to.x, move.to.y, move.to.z);
    }

    for (const kind of KINDS) {
      const points = buffers[kind];
      if (!points.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
      const style = MOVE_STYLES[kind];
      const material = new THREE.LineBasicMaterial({
        color: style.color,
        transparent: style.opacity < 1,
        opacity: style.opacity
      });
      const object = new THREE.LineSegments(geometry, material);
      object.visible = !!visible[kind];
      lineObjects[kind] = object;
      scene.add(object);
    }
    sizeReferenceGeometry();
    frameCamera();
  }

  function disposeTool() {
    if (!toolMesh || !scene) return;
    scene.remove(toolMesh);
    toolMesh.geometry?.dispose?.();
    toolMesh.material?.dispose?.();
    toolMesh = null;
  }

  function updateTool() {
    if (!scene) return;
    if (!cutterDiameter || !toolPosition) {
      disposeTool();
      return;
    }

    const visualHeight = Math.max(cutterDiameter * 3, 0.5);
    if (!toolMesh || toolMesh.userData.diameter !== cutterDiameter) {
      disposeTool();
      toolMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(cutterDiameter / 2, cutterDiameter / 2, visualHeight, 20),
        new THREE.MeshBasicMaterial({ color: 0x202020 })
      );
      // Three cylinders are Y-up; the machine program and scene are Z-up.
      toolMesh.rotation.x = Math.PI / 2;
      toolMesh.userData.diameter = cutterDiameter;
      scene.add(toolMesh);
    }
    toolMesh.position.set(toolPosition.position.x, toolPosition.position.y, toolPosition.position.z + visualHeight / 2);
    toolMesh.visible = toolVisible;
  }

  function seek(distance) {
    playbackDistance = Math.max(0, Math.min(Number(distance) || 0, parsed.totalDistance));
    isPlaying = false;
  }

  function togglePlayback() {
    if (!moves.length || !cutterDiameter) return;
    if (playbackDistance >= parsed.totalDistance) playbackDistance = 0;
    isPlaying = !isPlaying;
  }

  function nextMove() {
    if (!moves.length) return;
    const current = toolPosition?.moveIndex ?? 0;
    const currentEnd = moves[current].startDistance + moves[current].length;
    const next = moves[Math.min(playbackDistance >= currentEnd - 1e-9 ? current + 1 : current, moves.length - 1)];
    seek(next.startDistance + next.length);
  }

  function nextOperation() {
    const nextIndex = parsed.toolChangeIndices.find((index) => index > (toolPosition?.moveIndex ?? -1));
    if (nextIndex === undefined) {
      seek(parsed.totalDistance);
      return;
    }
    const operationStart = moves[nextIndex]?.startDistance;
    seek(operationStart === undefined ? parsed.totalDistance : Math.min(operationStart + 1e-9, parsed.totalDistance));
  }

  function goToEnd() {
    seek(parsed.totalDistance);
  }

  function speedLabel(speed) {
    const value = Number(speed) || 0;
    return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}x`;
  }

  function frameCamera() {
    if (!camera || !controls) return;
    const { min, max } = bounds;
    const center = {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2
    };
    const span = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1);
    controls.target.set(center.x, center.y, center.z);
    camera.position.set(center.x + span * 1.1, center.y - span * 1.3, center.z + span * 1.1);
    camera.near = span / 500;
    camera.far = span * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  export function resetView() {
    frameCamera();
  }

  onMount(() => {
    let cancelled = false;
    (async () => {
      try {
        if (cancelled || disposed) return;

        const width = container.clientWidth || 600;
        const height = container.clientHeight || 400;
        const isDark = typeof document !== 'undefined'
          && document.documentElement.getAttribute('data-theme') === 'modern-dark';

        scene = new THREE.Scene();
        scene.background = new THREE.Color(isDark ? 0x131109 : 0xf3f4f6);

        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
        // G-code is Z-up: Z is depth, negative into the material. Telling
        // three.js that directly is far less error-prone than transforming
        // every coordinate into its Y-up default and then reasoning in two
        // frames at once.
        camera.up.set(0, 0, 1);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        // Grid sits on the stock's top surface (Z0), which is where a router
        // touches off, so it reads as the material rather than a floor.
        grid = new THREE.GridHelper(1, 1);
        grid.rotation.x = Math.PI / 2;
        scene.add(grid);
        axes = new THREE.AxesHelper(1);
        scene.add(axes);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;

        rebuildToolpath();

        const animate = (timestamp) => {
          if (disposed) return;
          frameId = requestAnimationFrame(animate);
          if (isPlaying && cutterDiameter && lastPlaybackFrame !== null) {
            // This is deliberately distance, not an invented machining-time
            // estimate. The multiplier only controls how quickly to inspect.
            playbackDistance = Math.min(parsed.totalDistance, playbackDistance + ((timestamp - lastPlaybackFrame) / 1000) * playbackSpeed);
            if (playbackDistance >= parsed.totalDistance) isPlaying = false;
          }
          lastPlaybackFrame = timestamp;
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        resizeObserver = new ResizeObserver(() => {
          if (!renderer || !camera || !container) return;
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w === 0 || h === 0) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        });
        resizeObserver.observe(container);

        loading = false;
      } catch (e) {
        console.error('Toolpath simulator error:', e);
        error = e?.message || 'Could not start the 3D simulation.';
        loading = false;
      }
    })();

    return () => { cancelled = true; };
  });

  function sizeReferenceGeometry() {
    if (!grid || !axes) return;
    const { min, max } = bounds;
    const span = Math.max(max.x - min.x, max.y - min.y, 1);
    grid.scale.setScalar(span * 1.5);
    grid.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, 0);
    axes.scale.setScalar(Math.max(span * 0.12, 0.25));
    axes.position.set(min.x, min.y, 0);
  }

  onDestroy(() => {
    disposed = true;
    if (frameId) cancelAnimationFrame(frameId);
    resizeObserver?.disconnect();
    if (scene) {
      disposeToolpath();
      disposeTool();
    }
    controls?.dispose?.();
    renderer?.dispose?.();
    if (renderer?.domElement?.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  });
</script>

<div class="simulator">
  <div class="viewport" bind:this={container}>
    {#if loading}
      <div class="overlay"><div class="spinner"></div><span>Starting simulation...</span></div>
    {:else if error}
      <div class="overlay overlay-error"><span>⚠️ {error}</span></div>
    {:else if !moves.length}
      <div class="overlay"><span>No toolpath moves could be read from this program.</span></div>
    {/if}
  </div>

  <div class="simulator-controls" aria-label="Toolpath simulation controls">
    <div class="playback-controls">
      <div class="transport-buttons">
        <button class="btn btn-ghost btn-icon" type="button" title={isPlaying ? 'Pause simulation' : 'Play simulation'} aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'} on:click={togglePlayback} disabled={loading || !!error || !moves.length || !cutterDiameter}>
          {#if isPlaying}<Pause size={17} />{:else}<Play size={17} />{/if}
        </button>
        <button class="btn btn-ghost btn-icon" type="button" title="Next move" aria-label="Next move" on:click={nextMove} disabled={loading || !moves.length}><SkipForward size={17} /></button>
        <button class="btn btn-ghost btn-icon" type="button" title="Next operation" aria-label="Next operation" on:click={nextOperation} disabled={loading || !moves.length}><span class="operation-icon">T</span><SkipForward size={13} /></button>
        <button class="btn btn-ghost btn-icon" type="button" title="Go to end of toolpath" aria-label="Go to end of toolpath" on:click={goToEnd} disabled={loading || !moves.length}><FastForward size={17} /></button>
      </div>
      <label class="scrub-control">
        <span>Route position</span>
        <input type="range" min="0" max={parsed.totalDistance || 0} step="any" value={playbackDistance} on:input={(event) => seek(event.currentTarget.value)} disabled={!moves.length} />
        <output>{playbackDistance.toFixed(2)} / {parsed.totalDistance.toFixed(2)} in</output>
      </label>
      <label class="speed-control">
        <span>Simulation speed</span>
        <input class="speed-slider" type="range" min="0.25" max="4" step="0.25" value={playbackSpeed} style={`--speed-progress: ${speedProgress}%`} on:input={(event) => (playbackSpeed = Number(event.currentTarget.value))} disabled={!moves.length} />
        <output>{speedLabel(playbackSpeed)}</output>
      </label>
    </div>

    <div class="legend">
    <label class="legend-item">
      <input type="checkbox" bind:checked={toolpathVisible} />
      <span class="legend-label">Toolpath</span>
    </label>
    <label class="legend-item" class:empty={!cutterDiameter}>
      <input type="checkbox" bind:checked={toolVisible} disabled={!cutterDiameter} />
      <span class="legend-label">Tool</span>
    </label>
    {#each KINDS as kind}
      <label class="legend-item" class:empty={!moveCounts[kind]}>
        <input type="checkbox" bind:checked={visible[kind]} disabled={!moveCounts[kind]} />
        <span class="swatch" style={`background:#${MOVE_STYLES[kind].color.toString(16).padStart(6, '0')}`}></span>
        <span class="legend-label">{MOVE_STYLES[kind].label}</span>
        <span class="legend-count">{moveCounts[kind]}</span>
      </label>
    {/each}
      <button class="btn btn-ghost btn-icon" type="button" title="Reset camera view" aria-label="Reset camera view" on:click={resetView} disabled={loading || !!error}><RotateCcw size={17} /></button>
    </div>
  </div>

  {#if !singleToolDiameter && !activeSequenceDiameter}
    <label class="tool-diameter-input">
      <span>End mill diameter (in)</span>
      <input type="number" min="0.001" step="0.001" bind:value={cutterDiameterInput} placeholder="e.g. 0.25" />
    </label>
  {/if}
</div>

<style>
  .simulator { display: grid; gap: var(--space-2); }
  .viewport {
    position: relative;
    width: 100%;
    height: 60vh;
    min-height: 320px;
    border-radius: var(--radius-sm, 4px);
    overflow: hidden;
    background: var(--surface-2, #f3f4f6);
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    color: var(--text-muted, #6b7280);
    font-size: 0.9rem;
    text-align: center;
    padding: 1rem;
  }
  .overlay-error { color: var(--red-strong, #991b1b); }
  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border, #d1d5db);
    border-top-color: var(--accent, #f1c331);
    border-radius: 50%;
    animation: sim-spin 0.8s linear infinite;
  }
  @keyframes sim-spin { to { transform: rotate(360deg); } }

  .simulator-controls { display: flex; align-items: center; gap: var(--gap-3); overflow-x: auto; padding-bottom: 0.15rem; }
  .playback-controls { display: flex; align-items: center; flex: 1 0 48rem; gap: var(--gap-3); }
  .transport-buttons { display: flex; gap: 0.25rem; }
  .btn-icon { display: inline-flex; align-items: center; justify-content: center; min-width: 2.25rem; min-height: 2.25rem; padding: 0.35rem; }
  .operation-icon { font-size: 0.7rem; font-weight: 700; line-height: 1; }
  .scrub-control { display: grid; grid-template-columns: auto minmax(9rem, 1fr) auto; align-items: center; flex: 1 1 24rem; gap: 0.55rem; font-size: 0.82rem; color: var(--text-muted); }
  .scrub-control input { min-width: 0; width: 100%; }
  .scrub-control output { min-width: 7.7rem; color: var(--text); font-variant-numeric: tabular-nums; }
  .speed-control { display: grid; grid-template-columns: auto minmax(7rem, 1fr) auto; align-items: center; flex: 0 1 18rem; gap: 0.55rem; font-size: 0.82rem; color: var(--text-muted); }
  .speed-control input { min-width: 7rem; width: 100%; }
  .speed-control .speed-slider {
    appearance: none;
    -webkit-appearance: none;
    height: 1.2rem;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
  }
  .speed-control .speed-slider::-webkit-slider-runnable-track {
    height: 0.45rem;
    border: 1px solid var(--border, #a8a8a8);
    border-radius: 999px;
    background: linear-gradient(to right, var(--blue, #1677f0) 0 var(--speed-progress), var(--surface-2, #e5e7eb) var(--speed-progress) 100%);
  }
  .speed-control .speed-slider::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 1.15rem;
    height: 1.15rem;
    margin-top: -0.43rem;
    border: 0;
    border-radius: 50%;
    background: var(--blue, #1677f0);
  }
  .speed-control .speed-slider::-moz-range-track {
    height: 0.45rem;
    border: 1px solid var(--border, #a8a8a8);
    border-radius: 999px;
    background: var(--surface-2, #e5e7eb);
  }
  .speed-control .speed-slider::-moz-range-progress {
    height: 0.45rem;
    border-radius: 999px;
    background: var(--blue, #1677f0);
  }
  .speed-control .speed-slider::-moz-range-thumb {
    width: 1.15rem;
    height: 1.15rem;
    border: 0;
    border-radius: 50%;
    background: var(--blue, #1677f0);
  }
  .speed-control output { min-width: 2.75rem; color: var(--text); font-variant-numeric: tabular-nums; }
  .tool-diameter-input { display: grid; gap: 0.3rem; font-size: 0.82rem; color: var(--text-muted); }
  .tool-diameter-input input { min-height: 2.25rem; color: var(--text); background: var(--surface, #fff); border: 1px solid var(--border, #d1d5db); border-radius: var(--radius-sm, 4px); padding: 0.25rem 0.45rem; }
  .tool-diameter-input input { width: 11rem; }
  .legend { display: flex; flex: 0 0 auto; align-items: center; gap: var(--gap-3); white-space: nowrap; }
  .legend-item { display: flex; align-items: center; gap: var(--gap-2); font-size: 0.82rem; cursor: pointer; }
  .legend-item.empty { opacity: 0.45; cursor: default; }
  .swatch { width: 0.85rem; height: 0.85rem; border-radius: 2px; }
  .legend-label { color: var(--text); }
  .legend-count { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .legend button { margin-left: auto; }
  @media (max-width: 560px) {
    .viewport { height: 45vh; }
    .simulator-controls { align-items: flex-start; }
    .playback-controls { flex-basis: 44rem; }
    .scrub-control { grid-template-columns: 1fr auto; }
    .scrub-control span { grid-column: 1 / -1; }
    .legend button { margin-left: 0; }
  }
</style>
