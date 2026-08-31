<script>
  // 3D toolpath simulation for routing and turning jobs. Routing uses XYZ
  // directly; turning projects diameter-mode machine X/Z into axial/radial
  // scene coordinates and renders cylindrical stock plus an insert cursor.
  //
  // These are route-level imports: Vite keeps them out of unrelated app routes,
  // but loading them with the simulator avoids a second dynamic module request
  // that left the viewer's startup overlay hanging in local development.
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import { FastForward, Pause, Play, RotateCcw, SkipForward } from 'lucide-svelte';
  import { parseToolpath3D, projectTurningToolpath, toolpathBounds3D, toolpathPositionAtDistance, buildRoutingHeightmap } from '../toolpathPreview.js';

  export let gcode = '';
  export let operationType = 'routing';
  /** Cutter diameter in program units for single-tool jobs. */
  export let toolDiameter = null;
  /** Ordered routing tool sequence, when a job uses more than one cutter. */
  export let toolSequence = [];
  export let stockDiameter = null;
  export let noseRadius = null;

  let container;
  let renderer, scene, camera, controls, frameId, resizeObserver, grid, axes, toolMesh, stockMesh;
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
  let stockVisible = true;
  const lineObjects = {};
  let cutterDiameterInput = '';
  let initializedProgram = null;
  let playbackDistance = 0;
  let isPlaying = false;
  let playbackSpeed = 1;
  let lastPlaybackFrame = null;

  $: isTurning = operationType === 'turning';
  $: rawParsed = parseToolpath3D(gcode || '');
  $: parsed = isTurning ? projectTurningToolpath(rawParsed) : rawParsed;
  $: moves = parsed.moves;
  $: bounds = toolpathBounds3D(moves);
  $: toolPosition = toolpathPositionAtDistance(moves, playbackDistance);
  $: activeToolIndex = toolPosition?.moveIndex === undefined ? 0 : (moves[toolPosition.moveIndex]?.toolIndex || 0);
  $: activeSequenceDiameter = Number(toolSequence?.[activeToolIndex]?.toolDiameter) || null;
  $: singleToolDiameter = Number(toolDiameter) || null;
  $: cutterDiameter = activeSequenceDiameter || singleToolDiameter || Number(cutterDiameterInput) || null;
  $: canAnimate = isTurning || !!cutterDiameter;
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
  $: if (scene && toolPosition && cutterDiameter !== undefined && toolVisible !== undefined && isTurning !== undefined && noseRadius !== undefined) updateTool();
  $: if (scene && moves && toolPosition && stockVisible !== undefined && stockDiameter !== undefined && isTurning !== undefined) updateStock();

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

  function disposeStock() {
    if (!stockMesh || !scene) return;
    scene.remove(stockMesh);
    stockMesh.traverse((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
      else child.material?.dispose?.();
    });
    stockMesh = null;
  }

  function updateStock() {
    disposeStock();
    if (!scene || !moves.length) return;

    if (isTurning) {
      if (!(Number(stockDiameter) > 0)) return;
      const axialMin = Math.min(...moves.flatMap((move) => [move.from.x, move.to.x]));
      const axialMax = Math.max(...moves.flatMap((move) => [move.from.x, move.to.x]));
      const margin = Number(stockDiameter) * 0.08;
      const length = Math.max(axialMax - axialMin + margin * 2, Number(stockDiameter) * 0.5);
      const geometry = new THREE.CylinderGeometry(Number(stockDiameter) / 2, Number(stockDiameter) / 2, length, 48, 1, true);
      geometry.rotateZ(Math.PI / 2);
      const cylinder = new THREE.Mesh(
        geometry,
        new THREE.MeshPhongMaterial({ color: 0xb8bcc2, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false })
      );
      stockMesh = new THREE.Group();
      stockMesh.add(cylinder);
      // A uniform cylinder looks stationary while spinning. Four longitudinal
      // witness lines make spindle rotation visible without pretending they are
      // physical grooves in the stock.
      const markerPoints = [];
      const radius = Number(stockDiameter) / 2;
      for (let index = 0; index < 4; index += 1) {
        const angle = (index / 4) * Math.PI * 2;
        const y = Math.cos(angle) * radius * 1.002;
        const z = Math.sin(angle) * radius * 1.002;
        markerPoints.push(-length / 2, y, z, length / 2, y, z);
      }
      const markerGeometry = new THREE.BufferGeometry();
      markerGeometry.setAttribute('position', new THREE.Float32BufferAttribute(markerPoints, 3));
      stockMesh.add(new THREE.LineSegments(
        markerGeometry,
        new THREE.LineBasicMaterial({ color: 0x5f6670, transparent: true, opacity: 0.7 })
      ));
      stockMesh.position.x = (axialMin + axialMax) / 2;
      stockMesh.visible = stockVisible;
      scene.add(stockMesh);
      return;
    }

    updateRoutingStock();
  }

  // Real machined solid for routing (Phase 4 of
  // docs/toolpath-simulation-plan.md, deferred when the router sim first
  // shipped) - a heightmap-displaced plate, rebuilt every playback position
  // from buildRoutingHeightmap. See that function's own comment for why a
  // grid is exact for a 2.5D router cut, unlike turning's radius profile.
  const HEIGHTMAP_MAX_GRID = 160;
  const HEIGHTMAP_MARGIN_FACTOR = 0.06;

  function routingCutterRadius(move) {
    const seqDiameter = Number(toolSequence?.[move.toolIndex || 0]?.toolDiameter);
    const diameter = seqDiameter > 0 ? seqDiameter : (Number(toolDiameter) || Number(cutterDiameterInput) || 0);
    return diameter > 0 ? diameter / 2 : 0;
  }

  function updateRoutingStock() {
    const spanX = Math.max(bounds.max.x - bounds.min.x, 0.1);
    const spanY = Math.max(bounds.max.y - bounds.min.y, 0.1);
    const marginX = spanX * HEIGHTMAP_MARGIN_FACTOR;
    const marginY = spanY * HEIGHTMAP_MARGIN_FACTOR;
    const gridMinX = bounds.min.x - marginX;
    const gridMinY = bounds.min.y - marginY;
    const width = spanX + marginX * 2;
    const heightSpan = spanY + marginY * 2;

    const resolvedDiameters = [Number(toolDiameter), ...(toolSequence || []).map((t) => Number(t.toolDiameter))].filter((d) => d > 0);
    const minToolDiameter = resolvedDiameters.length ? Math.min(...resolvedDiameters) : 0.25;
    const targetCellSize = minToolDiameter / 6;
    const cellSize = Math.max(targetCellSize, width / HEIGHTMAP_MAX_GRID, heightSpan / HEIGHTMAP_MAX_GRID);
    const nx = Math.max(10, Math.ceil(width / cellSize) + 1);
    const ny = Math.max(10, Math.ceil(heightSpan / cellSize) + 1);

    // A bit below the deepest programmed cut - "safely into the spoilboard",
    // not a real stock-bottom measurement (routing jobs have no stock-
    // thickness param today), but honest enough to read as a solid plate
    // rather than a paper-thin sheet.
    const floorZ = Math.min(bounds.min.z - cellSize, -0.05);
    const moveIndex = toolPosition?.moveIndex ?? 0;
    const progress = toolPosition?.progress ?? 0;

    const heights = buildRoutingHeightmap(moves, {
      nx, ny, minX: gridMinX, minY: gridMinY, cellSize, topZ: 0, floorZ,
      cutterRadiusForMove: routingCutterRadius,
      uptoMoveIndex: moveIndex,
      partialProgress: progress
    });

    const geomWidth = (nx - 1) * cellSize;
    const geomHeight = (ny - 1) * cellSize;
    const geometry = new THREE.PlaneGeometry(geomWidth, geomHeight, nx - 1, ny - 1);
    const centerX = gridMinX + cellSize / 2 + geomWidth / 2;
    const centerY = gridMinY + cellSize / 2 + geomHeight / 2;
    geometry.translate(centerX, centerY, 0);

    // Look up each vertex's own (x,y) rather than assuming PlaneGeometry's
    // internal iteration order matches the heightmap's (ix,iy) indexing -
    // correct regardless of that internal convention, at negligible cost.
    const posAttr = geometry.attributes.position;
    for (let i = 0; i < posAttr.count; i += 1) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);
      const ix = Math.max(0, Math.min(nx - 1, Math.round((vx - gridMinX) / cellSize - 0.5)));
      const iy = Math.max(0, Math.min(ny - 1, Math.round((vy - gridMinY) / cellSize - 0.5)));
      posAttr.setZ(i, heights[iy * nx + ix]);
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();

    const solid = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({ color: 0xb8bcc2, side: THREE.DoubleSide })
    );
    stockMesh = new THREE.Group();
    stockMesh.add(solid);
    stockMesh.visible = stockVisible;
    scene.add(stockMesh);
  }

  function updateTool() {
    if (!scene) return;
    if ((!cutterDiameter && !isTurning) || !toolPosition) {
      disposeTool();
      return;
    }

    if (isTurning) {
      const insertSize = Math.max(Number(noseRadius) * 8 || Number(stockDiameter) * 0.08 || 0.08, 0.04);
      if (!toolMesh || toolMesh.userData.kind !== 'turning' || toolMesh.userData.size !== insertSize) {
        disposeTool();
        toolMesh = new THREE.Mesh(
          new THREE.ConeGeometry(insertSize, insertSize * 1.5, 4),
          new THREE.MeshPhongMaterial({ color: 0x252525, emissive: 0x080808 })
        );
        toolMesh.rotation.x = Math.PI / 2;
        toolMesh.rotation.z = Math.PI / 4;
        toolMesh.userData.kind = 'turning';
        toolMesh.userData.size = insertSize;
        scene.add(toolMesh);
      }
      toolMesh.position.set(toolPosition.position.x, toolPosition.position.y + insertSize * 0.75, toolPosition.position.z);
      toolMesh.visible = toolVisible;
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
    if (!moves.length || !canAnimate) return;
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
        scene.add(new THREE.AmbientLight(0xffffff, 1.5));
        const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
        keyLight.position.set(3, -4, 5);
        scene.add(keyLight);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;

        rebuildToolpath();
        updateStock();

        const animate = (timestamp) => {
          if (disposed) return;
          frameId = requestAnimationFrame(animate);
          if (isPlaying && canAnimate && lastPlaybackFrame !== null) {
            // This is deliberately distance, not an invented machining-time
            // estimate. The multiplier only controls how quickly to inspect.
            playbackDistance = Math.min(parsed.totalDistance, playbackDistance + ((timestamp - lastPlaybackFrame) / 1000) * playbackSpeed);
            if (playbackDistance >= parsed.totalDistance) isPlaying = false;
          }
          if (isTurning && stockMesh && isPlaying && lastPlaybackFrame !== null) {
            // The workpiece rotates in a lathe; the insert translates through
            // X/Z. Animate the honest machine motion, not a spinning insert.
            stockMesh.rotation.x += ((timestamp - lastPlaybackFrame) / 1000) * Math.PI * 2;
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
      disposeStock();
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
        <button class="btn btn-ghost btn-icon" type="button" title={isPlaying ? 'Pause simulation' : 'Play simulation'} aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'} on:click={togglePlayback} disabled={loading || !!error || !moves.length || !canAnimate}>
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
        <input type="range" min="0.25" max="4" step="0.25" bind:value={playbackSpeed} disabled={!moves.length} />
        <output>{speedLabel(playbackSpeed)}</output>
      </label>
    </div>

    <div class="legend">
    <label class="legend-item">
      <input type="checkbox" bind:checked={toolpathVisible} />
      <span class="legend-label">Toolpath</span>
    </label>
    <label class="legend-item" class:empty={!isTurning && !cutterDiameter}>
      <input type="checkbox" bind:checked={toolVisible} disabled={!isTurning && !cutterDiameter} />
      <span class="legend-label">{isTurning ? 'Insert' : 'Tool'}</span>
    </label>
    {#if isTurning}
      <label class="legend-item" class:empty={!(Number(stockDiameter) > 0)}>
        <input type="checkbox" bind:checked={stockVisible} disabled={!(Number(stockDiameter) > 0)} />
        <span class="legend-label">Rotating stock</span>
      </label>
    {:else}
      <label class="legend-item" class:empty={!moves.length}>
        <input type="checkbox" bind:checked={stockVisible} disabled={!moves.length} />
        <span class="legend-label">Stock</span>
      </label>
    {/if}
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

  {#if !isTurning && !singleToolDiameter && !activeSequenceDiameter}
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
