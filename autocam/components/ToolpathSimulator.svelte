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
  import {
    parseToolpath3D,
    projectTurningToolpath,
    toolpathBounds3D,
    toolpathPositionAtDistance,
    buildTurningStockProfile,
    turningProfileToLathePoints,
    buildTurningStockRings,
    buildRoutingHeightmap,
    inferRoutingEdgeShift,
    estimateMachiningTime,
    formatMachiningTime,
    smoothRoutingHeightmap,
    findRoutingHeightmapWalls,
    projectTubestockToolpath,
    matchTubestockHolesToMoves,
    tubeLocalPoint,
    tubeWallNormal
  } from '../toolpathPreview.js';
  import { stockEnvelopeRadius } from '../turning.js';
  import {
    extractTurningProfileFromMeshes,
    extractRoutingContoursFromMeshes,
    transformMeshesForTurningScene,
    transformMeshesForRoutingScene
  } from '../stepProfile.js';
  import { fetchStepMeshes } from '$lib/stepMeshLoader.js';

  export let gcode = '';
  export let operationType = 'routing';
  /** Cutter diameter in program units for single-tool jobs. */
  export let toolDiameter = null;
  /**
   * Machine rapid traverse in in/min, used to time G00 moves for the run-time
   * estimate. Defaults to a real figure for a mid-size CNC router; pass the
   * machine's own number where it is known, since a lathe or a fast gantry
   * differs and rapids are a large share of a hole-heavy program.
   */
  export let rapidRate = 200;
  /** Ordered routing tool sequence, when a job uses more than one cutter. */
  export let toolSequence = [];
  export let stockDiameter = null;
  /** 'round' | 'hex' - see stockEnvelopeRadius in turning.js. */
  export let stockShape = 'round';
  export let noseRadius = null;
  /** Drill diameter, if this job has a drilling operation - see turning.js's `drilling` param. */
  export let drillDiameter = null;
  /**
   * Storage path of the job's source STEP file - Phase 5's "show the source
   * part" ghost overlay + gouge detection (docs/toolpath-simulation-plan.md).
   * Optional: without it, the sim works exactly as before, just without the
   * Model toggle.
   */
  export let stepFileName = null;
  /**
   * Routing only: generateRoutingGcode's own edge-margin shift
   * (routing.js's stats.edgeShiftX/edgeShiftY) - the actual toolpath and
   * stock are rendered in that shifted frame, but the ghost part is
   * rebuilt fresh from the source STEP file's raw (unshifted) coordinates,
   * so it has to be shifted by the same amount to land in the same place.
   */
  export let edgeShiftX = 0;
  export let edgeShiftY = 0;
  /**
   * Tube stock only: generateTubestockGcode's own stats.crossSection/walls
   * (echoed straight from extractTubeFeaturesFromMeshes) - the tube's outer
   * width along its two cross-section axes, and every wall's hole layout.
   * Needed to place the G-code's X/Y/Z/A moves onto the tube's actual 3D
   * surface (see projectTubestockToolpath) and to render the drilled holes
   * themselves, which the moves alone don't carry (diameter isn't a
   * coordinate).
   */
  export let crossSection = null;
  export let walls = [];

  let container;
  let renderer, scene, camera, controls, frameId, resizeObserver, grid, axes, toolMesh, stockMesh, ghostMesh;
  let disposed = false;
  let loading = true;
  let error = '';

  // Ghost part (Phase 5) - loaded independently of the main scene/toolpath
  // lifecycle, since fetching + parsing a STEP file is slow and shouldn't
  // block (or be blocked by) the toolpath view rendering.
  let modelVisible = true;
  let ghostLoading = false;
  let ghostError = '';
  let ghostGeometryData = null; // [{position, index}, ...] in scene coordinates, or null
  let turningTargetProfile = null; // {z,x}[] from extractTurningProfileFromMeshes - turning gouge check
  let routingTargetThickness = null; // number from extractRoutingContoursFromMeshes - routing gouge check
  let initializedStepFile = null;

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

  // Real material, not flat plastic: MeshPhongMaterial has no physical
  // basis for metalness/roughness, so no amount of light tuning makes it
  // read as machined aluminum - MeshStandardMaterial (PBR) does, matching
  // how Fusion 360's own renderer assigns real metal/plastic appearances
  // rather than a flat Phong shade. A factory (not a shared instance)
  // since each stock mesh disposes its own material independently.
  function createStockMaterial(color = 0xb8bcc2) {
    return new THREE.MeshStandardMaterial({
      color,
      // Lower metalness/higher roughness than a mirror-polish part - with
      // no environment map, a highly metallic, low-roughness surface under
      // a single strong directional key light reads as an overblown hard
      // specular hotspot rather than machined aluminum's actual soft sheen.
      metalness: 0.6,
      roughness: 0.55,
      side: THREE.DoubleSide
    });
  }

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
  $: isTubestock = operationType === 'tubestock';
  $: rawParsed = parseToolpath3D(gcode || '');
  $: parsed = isTurning
    ? projectTurningToolpath(rawParsed)
    : (isTubestock && crossSection ? projectTubestockToolpath(rawParsed, { crossSection }) : rawParsed);
  $: moves = parsed.moves;
  $: bounds = toolpathBounds3D(moves);

  // How long this program actually takes on the machine. Excludes M00 tool
  // change / setup pauses, which wait on a person - those are reported
  // separately rather than given an invented duration.
  $: machiningTime = estimateMachiningTime(moves, {
    rapidRate,
    dwellSeconds: rawParsed.dwellSeconds,
    pauseCount: rawParsed.pauseCount
  });
  $: machiningTimeTitle = [
    `Cutting ${formatMachiningTime(machiningTime.cuttingSeconds)}`,
    `rapids ${formatMachiningTime(machiningTime.rapidSeconds)} at ${rapidRate} in/min`,
    machiningTime.dwellSeconds > 0 ? `dwells ${formatMachiningTime(machiningTime.dwellSeconds)}` : null,
    machiningTime.pauseCount > 0
      ? `plus ${machiningTime.pauseCount} tool-change/setup pause${machiningTime.pauseCount === 1 ? '' : 's'} that wait on the operator (not counted)`
      : null,
    machiningTime.unknownFeedMoves > 0
      ? `${machiningTime.unknownFeedMoves} move(s) had no feed rate and could not be timed`
      : null
  ].filter(Boolean).join(' - ');
  $: toolPosition = toolpathPositionAtDistance(moves, playbackDistance);
  $: activeToolIndex = toolPosition?.moveIndex === undefined ? 0 : (moves[toolPosition.moveIndex]?.toolIndex || 0);
  $: activeSequenceDiameter = Number(toolSequence?.[activeToolIndex]?.toolDiameter) || null;
  $: singleToolDiameter = Number(toolDiameter) || null;
  $: cutterDiameter = activeSequenceDiameter || singleToolDiameter || Number(cutterDiameterInput) || null;
  $: speedProgress = Math.max(0, Math.min(100, ((Number(playbackSpeed) - 0.25) / 9.75) * 100));
  $: canAnimate = isTurning || isTubestock || !!cutterDiameter;
  $: moveCounts = KINDS.reduce((counts, kind) => {
    counts[kind] = moves.filter((move) => move.kind === kind).length;
    return counts;
  }, {});
  // Tube stock: joins each real hole (walls, from generateTubestockGcode's
  // own stats) to the raw (pre-projection) move that drills it, so playback
  // can progressively reveal holes the same way routing/turning reveal
  // material removal - see matchTubestockHolesToMoves' own doc comment.
  // Recomputed only when the program or hole list actually changes, not on
  // every scrub tick.
  $: drilledHoleIndex = isTubestock && walls?.length ? matchTubestockHolesToMoves(walls, rawParsed.moves) : [];

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
  $: if (scene && toolPosition && cutterDiameter !== undefined && toolVisible !== undefined && isTurning !== undefined && isTubestock !== undefined && noseRadius !== undefined) updateTool();
  $: if (scene && moves && toolPosition && stockVisible !== undefined && stockDiameter !== undefined && isTurning !== undefined && isTubestock !== undefined && drilledHoleIndex !== undefined) updateStock();

  // Ghost part (Phase 5): fetch + parse doesn't need the scene, so it's
  // decoupled from scene readiness - only actually adding the mesh does.
  $: if (stepFileName !== initializedStepFile) {
    initializedStepFile = stepFileName;
    loadGhostPart();
  }
  $: if (scene && modelVisible !== undefined && ghostGeometryData !== undefined) updateGhostMesh();

  // Gouge check: has the sim's cut state, at the current playback position,
  // removed material the source part actually needed? An independent
  // ground truth (the STEP file, not the G-code replaying itself) is the
  // whole reason this needs the ghost part loaded first - comparing the
  // program's own output against itself would be tautological.
  // Math.min(...array) passes every element as a separate function argument,
  // which blows the call stack once the array is large. The routing heightmap
  // is nx*ny cells - 230k of them at the current grid resolution - so
  // spreading it threw RangeError and took the gouge check (a safety
  // readout, not a cosmetic one) down with it. Same hazard for a long
  // toolpath's coordinate list.
  function minOf(values) {
    let min = Infinity;
    for (const value of values) if (value < min) min = value;
    return min;
  }

  const GOUGE_TOLERANCE = 0.01;
  $: turningGouge = isTurning && turningTargetProfile && stockOuterProfile
    ? detectTurningGouge(stockOuterProfile, turningTargetProfile)
    : false;
  $: routingGouge = !isTurning && routingTargetThickness != null && routingHeights
    ? minOf(routingHeights) < -routingTargetThickness - GOUGE_TOLERANCE
    : false;
  $: gougeDetected = turningGouge || routingGouge;

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

  // A cutting move that hasn't removed material yet sits exactly on the
  // stock's current surface (routing's Z=0 top face, or the not-yet-cut
  // radius of a turned solid) - a line and a mesh face at the identical
  // depth z-fight, flickering and reading as the toolpath "merging into"
  // the part. Lifting the line a hair off that surface (imperceptible at
  // real part scale) keeps it a clean, separate visual layer instead.
  const TOOLPATH_Z_LIFT = 0.01;

  function rebuildToolpath() {
    if (!scene) return;
    disposeToolpath();

    // One flat Float32Array per move class rather than an object per segment -
    // a real program is thousands of moves and this runs on every reparse.
    const buffers = {};
    for (const kind of KINDS) buffers[kind] = [];
    for (const move of moves) {
      const target = buffers[move.kind] || buffers.cut;
      target.push(
        move.from.x, move.from.y, move.from.z + TOOLPATH_Z_LIFT,
        move.to.x, move.to.y, move.to.z + TOOLPATH_Z_LIFT
      );
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

  function disposeGhost() {
    if (!ghostMesh || !scene) return;
    scene.remove(ghostMesh);
    ghostMesh.traverse((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
      else child.material?.dispose?.();
    });
    ghostMesh = null;
  }

  // Phase 5: load and show the source STEP part semi-transparently, so a
  // gouge or a missed feature is visible against what the toolpath actually
  // produced - see docs/toolpath-simulation-plan.md. Fetch + parse doesn't
  // touch the scene, so this can run before the scene exists (or while the
  // job is still being edited) without racing updateStock()/rebuildToolpath().
  /** Bounding box of raw ghost geometry, in the same shape toolpathBounds3D returns. */
  function boundsOfGeometryData(geometryData) {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const { position } of geometryData || []) {
      for (let i = 0; i < position.length; i += 3) {
        for (const [axis, value] of [['x', position[i]], ['y', position[i + 1]], ['z', position[i + 2]]]) {
          if (value < min[axis]) min[axis] = value;
          if (value > max[axis]) max[axis] = value;
        }
      }
    }
    return Number.isFinite(min.x) ? { min, max } : null;
  }

  async function loadGhostPart() {
    ghostGeometryData = null;
    turningTargetProfile = null;
    routingTargetThickness = null;
    ghostError = '';
    // Tube stock has no ghost-part/gouge-check support yet - its geometry
    // (rectangular tube, indexed round holes) isn't something
    // extractTurningProfileFromMeshes/extractRoutingContoursFromMeshes can
    // read, and the sim is fully usable without it (the drilled-hole
    // rendering already shows real, measured hole positions).
    if (!stepFileName || isTubestock) return;

    ghostLoading = true;
    try {
      const meshes = await fetchStepMeshes(stepFileName);
      if (disposed) return;
      if (isTurning) {
        turningTargetProfile = extractTurningProfileFromMeshes(meshes);
        ghostGeometryData = transformMeshesForTurningScene(meshes);
      } else {
        const { thickness, frame } = extractRoutingContoursFromMeshes(meshes);
        routingTargetThickness = thickness;
        ghostGeometryData = transformMeshesForRoutingScene(meshes, frame);
        // transformMeshesForRoutingScene reproduces the RAW (pre-edge-margin)
        // u/v coordinates - generateRoutingGcode shifted the actual toolpath
        // by edgeShiftX/edgeShiftY to keep it clear of X0/Y0, so the ghost
        // part needs the identical shift to land in the same place.
        //
        // Jobs generated before those values were recorded in stats have no
        // shift to hand us, and skipping it left the ghost rendering as a
        // translucent slab floating off to one side of the stock. Recover it
        // from the toolpath's own geometry in that case - see
        // inferRoutingEdgeShift.
        let shiftX = edgeShiftX;
        let shiftY = edgeShiftY;
        if (!shiftX && !shiftY) {
          const rawBounds = boundsOfGeometryData(ghostGeometryData);
          ({ x: shiftX, y: shiftY } = inferRoutingEdgeShift(parsed.moves, rawBounds));
        }
        if (shiftX || shiftY) {
          for (const { position } of ghostGeometryData) {
            for (let i = 0; i < position.length; i += 3) {
              position[i] += shiftX;
              position[i + 1] += shiftY;
            }
          }
        }
      }
    } catch (e) {
      // Non-fatal: the toolpath sim is fully usable without the ghost part -
      // an older job whose STEP file was replaced/removed, or a part this
      // extractor genuinely can't read, shouldn't break the rest of the view.
      console.warn('Ghost part overlay unavailable:', e?.message || e);
      ghostError = e?.message || 'Could not load the source part for comparison.';
    } finally {
      ghostLoading = false;
    }
  }

  function updateGhostMesh() {
    disposeGhost();
    if (!scene || !ghostGeometryData || !modelVisible) return;

    ghostMesh = new THREE.Group();
    const material = new THREE.MeshPhongMaterial({
      color: 0xf1c331, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
      // Where the source part's real surface and the simulated cut surface
      // coincide (the common, good case - it means the cut matched the
      // design), two coplanar meshes at the same depth flicker/z-fight.
      // polygonOffset nudges this mesh's depth-buffer value, not its actual
      // geometry, so it reads as sitting cleanly on top without displacing
      // it from the stock it's supposed to be verified against.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    for (const { position, index } of ghostGeometryData) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      if (index) geometry.setIndex(new THREE.Uint32BufferAttribute(index, 1));
      geometry.computeVertexNormals();
      ghostMesh.add(new THREE.Mesh(geometry, material));
    }
    scene.add(ghostMesh);
  }

  // Real machined solid, not a static ghost cylinder: rebuilt from the
  // actual radius-per-axial-position profile at the current playback
  // position - see buildTurningStockProfile in toolpathPreview.js for why
  // this is exact (not an approximation) for OD turning. Sample count is a
  // resolution/perf tradeoff, rebuilt on every position change like
  // updateTool() already does.
  const STOCK_PROFILE_SAMPLES = 200;
  const STOCK_RADIAL_SEGMENTS = 56;

  // Lifted out of updateStock()/updateRoutingStock() so the gouge check
  // (below) can read the current cut state without recomputing it.
  let stockOuterProfile = null; // turning: {axial, outer} at the current playback position
  let routingHeights = null; // routing: Float32Array at the current playback position

  function detectTurningGouge(profileNow, targetProfile) {
    // targetProfile (from extractTurningProfileFromMeshes) is {z,x}[] in
    // native STEP-file coordinates. Convert it into the exact same
    // scene/machining axial coordinate the sim's own stock profile uses -
    // zOrigin = targetProfile[0].z, machiningAxial = zOrigin - nativeZ - the
    // identical transform turning.js itself applies before generating
    // G-code (see its own zOrigin/profile normalization), not an
    // independently-guessed fractional alignment. Getting this wrong is not
    // a cosmetic bug: an earlier version normalized both profiles to
    // independent 0..1 fractions, which silently compared the two ends of
    // the part backwards (the stock profile's fraction=0 is the chuck end;
    // the target's fraction=0 landed on the face end) - correct-looking on
    // a constant-radius test fixture, wrong on any real tapered/stepped
    // shaft, which is exactly the case this check exists for.
    const zOrigin = targetProfile[0].z;
    const sorted = targetProfile
      .map((p) => ({ axial: zOrigin - p.z, radius: p.x }))
      .sort((a, b) => a.axial - b.axial);

    const radiusAtAxial = (axial) => {
      if (axial <= sorted[0].axial) return sorted[0].radius;
      const last = sorted[sorted.length - 1];
      if (axial >= last.axial) return last.radius;
      for (let i = 0; i < sorted.length - 1; i += 1) {
        if (axial >= sorted[i].axial && axial <= sorted[i + 1].axial) {
          const span = sorted[i + 1].axial - sorted[i].axial;
          const t = span === 0 ? 0 : (axial - sorted[i].axial) / span;
          return sorted[i].radius + t * (sorted[i + 1].radius - sorted[i].radius);
        }
      }
      return last.radius;
    };

    const { axial, outer } = profileNow;
    for (let i = 0; i < axial.length; i += 1) {
      if (outer[i] < radiusAtAxial(axial[i]) - GOUGE_TOLERANCE) return true;
    }
    return false;
  }

  function updateStock() {
    disposeStock();
    if (!scene || !moves.length) return;

    if (isTurning) {
      if (!(Number(stockDiameter) > 0)) return;

      const initialOuterRadius = stockEnvelopeRadius(Number(stockDiameter), stockShape);
      let rawAxialMin = Infinity;
      for (const move of moves) {
        if (move.from.x < rawAxialMin) rawAxialMin = move.from.x;
        if (move.to.x < rawAxialMin) rawAxialMin = move.to.x;
      }
      const margin = initialOuterRadius * 0.08;
      // Z=0 is always the face (turning.js's own normalization convention) -
      // nothing physically exists past it. Clamping here (rather than at the
      // raw move bounds) is what keeps the finishing pass's X0-approach move
      // - which technically sweeps through Z>0, empty clearance air, not
      // real stock - from carving a fake divot into the rendered solid.
      const axialMin = rawAxialMin - margin;
      const axialMax = 0;

      const drillRadius = Number(drillDiameter) > 0 ? Number(drillDiameter) / 2 : 0;
      const moveIndex = toolPosition?.moveIndex ?? 0;
      const progress = toolPosition?.progress ?? 0;

      const { axial, outer, inner } = buildTurningStockProfile(moves, {
        samples: STOCK_PROFILE_SAMPLES,
        axialMin,
        axialMax,
        initialOuterRadius,
        drillRadius,
        uptoMoveIndex: moveIndex,
        partialProgress: progress
      });
      stockOuterProfile = { axial, outer };

      const hasBore = inner.some((r) => r > 0.001);
      let geometry;
      if (stockShape === 'hex' && !hasBore) {
        // Exact hex cross-section, not the across-corners-circle
        // approximation the axisymmetric path below uses for hex stock -
        // see buildTurningStockRings's own comment for why this is exact,
        // not just a nicer-looking guess. No bore support there yet (rare
        // combination), so a drilled hex part still falls through to the
        // axisymmetric path.
        const rings = buildTurningStockRings(axial, outer, {
          angularSegments: STOCK_RADIAL_SEGMENTS,
          stockShape: 'hex',
          acrossFlatsRadius: Number(stockDiameter) / 2
        });
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(rings.position, 3));
        geometry.setIndex(new THREE.BufferAttribute(rings.index, 1));
        // Already built directly in scene coordinates (x=axial), unlike
        // LatheGeometry below - no extra rotation needed.
      } else {
        const points = turningProfileToLathePoints(axial, outer, inner).map(([r, z]) => new THREE.Vector2(r, z));
        geometry = new THREE.LatheGeometry(points, STOCK_RADIAL_SEGMENTS);
        // LatheGeometry revolves around its local Y axis (radius=x, axial
        // position=y). rotateZ(-90deg) maps local Y -> scene +X directly (no
        // sign flip), matching every other turning coordinate in this file
        // (toolPosition.position.x is the same raw projected axial value) -
        // unlike the old uniform cylinder, an asymmetric machined profile
        // actually needs the correct sign here, not just "a" rotation.
        geometry.rotateZ(-Math.PI / 2);
      }
      geometry.computeVertexNormals();

      const solid = new THREE.Mesh(geometry, createStockMaterial());
      stockMesh = new THREE.Group();
      stockMesh.add(solid);
      stockMesh.visible = stockVisible;
      scene.add(stockMesh);
      return;
    }

    if (isTubestock) {
      updateTubestockStock();
      return;
    }

    updateRoutingStock();
  }

  // Tube stock (3-axis router, manual flip between faces): a static box in the tube's own
  // local frame (see projectTubestockToolpath's own doc comment for why
  // this isn't animated as a literal rotation), with each wall built as a
  // flat surface that a hole is cut into the instant playback reaches its
  // plunge move, plus a dark bore cylinder showing how deep that hole has
  // actually gone - both placed via tubeLocalPoint, the same function that
  // places the toolpath/tool, so the holes and the moves that drill them
  // can never drift apart the way the routing ghost-part/edgeShift bug did.
  const TUBESTOCK_CIRCLE_SEGMENTS = 24;
  const TUBESTOCK_MIN_VISIBLE_DEPTH = 0.0005;

  function updateTubestockStock() {
    if (!crossSection || !(crossSection.a > 0) || !(crossSection.b > 0)) return;

    const currentMoveIndex = toolPosition?.moveIndex ?? 0;
    const currentProgress = toolPosition?.progress ?? 0;
    const holeDepthNow = (hole) => {
      if (hole.moveIndex < 0) return hole.fullDepth; // unmatched - safe fallback, always shown
      if (hole.moveIndex < currentMoveIndex) return hole.fullDepth;
      if (hole.moveIndex === currentMoveIndex) return hole.fullDepth * currentProgress;
      return 0;
    };

    const minU = Number.isFinite(bounds.min.x) ? bounds.min.x : 0;
    const maxU = Number.isFinite(bounds.max.x) && bounds.max.x > minU ? bounds.max.x : minU + 1;

    const group = new THREE.Group();
    const surfaceMaterial = createStockMaterial();
    // The visible inside of a drilled hole is a duller, rougher-looking
    // surface than the tube's own outer face (no direct light reaches deep
    // into it either way) - lower metalness/higher roughness reads as that
    // shadowed interior rather than a mirror-bright twin of the outside.
    const boreMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, metalness: 0.4, roughness: 0.75, side: THREE.DoubleSide });

    const wallAngles = [...new Set((walls || []).map((w) => w.angleDeg))];
    for (const angle of wallAngles) {
      const snapped = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
      const wallWidth = (snapped === 0 || snapped === 180) ? crossSection.b : crossSection.a;
      const shape = new THREE.Shape([
        new THREE.Vector2(minU, -wallWidth / 2),
        new THREE.Vector2(maxU, -wallWidth / 2),
        new THREE.Vector2(maxU, wallWidth / 2),
        new THREE.Vector2(minU, wallWidth / 2)
      ]);

      for (const hole of drilledHoleIndex) {
        if (hole.angleDeg !== angle) continue;
        const depth = holeDepthNow(hole);
        if (!(depth > TUBESTOCK_MIN_VISIBLE_DEPTH)) continue;

        const radius = hole.diameter / 2;
        const holePath = new THREE.Path();
        holePath.absellipse(hole.position, hole.lateralOffset, radius, radius, 0, Math.PI * 2, false, 0);
        shape.holes.push(holePath);

        const outer3D = tubeLocalPoint(angle, hole.position, hole.lateralOffset, 0, crossSection);
        const inner3D = tubeLocalPoint(angle, hole.position, hole.lateralOffset, -depth, crossSection);
        const dir = new THREE.Vector3(inner3D.x - outer3D.x, inner3D.y - outer3D.y, inner3D.z - outer3D.z);
        const boreLength = dir.length();
        if (boreLength < 1e-6) continue;
        dir.normalize();
        const bore = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, boreLength, TUBESTOCK_CIRCLE_SEGMENTS), boreMaterial);
        bore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        bore.position.set((outer3D.x + inner3D.x) / 2, (outer3D.y + inner3D.y) / 2, (outer3D.z + inner3D.z) / 2);
        group.add(bore);
      }

      const geometry = new THREE.ShapeGeometry(shape);
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 1) {
        const local = tubeLocalPoint(angle, pos.getX(i), pos.getY(i), 0, crossSection);
        pos.setXYZ(i, local.x, local.y, local.z);
      }
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
      group.add(new THREE.Mesh(geometry, surfaceMaterial));
    }

    // End caps - plain rectangles, no holes (extractTubeFeaturesFromMeshes
    // only reads side-wall holes) - just enough for the tube to read as a
    // real solid bar rather than 4 open, floating panels.
    const halfA = crossSection.a / 2;
    const halfB = crossSection.b / 2;
    for (const u of [minU, maxU]) {
      const capGeometry = new THREE.BufferGeometry();
      const positions = new Float32Array([
        u, -halfA, -halfB, u, halfA, -halfB, u, halfA, halfB,
        u, -halfA, -halfB, u, halfA, halfB, u, -halfA, halfB
      ]);
      capGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      capGeometry.computeVertexNormals();
      group.add(new THREE.Mesh(capGeometry, surfaceMaterial));
    }

    group.visible = stockVisible;
    stockMesh = group;
    scene.add(stockMesh);
  }

  // Real machined solid for routing (Phase 4 of
  // docs/toolpath-simulation-plan.md, deferred when the router sim first
  // shipped) - a heightmap-displaced plate, rebuilt every playback position
  // from buildRoutingHeightmap. See that function's own comment for why a
  // grid is exact for a 2.5D router cut, unlike turning's radius profile.
  // Capped resolution is a real tradeoff (this grid is rebuilt on every
  // scrub frame): too coarse relative to the cutter radius and the swept
  // capsule's own circular boundary aliases into a visible staircase -
  // "ridges" that aren't a real machining feature, just quantization at the
  // cell size buildRoutingHeightmap uses (see its own comment on why the
  // sweep math itself is otherwise exact). 320 visibly faceted small
  // features (a #10 clearance hole, ~0.2" diameter) on stock much wider
  // than that - the width/HEIGHTMAP_MAX_GRID performance floor was
  // overriding the tool-diameter-driven targetCellSize below it, capping
  // resolution well below what a small hole needs even though the sweep
  // math itself has plenty of headroom left. 480 still stays well inside
  // what the GPU/rebuild-on-scrub cost can absorb.
  const HEIGHTMAP_MAX_GRID = 480;
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

    // The real measured material thickness once the ghost part has loaded
    // (Phase 5 - extractRoutingContoursFromMeshes); until/unless that's
    // available, fall back to "a bit below the deepest programmed cut,
    // safely into the spoilboard" - not a real measurement, but honest
    // enough to read as a solid plate rather than a paper-thin sheet.
    const floorZ = routingTargetThickness != null
      ? -routingTargetThickness
      : Math.min(bounds.min.z - cellSize, -0.05);
    const moveIndex = toolPosition?.moveIndex ?? 0;
    const progress = toolPosition?.progress ?? 0;

    // Two outputs from one sweep: `heights` is the exact, binary simulation
    // state, and `surfaceRaw` is the same cut carried to sub-cell accuracy at
    // the boundary. Testing only a cell's centre makes every cell
    // all-or-nothing, which is what turned curved boundaries into a
    // staircase of cell-sized steps - the faceted bore walls and radial
    // ridges on a pocket.
    const surfaceRaw = new Float32Array(nx * ny);
    const heights = buildRoutingHeightmap(moves, {
      nx, ny, minX: gridMinX, minY: gridMinY, cellSize, topZ: 0, floorZ,
      cutterRadiusForMove: routingCutterRadius,
      uptoMoveIndex: moveIndex,
      partialProgress: progress,
      surfaceOut: surfaceRaw
    });
    routingHeights = heights;
    // The raw heightmap remains the simulation state for gouge detection.
    // The top mesh gets a shallow, edge-preserving pass so grid noise does
    // not show up as lighting facets; actual depth steps become wall quads.
    const surfaceHeights = smoothRoutingHeightmap(surfaceRaw, {
      nx,
      ny,
      epsilon: Math.max(cellSize * 0.08, 0.0005)
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
      posAttr.setZ(i, surfaceHeights[iy * nx + ix]);
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();

    const material = createStockMaterial();
    const solid = new THREE.Mesh(geometry, material);

    stockMesh = new THREE.Group();
    stockMesh.add(solid);
    stockMesh.add(new THREE.Mesh(
      buildRoutingStockSkirt(heights, surfaceHeights, nx, ny, gridMinX, gridMinY, cellSize, floorZ),
      material
    ));
    stockMesh.visible = stockVisible;
    scene.add(stockMesh);
  }

  // The top surface alone is a zero-thickness shell - from the side it reads
  // as a flat 2D sheet rather than a real block of material. Closes it into
  // an actual solid: a flat bottom cap at floorZ, plus 4 vertical walls
  // connecting the (irregular, cut) top edge down to that flat bottom -
  // sharing exact vertex positions with the top surface's own edge cells
  // (same gridMinX/cellSize formula updateRoutingStock uses) so there's no
  // seam gap between this and the heightmap mesh.
  function buildRoutingStockSkirt(heights, surfaceHeights, nx, ny, gridMinX, gridMinY, cellSize, floorZ) {
    const vx = (ix) => gridMinX + cellSize * (ix + 0.5);
    const vy = (iy) => gridMinY + cellSize * (iy + 0.5);
    const topAt = (ix, iy) => surfaceHeights[iy * nx + ix];

    const positions = [];
    const quad = (a, b, c, d) => {
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    };

    // Bottom cap.
    const minX = vx(0), maxX = vx(nx - 1), minY = vy(0), maxY = vy(ny - 1);
    quad([minX, minY, floorZ], [maxX, minY, floorZ], [maxX, maxY, floorZ], [minX, maxY, floorZ]);

    // -Y and +Y walls.
    for (let ix = 0; ix < nx - 1; ix += 1) {
      const x0 = vx(ix), x1 = vx(ix + 1);
      quad(
        [x0, minY, floorZ], [x1, minY, floorZ],
        [x1, minY, topAt(ix + 1, 0)], [x0, minY, topAt(ix, 0)]
      );
      quad(
        [x1, maxY, floorZ], [x0, maxY, floorZ],
        [x0, maxY, topAt(ix, ny - 1)], [x1, maxY, topAt(ix + 1, ny - 1)]
      );
    }
    // -X and +X walls.
    for (let iy = 0; iy < ny - 1; iy += 1) {
      const y0 = vy(iy), y1 = vy(iy + 1);
      quad(
        [minX, y1, floorZ], [minX, y0, floorZ],
        [minX, y0, topAt(0, iy)], [minX, y1, topAt(0, iy + 1)]
      );
      quad(
        [maxX, y0, floorZ], [maxX, y1, floorZ],
        [maxX, y1, topAt(nx - 1, iy + 1)], [maxX, y0, topAt(nx - 1, iy)]
      );
    }

    // PlaneGeometry shares vertices across every cell, which is right for a
    // continuous top surface but cannot represent an internal depth step.
    // Emit a separate vertical quad at each raw height discontinuity: pocket
    // and profile walls now read as real machined walls instead of a sloped
    // interpolation between the two grid samples.
    const wallEpsilon = Math.max(cellSize * 0.08, 0.0005);
    // Scanned on the displayed surface rather than the raw state: with
    // sub-cell coverage the boundary already ramps across roughly one cell,
    // so emitting hard quads at the raw quantised steps would draw a
    // staircase over the very ramp that smooths it. Genuine depth changes
    // (a pocket floor against the top face) still exceed the epsilon and
    // still get a crisp wall.
    for (const wall of findRoutingHeightmapWalls(surfaceHeights, { nx, ny, epsilon: wallEpsilon })) {
      if (wall.axis === 'x') {
        const x = gridMinX + cellSize * (wall.ix + 1);
        const y0 = vy(wall.iy);
        const y1 = vy(Math.min(wall.iy + 1, ny - 1));
        if (y1 > y0) quad([x, y0, wall.a], [x, y1, wall.a], [x, y1, wall.b], [x, y0, wall.b]);
      } else {
        const y = gridMinY + cellSize * (wall.iy + 1);
        const x0 = vx(wall.ix);
        const x1 = vx(Math.min(wall.ix + 1, nx - 1));
        if (x1 > x0) quad([x0, y, wall.a], [x1, y, wall.a], [x1, y, wall.b], [x0, y, wall.b]);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  }

  function updateTool() {
    if (!scene) return;
    if ((!cutterDiameter && !isTurning && !isTubestock) || !toolPosition) {
      disposeTool();
      return;
    }

    if (isTubestock) {
      // A drill, not an end mill: rendered as a plain cylinder (same shape
      // as the router bit below, no insert/holder detail needed) but
      // oriented along the CURRENT move's own wall normal - unlike routing
      // (always +Z) or turning (always the fixed XZ plane), the working
      // direction changes with every wall the toolpath visits.
      const currentAngle = moves[toolPosition.moveIndex]?.angleDeg ?? 0;
      const normal = tubeWallNormal(currentAngle);
      const span = Math.max(Number(crossSection?.a) || 0, Number(crossSection?.b) || 0, 0.5);
      const size = Math.max(span * 0.03, 0.04);
      const length = Math.max(size * 8, 0.4);

      if (!toolMesh || toolMesh.userData.kind !== 'tubestock' || toolMesh.userData.size !== size) {
        disposeTool();
        toolMesh = new THREE.Group();
        const drillMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.3 });
        // A real twist drill tapers to a point (a plain flat-ended cylinder
        // reads as a rod, not a drill) - the shank stays a cylinder, with a
        // short cone (a real drill's ~118deg included point angle) at the
        // working end so the silhouette is actually recognizable as a bit.
        const pointAngleRad = (118 * Math.PI) / 180;
        const pointHeight = size / Math.tan(pointAngleRad / 2);
        const shankHeight = Math.max(length - pointHeight, length * 0.5);
        const shank = new THREE.Mesh(new THREE.CylinderGeometry(size, size, shankHeight, 16), drillMaterial);
        shank.position.y = pointHeight / 2;
        toolMesh.add(shank);
        const point = new THREE.Mesh(new THREE.ConeGeometry(size, pointHeight, 16), drillMaterial);
        point.position.y = -shankHeight / 2;
        point.rotation.x = Math.PI;
        toolMesh.add(point);
        toolMesh.userData.kind = 'tubestock';
        toolMesh.userData.size = size;
        scene.add(toolMesh);
      }
      const dir = new THREE.Vector3(normal.x, normal.y, normal.z);
      toolMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const tip = toolPosition.position;
      toolMesh.position.set(
        tip.x + normal.x * (length / 2),
        tip.y + normal.y * (length / 2),
        tip.z + normal.z * (length / 2)
      );
      toolMesh.visible = toolVisible;
      return;
    }

    if (isTurning) {
      // A real toolholder + diamond insert, matching Fusion's own turning
      // simulation look (a metallic holder bar with a small bright insert
      // at the tip) rather than a router end mill - a lathe cuts with a
      // stationary insert against a rotating part, not a spinning bit.
      // Sized off the stock so it reads clearly at any part scale - the
      // old tiny 4-sided cone (sized only off noseRadius, which is often
      // unset) was nearly invisible in practice.
      const stockRadius = Number(stockDiameter) > 0 ? stockEnvelopeRadius(Number(stockDiameter), stockShape) : 0.5;
      const insertSize = Math.max(Number(noseRadius) * 10, stockRadius * 0.16, 0.05);
      const holderWidth = Math.max(stockRadius * 0.3, 0.12);
      const holderLength = Math.max(stockRadius * 1.8, 0.7);

      if (!toolMesh || toolMesh.userData.kind !== 'turning' || toolMesh.userData.size !== insertSize || toolMesh.userData.holderWidth !== holderWidth) {
        disposeTool();
        toolMesh = new THREE.Group();

        // Insert tip - a flat 4-sided diamond (a real turning insert's
        // shape, not a tall generic polyhedron), anchored at the group's
        // local origin (= toolPosition below, the exact contact point).
        // Bright, saturated, and strongly emissive so it reads as a
        // distinct highlight against both the gray stock and the holder
        // regardless of lighting/camera angle - the old muted gold was too
        // easily lost against the holder's own shadow.
        const insert = new THREE.Mesh(
          new THREE.ConeGeometry(insertSize, insertSize * 0.7, 4),
          new THREE.MeshPhongMaterial({ color: 0xffcc33, emissive: 0xcc8800, emissiveIntensity: 0.6, shininess: 100 })
        );
        insert.rotation.z = Math.PI / 4;
        toolMesh.add(insert);

        // Holder shank extends outward from the tip, tilted off the flat
        // Z=0 plane every turning coordinate in this file otherwise stays
        // in (toolPosition.position.z is always 0 - see
        // projectTurningToolpath) - a pure +Y extension would sit exactly
        // in that plane and can look edge-on/foreshortened to almost
        // nothing from some camera angles. The tilt keeps it reading as a
        // real 3D block from any reasonable orbit angle. Mid-gray steel
        // color (not near-black) so the block itself stays legible instead
        // of reading as a shadow.
        const holder = new THREE.Mesh(
          new THREE.BoxGeometry(holderWidth, holderLength, holderWidth),
          new THREE.MeshStandardMaterial({ color: 0x6b7280, metalness: 0.8, roughness: 0.35 })
        );
        const holderOffset = holderLength / 2 + insertSize * 0.6;
        holder.position.set(0, holderOffset * 0.85, holderOffset * 0.53);
        holder.rotation.x = -0.55;
        toolMesh.add(holder);

        toolMesh.userData.kind = 'turning';
        toolMesh.userData.size = insertSize;
        toolMesh.userData.holderWidth = holderWidth;
        scene.add(toolMesh);
      }
      toolMesh.position.set(toolPosition.position.x, toolPosition.position.y, toolPosition.position.z);
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
        // A single flat ambient + one directional light reads as a plastic
        // toy under any material, no matter how the material itself is
        // tuned - real CAM simulators (Fusion 360 included) render stock as
        // recognizable metal via soft multi-directional lighting, not
        // brute-force ambient. This is a standard 3-point-ish studio rig:
        // a soft hemisphere fill (sky/ground gradient, no hard shadow
        // direction) plus a stronger key light and a dimmer fill from the
        // opposite side so no face of the part ever goes fully black.
        scene.add(new THREE.HemisphereLight(0xf5f3ea, 0x35342c, 0.55));
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
        keyLight.position.set(3, -4, 5);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
        fillLight.position.set(-4, 3, 2);
        scene.add(fillLight);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;

        rebuildToolpath();
        updateStock();
        updateGhostMesh();

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
      disposeGhost();
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
    {#if gougeDetected}
      <div class="gouge-banner" role="alert">
        ⚠️ Possible gouge: as of the current playback position, this program has cut below the source part's actual finished surface.
      </div>
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
      <div class="run-time" title={machiningTimeTitle}>
        <span>Est. run time</span>
        <output>
          {formatMachiningTime(machiningTime.totalSeconds)}{#if machiningTime.pauseCount > 0}<span class="run-time-note"> + {machiningTime.pauseCount} pause{machiningTime.pauseCount === 1 ? '' : 's'}</span>{/if}
        </output>
      </div>
      <label class="speed-control">
        <span>Simulation speed</span>
        <input class="speed-slider" type="range" min="0.25" max="10" step="0.25" value={playbackSpeed} style={`--speed-progress: ${speedProgress}%`} on:input={(event) => (playbackSpeed = Number(event.currentTarget.value))} disabled={!moves.length} />
        <output>{speedLabel(playbackSpeed)}</output>
      </label>
    </div>

    <div class="legend">
    <label class="legend-item">
      <input type="checkbox" bind:checked={toolpathVisible} />
      <span class="legend-label">Toolpath</span>
    </label>
    <label class="legend-item" class:empty={!isTurning && !isTubestock && !cutterDiameter}>
      <input type="checkbox" bind:checked={toolVisible} disabled={!isTurning && !isTubestock && !cutterDiameter} />
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
    {#if stepFileName && !isTubestock}
      <label class="legend-item" class:empty={!ghostGeometryData} title={ghostError || (ghostLoading ? 'Loading source part...' : 'The source STEP part, shown semi-transparently for comparison')}>
        <input type="checkbox" bind:checked={modelVisible} disabled={!ghostGeometryData} />
        <span class="legend-label">Model{ghostLoading ? '…' : ''}</span>
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

  {#if !isTurning && !isTubestock && !singleToolDiameter && !activeSequenceDiameter}
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
  .gouge-banner {
    position: absolute;
    left: var(--space-3, 0.75rem);
    right: var(--space-3, 0.75rem);
    bottom: var(--space-3, 0.75rem);
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius-sm, 4px);
    background: var(--red-soft, #fee2e2);
    color: var(--red-strong, #991b1b);
    border: 1px solid var(--red-base, #dc3545);
    font-size: 0.85rem;
    font-weight: 600;
    z-index: 2;
  }
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
  .run-time {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    white-space: nowrap;
  }
  .run-time span { font-size: 0.7rem; color: var(--text-muted); }
  .run-time output { font-weight: 600; font-variant-numeric: tabular-nums; }
  .run-time-note { font-weight: 400; color: var(--text-muted); font-size: 0.75rem; }

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
