/**
 * Parses AutoCAM-generated G-code back into toolpath moves for preview and
 * simulation. Deliberately narrow: it understands the G-code these generators
 * (turning.js, routing.js) actually emit, not the whole language. No canned
 * cycles, no cutter compensation, no subprograms.
 *
 * Two consumers, one interpreter:
 *   - parseToolpath3D()      full {x,y,z} moves, for the 3D simulator
 *   - parseGcodeToolpath()   flattened 2D segments, for the SVG preview
 *
 * The 3D simulator is routing-only by design (see
 * docs/toolpath-simulation-plan.md - turning's stock is a solid of revolution
 * and needs a different representation). The interpreter itself stays
 * operation-agnostic, because the 2D preview still serves both: a turning
 * program uses X/Z and never mentions Y, so nothing here may assume an axis
 * has been commanded.
 *
 * Turning: G-code X is diameter - converted back to radius here. Segment
 * coordinates are {a: Z, b: radius}.
 * Routing: X/Y are used directly. Segment coordinates are {a: X, b: Y}.
 *
 * Multi-tool routing (see implementations/toolchange-gcode-plan.md) emits a
 * "(TOOL CHANGE: ...)" comment between tools - each move is tagged with
 * `toolIndex` (0 for the first/primary tool, incrementing at each change) by
 * matching that marker, so a multi-tool preview can be colour-coded by tool
 * instead of looking like one undifferentiated path.
 *
 * ARCS: routing.js emits real G02/G03 - helical entry and true circular
 * contours (see emitHelicalCircularContour). They are tessellated into short
 * chords here. This parser previously ignored arcs entirely, which meant the
 * 2D preview silently omitted every hole and circular profile.
 */

// Chord tolerance for tessellating arcs, in the program's own units. At 0.002"
// a 0.25"-radius hole comes out ~18 segments, which reads as round without
// flooding the renderer on a program full of holes.
const DEFAULT_CHORD_TOLERANCE = 0.002;
const MIN_ARC_SEGMENTS = 8;
const MAX_ARC_SEGMENTS = 512;

const num = (match) => (match ? parseFloat(match[1]) : null);

/**
 * Full 3D interpretation.
 *
 * @returns {{moves: Array, toolChangeIndices: number[], totalDistance: number}}
 *   Each move: {from:{x,y,z}, to:{x,y,z}, kind, toolIndex, length, startDistance}
 *   `kind` is 'rapid' | 'cut' | 'ramp', matching how Fusion colours moves by
 *   what they are rather than which tool made them.
 */
export function parseToolpath3D(gcode, { chordTolerance = DEFAULT_CHORD_TOLERANCE } = {}) {
  const moves = [];
  const toolChangeIndices = [];
  let totalDistance = 0;
  let toolIndex = 0;

  // Absolute (G90) is the only mode these generators emit, but honouring G91
  // costs little and a silently mis-plotted path is worse than the code.
  let incremental = false;
  let cur = { x: null, y: null, z: null, a: 0 };
  let motion = null; // 0 rapid, 1 feed, 2 arc CW, 3 arc CCW

  // An axis never commanded stays at 0, the way a machine sits at its origin
  // until told otherwise. This matters for turning, which uses X/Z and never
  // mentions Y - gating on "we know X and Y" would emit nothing at all for a
  // whole turning program.
  const at = (point) => ({ x: point.x ?? 0, y: point.y ?? 0, z: point.z ?? 0 });

  // angleDeg: tubestock.js's face index (no real rotary axis - see the
  // FACE-tag comment handling below), tagged onto every move so
  // a tube-stock consumer can place it on the right wall (routing/turning
  // never command A, so this is always 0 for them - see
  // projectTubestockToolpath, the only reader that cares).
  const push = (rawFrom, rawTo, kind, angleDeg) => {
    const from = at(rawFrom);
    const to = at(rawTo);
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    if (!(length > 0)) return; // a repeated coordinate is not a move
    moves.push({ from, to, kind, toolIndex, length, startDistance: totalDistance, angleDeg: angleDeg ?? 0 });
    totalDistance += length;
  };

  for (const rawLine of (gcode || '').split('\n')) {
    if (/\(TOOL CHANGE:/i.test(rawLine)) {
      toolIndex += 1;
      toolChangeIndices.push(moves.length);
    }

    // tubestock.js's combined multi-face program has no real rotary axis to
    // command, so a face change is tagged as a `(FACE A90 - ...)` comment
    // (never a live G-code word - see tubestock.js's own comment at the
    // call site) rather than an actual `A90` motion word. Read it before
    // the comment-stripping below, which would otherwise discard it.
    const faceTagMatch = rawLine.match(/\(FACE A(-?[\d.]+)/);
    if (faceTagMatch) cur.a = Number(faceTagMatch[1]);

    const line = rawLine.replace(/\(.*?\)/g, '').trim();
    if (!line || line.startsWith('%') || line.startsWith('O')) continue;

    if (/\bG9\s*0\b|\bG90\b/.test(line)) incremental = false;
    if (/\bG91\b/.test(line)) incremental = true;

    const motionMatch = line.match(/G0?([0123])\b/);
    if (motionMatch) motion = Number(motionMatch[1]);

    const xWord = num(line.match(/X(-?[\d.]+)/));
    const yWord = num(line.match(/Y(-?[\d.]+)/));
    const zWord = num(line.match(/Z(-?[\d.]+)/));
    const iWord = num(line.match(/I(-?[\d.]+)/));
    const jWord = num(line.match(/J(-?[\d.]+)/));
    const rWord = num(line.match(/R(-?[\d.]+)/));
    // Always absolute in this app's own tubestock output (an indexing move
    // never appears under G91) - no incremental handling needed, unlike X/Y/Z.
    const aWord = num(line.match(/A(-?[\d.]+)/));

    // A tube-stock indexing line (`G00 A90`) commands no X/Y/Z at all - it
    // must still update `cur.a` for the moves that follow, so it can't be
    // skipped by the same "no axis word at all" check that discards a bare
    // comment/mode line.
    if (xWord === null && yWord === null && zWord === null && aWord === null) continue;
    if (motion === null) continue; // no motion mode established yet

    const axis = (word, prev) => {
      if (word === null) return prev;
      if (!incremental || prev === null) return word;
      return prev + word;
    };
    const next = {
      x: axis(xWord, cur.x),
      y: axis(yWord, cur.y),
      z: axis(zWord, cur.z),
      a: aWord === null ? cur.a : aWord
    };

    // Nothing positioned yet means there is no move to draw from - adopt the
    // position and carry on. Checked across all axes rather than X/Y, so a
    // turning program (X/Z, no Y) is not discarded wholesale.
    const positioned = cur.x !== null || cur.y !== null || cur.z !== null;
    if (!positioned) {
      cur = next;
      continue;
    }

    if (motion === 2 || motion === 3) {
      const arcPoints = tessellateArc(at(cur), at(next), {
        clockwise: motion === 2,
        i: iWord, j: jWord, r: rWord, chordTolerance
      });
      let previous = at(cur);
      for (const point of arcPoints) {
        push(previous, point, classify(previous, point, motion), next.a);
        previous = point;
      }
    } else {
      push({ ...cur }, { ...next }, classify(cur, next, motion), next.a);
    }

    cur = next;
  }

  return { moves, toolChangeIndices, totalDistance };
}

/**
 * Locate the cutter at a cumulative program distance. Keeping this independent
 * of three.js makes distance-based playback testable and avoids turning the
 * renderer into a second G-code interpreter.
 *
 * @param {Array} moves output from parseToolpath3D
 * @param {number} distance distance from the beginning of the program
 * @returns {{position:{x:number,y:number,z:number}, moveIndex:number, progress:number}|null}
 */
export function toolpathPositionAtDistance(moves, distance) {
  if (!moves?.length) return null;

  const first = moves[0];
  const last = moves[moves.length - 1];
  const boundedDistance = Math.max(0, Math.min(Number(distance) || 0, last.startDistance + last.length));

  let low = 0;
  let high = moves.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (moves[middle].startDistance + moves[middle].length < boundedDistance) low = middle + 1;
    else high = middle;
  }

  const move = moves[low] || first;
  const progress = move.length ? Math.max(0, Math.min(1, (boundedDistance - move.startDistance) / move.length)) : 0;
  return {
    position: {
      x: move.from.x + (move.to.x - move.from.x) * progress,
      y: move.from.y + (move.to.y - move.from.y) * progress,
      z: move.from.z + (move.to.z - move.from.z) * progress
    },
    moveIndex: low,
    progress
  };
}

/**
 * Project diameter-mode lathe moves into the simulator's right-handed scene.
 * Scene X is the spindle/part axis (machine Z), scene Y is radius (machine
 * X / 2), and scene Z is the tool's fixed approach plane. Recomputing lengths
 * after the projection matters: using diameter-mode distances would make the
 * playback cursor run at twice the visible radial speed.
 */
export function projectTurningToolpath(parsed) {
  let totalDistance = 0;
  const moves = (parsed?.moves || []).map((move) => {
    const project = (point) => ({ x: point.z, y: point.x / 2, z: 0 });
    const from = project(move.from);
    const to = project(move.to);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const projected = {
      ...move,
      from,
      to,
      // A lathe has no router-style plunge/ramp category. Every non-rapid
      // move is an engaged turning/facing cut in the XZ plane.
      kind: move.kind === 'rapid' ? 'rapid' : 'cut',
      length,
      startDistance: totalDistance
    };
    totalDistance += length;
    return projected;
  });

  const toolChangeIndices = (parsed?.toolChangeIndices || []).filter((index) => index < moves.length);
  return { moves, toolChangeIndices, totalDistance };
}

/**
 * Material-removal model for the turning 3D sim. Unlike routing (2.5D,
 * needs a heightmap - see docs/toolpath-simulation-plan.md), a lathe part
 * is a solid of revolution: its complete state at any instant in the
 * program is exactly two 1D radius-per-axial-position arrays, outer and
 * inner (bore) - no grid needed, and this is *exact* for OD turning, not
 * an approximation.
 *
 * Takes already-`projectTurningToolpath`-ed moves (scene x = axial,
 * scene y = radius). An OD cut lowers `outer` where it sweeps. A bore cut
 * is detected as a move at ~zero radius (both endpoints) - exactly how
 * turning.js's appendDrillingOperation emits every drilling G01 (X0.0
 * throughout) - and raises `inner` to `drillRadius` where it sweeps;
 * `drillRadius` itself can't be read off the move (a centerline move's own
 * radius is 0 regardless of drill diameter), so it's passed in from the
 * job's saved drilling params.
 *
 * ONE DOCUMENTED APPROXIMATION: hex stock's *uncut* regions render as a
 * circle at the across-corners radius (`initialOuterRadius` - pass
 * `stockEnvelopeRadius()` from turning.js), not the true hexagonal
 * cross-section, since a hex prism isn't representable in a single
 * radius-per-z profile. It converges to the exact turned shape the moment
 * any material is removed there.
 *
 * @returns {{axial: Float32Array, outer: Float32Array, inner: Float32Array}}
 */
export function buildTurningStockProfile(moves, {
  samples = 220,
  axialMin,
  axialMax,
  initialOuterRadius,
  drillRadius = 0,
  uptoMoveIndex = moves.length,
  partialProgress = 1
} = {}) {
  const sampleCount = Math.max(2, Math.floor(samples));
  const span = (axialMax - axialMin) || 1;
  const axial = new Float32Array(sampleCount);
  const outer = new Float32Array(sampleCount).fill(initialOuterRadius);
  const inner = new Float32Array(sampleCount).fill(0);
  for (let i = 0; i < sampleCount; i += 1) axial[i] = axialMin + (span * i) / (sampleCount - 1);

  const indexAt = (z) => Math.round(((z - axialMin) / span) * (sampleCount - 1));

  const applyMove = (move, progress) => {
    if (!move || move.kind === 'rapid') return;
    const toX = move.from.x + (move.to.x - move.from.x) * progress;
    const toY = move.from.y + (move.to.y - move.from.y) * progress;
    const fromX = move.from.x;
    const fromY = move.from.y;
    const isBore = Math.abs(fromY) < 1e-6 && Math.abs(toY) < 1e-6;
    const lo = Math.min(fromX, toX);
    const hi = Math.max(fromX, toX);

    if (hi - lo < 1e-9) {
      // Facing/plunge move at ~constant axial position - affects only the
      // nearest sample rather than a range.
      const idx = Math.max(0, Math.min(sampleCount - 1, indexAt(lo)));
      if (isBore) inner[idx] = Math.max(inner[idx], drillRadius);
      else outer[idx] = Math.min(outer[idx], Math.max(fromY, toY, 0));
      return;
    }

    const iStart = Math.max(0, Math.ceil(((lo - axialMin) / span) * (sampleCount - 1)));
    const iEnd = Math.min(sampleCount - 1, Math.floor(((hi - axialMin) / span) * (sampleCount - 1)));
    for (let i = iStart; i <= iEnd; i += 1) {
      if (isBore) {
        inner[i] = Math.max(inner[i], drillRadius);
      } else {
        const t = (axial[i] - fromX) / (toX - fromX);
        const r = fromY + (toY - fromY) * t;
        outer[i] = Math.min(outer[i], Math.max(r, 0));
      }
    }
  };

  const fullCount = Math.max(0, Math.min(uptoMoveIndex, moves.length));
  for (let m = 0; m < fullCount; m += 1) applyMove(moves[m], 1);
  if (moves[fullCount] && partialProgress > 0) applyMove(moves[fullCount], partialProgress);

  return { axial, outer, inner };
}

// A radius this small reads as "on the axis" for rendering purposes while
// staying nonzero, avoiding degenerate zero-radius geometry at the tip/bore
// bottom.
const AXIS_EPSILON = 0.001;

/**
 * Converts a turning stock profile into an ordered list of [radius, axial]
 * points tracing the SOLID's boundary once around - ready to hand to
 * THREE.LatheGeometry (revolve around the axial axis) after mapping into
 * Vector2s. With no bore, this is just the outer wall (open-ended, no flat
 * caps - a documented, deliberately-accepted minor gap; see
 * ToolpathSimulator.svelte). With a bore (always a contiguous run touching
 * the face end - drilling only ever cuts inward from Z0, see
 * appendDrillingOperation), the loop walks the far end cap, up the outer
 * wall, across the face annulus, down the bore wall, and across the
 * hole's flat bottom - a real closed profile, so the hole actually reads
 * as a hole once revolved.
 *
 * @returns {Array<[number, number]>} [radius, axial] pairs
 */
export function turningProfileToLathePoints(axial, outer, inner) {
  const n = axial.length;
  let boreStart = -1;
  for (let i = 0; i < n; i += 1) {
    if (inner[i] > AXIS_EPSILON) { boreStart = i; break; }
  }

  if (boreStart === -1) {
    const points = [];
    for (let i = 0; i < n; i += 1) points.push([Math.max(outer[i], AXIS_EPSILON), axial[i]]);
    return points;
  }

  const points = [];
  points.push([AXIS_EPSILON, axial[0]]);
  points.push([Math.max(outer[0], AXIS_EPSILON), axial[0]]);
  for (let i = 1; i < n; i += 1) points.push([Math.max(outer[i], AXIS_EPSILON), axial[i]]);
  points.push([Math.max(inner[n - 1], AXIS_EPSILON), axial[n - 1]]);
  for (let i = n - 2; i >= boreStart; i -= 1) points.push([Math.max(inner[i], AXIS_EPSILON), axial[i]]);
  points.push([AXIS_EPSILON, axial[boreStart]]);
  points.push([AXIS_EPSILON, axial[0]]);
  return points;
}

// theta=0, 60deg, 120deg, ... land on corners (across-corners radius =
// acrossFlatsRadius / cos(30deg) = acrossFlatsRadius * 2/sqrt(3), the same
// HEX_ACROSS_CORNERS_FACTOR turning.js itself uses for the rapid/first-pass
// clearance); 30deg, 90deg, ... land on flat centers (acrossFlatsRadius
// exactly). The physical rotation of the raw stock in the chuck is
// arbitrary anyway, so this phase choice doesn't matter - only that flats
// and corners alternate every 30deg, which they do.
const HEX_SECTOR = Math.PI / 3;
function hexRadiusAtAngle(theta, acrossFlatsRadius) {
  const local = (((theta % HEX_SECTOR) + HEX_SECTOR) % HEX_SECTOR) - HEX_SECTOR / 2;
  return acrossFlatsRadius / Math.cos(local);
}

/**
 * Builds a turning stock mesh (position + index, ready for
 * THREE.BufferGeometry) that shows a HEX cross-section exactly - not the
 * across-corners-circle approximation turningProfileToLathePoints/
 * turningProfileToLathePoints's LatheGeometry caller uses for hex stock.
 *
 * The insight that makes this exact rather than approximate: a lathe tool
 * commands one radius at a time, uniformly around the full revolution - it
 * cannot leave a different amount of material at different angles. So the
 * true radius at any (axial position, angle) is always
 * min(hexRadiusAtAngle(angle), outer[i]) - the existing 1D `outer` profile
 * (already an exact simulation of what a single-point turning tool leaves,
 * see buildTurningStockProfile) still IS the ground truth once the corners
 * are gone; this only adds the angular variation back in for whatever the
 * tool hasn't reached yet. No new cut-simulation logic, just a richer
 * rendering of the same result.
 *
 * Bore (inner radius) is not supported here - a drilled bore combined with
 * hex stock is a rare enough combination that the caller should fall back
 * to turningProfileToLathePoints's axisymmetric (across-corners-circle
 * approximation) path when `inner` has any bore in it; that path already
 * handles a bore correctly for round stock.
 *
 * @returns {{position: Float32Array, index: Uint32Array}}
 */
export function buildTurningStockRings(axial, outer, {
  angularSegments = 48,
  stockShape = 'round',
  acrossFlatsRadius = null
} = {}) {
  const n = axial.length;
  const ringSize = angularSegments + 1;
  const position = new Float32Array(n * ringSize * 3);

  let vi = 0;
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a <= angularSegments; a += 1) {
      const theta = (a / angularSegments) * Math.PI * 2;
      const hexBound = stockShape === 'hex' && acrossFlatsRadius != null
        ? hexRadiusAtAngle(theta, acrossFlatsRadius)
        : Infinity;
      const r = Math.max(Math.min(hexBound, outer[i]), AXIS_EPSILON);
      position[vi] = axial[i];
      position[vi + 1] = r * Math.cos(theta);
      position[vi + 2] = r * Math.sin(theta);
      vi += 3;
    }
  }

  const index = new Uint32Array(Math.max(0, n - 1) * angularSegments * 6);
  let ii = 0;
  for (let i = 0; i < n - 1; i += 1) {
    for (let a = 0; a < angularSegments; a += 1) {
      const a0 = i * ringSize + a;
      const a1 = i * ringSize + a + 1;
      const b0 = (i + 1) * ringSize + a;
      const b1 = (i + 1) * ringSize + a + 1;
      index[ii] = a0; index[ii + 1] = b0; index[ii + 2] = a1;
      index[ii + 3] = a1; index[ii + 4] = b0; index[ii + 5] = b1;
      ii += 6;
    }
  }

  return { position, index };
}

// Fusion colours a move by what it is: rapid, a plunge/ramp, or cutting. A
// ramp is Z descending while XY is also moving - which is exactly the helical
// entry routing.js emits. A pure vertical plunge counts too; it is the same
// "going down into material" event a reader is looking for.
function classify(from, to, motion) {
  if (motion === 0) return 'rapid';
  const dz = (to.z ?? 0) - (from.z ?? 0);
  if (dz < 0) return 'ramp';
  return 'cut';
}

/**
 * Tessellate a G02/G03 arc in the XY plane into chord points (Z interpolated,
 * so a helix comes out as a helix). Returns the points AFTER the start.
 *
 * routing.js emits the I/J form; R is handled defensively since it is legal
 * G-code and cheap to support.
 */
function tessellateArc(from, to, { clockwise, i, j, r, chordTolerance }) {
  let cx;
  let cy;

  if (i !== null || j !== null) {
    // I/J are offsets from the arc's START point, per standard convention.
    cx = from.x + (i ?? 0);
    cy = from.y + (j ?? 0);
  } else if (r !== null && r !== 0) {
    const center = centerFromRadius(from, to, r, clockwise);
    if (!center) return [{ ...to }]; // unreachable radius - degrade to a straight move
    cx = center.cx;
    cy = center.cy;
  } else {
    return [{ ...to }]; // no arc geometry at all
  }

  const radius = Math.hypot(from.x - cx, from.y - cy);
  if (!(radius > 0)) return [{ ...to }];

  const startAngle = Math.atan2(from.y - cy, from.x - cx);
  const endAngle = Math.atan2(to.y - cy, to.x - cx);
  let sweep = endAngle - startAngle;

  // Normalize into the direction of travel. G02 is clockwise (negative sweep
  // in a right-handed XY frame viewed from +Z), G03 counter-clockwise.
  if (clockwise) {
    while (sweep > 0) sweep -= Math.PI * 2;
    while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
  } else {
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
  }

  // A full circle arrives as start == end, which normalizes to a zero sweep.
  // routing.js relies on exactly this for its circular contours, so treating
  // it as "no movement" would erase every hole in the program.
  const closesOnItself = Math.abs(from.x - to.x) < 1e-9 && Math.abs(from.y - to.y) < 1e-9;
  if (closesOnItself || Math.abs(sweep) < 1e-9) {
    sweep = clockwise ? -Math.PI * 2 : Math.PI * 2;
  }

  const steps = arcSegmentCount(radius, Math.abs(sweep), chordTolerance);
  const points = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const angle = startAngle + sweep * t;
    points.push({
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      z: from.z === null || to.z === null ? (to.z ?? from.z) : from.z + (to.z - from.z) * t
    });
  }
  // Land exactly on the commanded endpoint rather than a rounded one, so
  // successive moves chain without hairline gaps.
  const last = points[points.length - 1];
  if (last) {
    last.x = to.x;
    last.y = to.y;
    last.z = to.z ?? last.z;
  }
  return points;
}

// Segments needed so the chord never sags further than `tolerance` from the
// true arc: for a half-angle a, sagitta = r(1 - cos a).
function arcSegmentCount(radius, sweep, tolerance) {
  if (!(tolerance > 0) || radius <= tolerance) return MIN_ARC_SEGMENTS;
  const maxAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)));
  const needed = Math.ceil(sweep / Math.max(maxAngle, 1e-6));
  return Math.max(MIN_ARC_SEGMENTS, Math.min(MAX_ARC_SEGMENTS, needed));
}

// R-form: two arcs satisfy any chord. A positive R selects the minor arc
// (<= 180 degrees), negative the major one.
function centerFromRadius(from, to, r, clockwise) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return null; // R-form cannot express a full circle
  const radius = Math.abs(r);
  const half = chord / 2;
  if (radius < half - 1e-9) return null; // no circle of this radius reaches both points
  const offset = Math.sqrt(Math.max(0, radius * radius - half * half));
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  // Unit normal to the chord.
  const nx = -dy / chord;
  const ny = dx / chord;
  const minorArc = r > 0;
  const sign = (clockwise === minorArc) ? -1 : 1;
  return { cx: midX + nx * offset * sign, cy: midY + ny * offset * sign };
}

/**
 * Flattened 2D segments for the SVG preview. Unchanged output contract:
 * {from:{a,b}, to:{a,b}, rapid, toolIndex}.
 */
export function parseGcodeToolpath(gcode, operationType) {
  const { moves } = parseToolpath3D(gcode);
  const segments = [];
  for (const move of moves) {
    const from = toPoint(move.from, operationType);
    const to = toPoint(move.to, operationType);
    if (!from || !to) continue;
    if (from.a === to.a && from.b === to.b) continue; // no movement in this projection
    segments.push({ from, to, rapid: move.kind === 'rapid', toolIndex: move.toolIndex });
  }
  return segments;
}

function toPoint(state, operationType) {
  if (operationType === 'turning') {
    if (state.z === null || state.x === null) return null;
    return { a: state.z, b: state.x / 2 }; // diameter -> radius
  }
  if (state.x === null || state.y === null) return null;
  return { a: state.x, b: state.y };
}

export function toolpathBounds(segments) {
  if (segments.length === 0) return { minA: 0, maxA: 1, minB: 0, maxB: 1 };
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const seg of segments) {
    for (const pt of [seg.from, seg.to]) {
      minA = Math.min(minA, pt.a); maxA = Math.max(maxA, pt.a);
      minB = Math.min(minB, pt.b); maxB = Math.max(maxB, pt.b);
    }
  }
  return { minA, maxA, minB, maxB };
}

/** Axis-aligned bounds of 3D moves, for framing the simulator's camera. */
export function toolpathBounds3D(moves) {
  if (!moves?.length) return { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const move of moves) {
    for (const pt of [move.from, move.to]) {
      for (const axis of ['x', 'y', 'z']) {
        const value = pt[axis];
        if (value === null || value === undefined) continue;
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isFinite(min[axis])) { min[axis] = 0; max[axis] = 1; }
  }
  return { min, max };
}

/**
 * Material-removal heightmap for the routing 3D sim - Phase 4 of
 * docs/toolpath-simulation-plan.md, deferred when the sim first shipped.
 * A router cut is inherently 2.5D (flat plate stock, vertical spindle,
 * flat end mill): "lower the material under a circle to depth Z" is
 * exact for that, which is why a grid works here where turning instead
 * needs a 1D radius profile (see buildTurningStockProfile).
 *
 * For each executed cutting move, sweeps a capsule (the segment, expanded
 * by the cutter radius at that move - resolved per-move via
 * `cutterRadiusForMove`, since multi-tool routing jobs change tool
 * mid-program) across the grid: for every cell whose center falls within
 * the capsule, lowers that cell's height to the interpolated Z at the
 * nearest point on the segment - a sweep, not point sampling, so a fast
 * rapid-speed cut doesn't leave gaps between samples.
 *
 * @returns {Float32Array} nx*ny cell heights, row-major (x fastest) -
 *   matches THREE.PlaneGeometry's own default vertex ordering directly.
 */
export function buildRoutingHeightmap(moves, {
  nx,
  ny,
  minX,
  minY,
  cellSize,
  topZ = 0,
  floorZ = -1,
  cutterRadiusForMove,
  uptoMoveIndex = moves.length,
  partialProgress = 1
} = {}) {
  const heights = new Float32Array(nx * ny).fill(topZ);

  const applyMove = (move, progress) => {
    if (!move || move.kind === 'rapid') return;
    const radius = cutterRadiusForMove ? cutterRadiusForMove(move) : 0;
    if (!(radius > 0)) return;

    const toX = move.from.x + (move.to.x - move.from.x) * progress;
    const toY = move.from.y + (move.to.y - move.from.y) * progress;
    const toZ = move.from.z + (move.to.z - move.from.z) * progress;
    const fromX = move.from.x;
    const fromY = move.from.y;
    const fromZ = move.from.z;

    const ixStart = Math.max(0, Math.floor((Math.min(fromX, toX) - radius - minX) / cellSize));
    const ixEnd = Math.min(nx - 1, Math.ceil((Math.max(fromX, toX) + radius - minX) / cellSize));
    const iyStart = Math.max(0, Math.floor((Math.min(fromY, toY) - radius - minY) / cellSize));
    const iyEnd = Math.min(ny - 1, Math.ceil((Math.max(fromY, toY) + radius - minY) / cellSize));

    const dx = toX - fromX;
    const dy = toY - fromY;
    const lenSq = dx * dx + dy * dy;

    for (let iy = iyStart; iy <= iyEnd; iy += 1) {
      const cy = minY + (iy + 0.5) * cellSize;
      const rowOffset = iy * nx;
      for (let ix = ixStart; ix <= ixEnd; ix += 1) {
        const cx = minX + (ix + 0.5) * cellSize;
        let t = lenSq > 1e-12 ? ((cx - fromX) * dx + (cy - fromY) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const px = fromX + dx * t;
        const py = fromY + dy * t;
        if (Math.hypot(cx - px, cy - py) > radius) continue;
        const z = Math.max(fromZ + (toZ - fromZ) * t, floorZ);
        const cell = rowOffset + ix;
        if (z < heights[cell]) heights[cell] = z;
      }
    }
  };

  const fullCount = Math.max(0, Math.min(uptoMoveIndex, moves.length));
  for (let m = 0; m < fullCount; m += 1) applyMove(moves[m], 1);
  if (moves[fullCount] && partialProgress > 0) applyMove(moves[fullCount], partialProgress);

  return heights;
}

/**
 * One edge-preserving smoothing pass for the *rendered* routing surface.
 *
 * The heightmap remains the exact per-column material-removal state used by
 * gouge detection. Rendering it with averaged vertex normals, though, makes
 * tiny grid quantization differences read as faceted ridges. Averaging only
 * neighbours that are already nearly coplanar removes that visual noise
 * without blending across a real pocket/profile depth change; those changes
 * are reconstructed as vertical walls by the simulator.
 */
export function smoothRoutingHeightmap(heights, {
  nx,
  ny,
  epsilon = 0.001
} = {}) {
  const smoothed = new Float32Array(heights);
  if (!heights || nx < 2 || ny < 2) return smoothed;

  for (let iy = 0; iy < ny; iy += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const index = iy * nx + ix;
      const center = heights[index];
      let sum = center;
      let count = 1;
      let neighbour;
      if (ix > 0) {
        neighbour = heights[index - 1];
        if (Math.abs(neighbour - center) <= epsilon) { sum += neighbour; count += 1; }
      }
      if (ix + 1 < nx) {
        neighbour = heights[index + 1];
        if (Math.abs(neighbour - center) <= epsilon) { sum += neighbour; count += 1; }
      }
      if (iy > 0) {
        neighbour = heights[index - nx];
        if (Math.abs(neighbour - center) <= epsilon) { sum += neighbour; count += 1; }
      }
      if (iy + 1 < ny) {
        neighbour = heights[index + nx];
        if (Math.abs(neighbour - center) <= epsilon) { sum += neighbour; count += 1; }
      }
      smoothed[index] = sum / count;
    }
  }
  return smoothed;
}

/**
 * Find the internal boundaries between two routing heightmap columns whose
 * heights differ enough to be a machined wall rather than render noise.
 * `axis: 'x'` is a wall on the boundary between adjacent X columns; `axis:
 * 'y'` is the corresponding boundary between Y rows. Consumers can turn
 * these compact records into vertical quads without changing the heightmap
 * contract used by routing gouge detection.
 */
export function findRoutingHeightmapWalls(heights, {
  nx,
  ny,
  epsilon = 0.001
} = {}) {
  const walls = [];
  if (!heights || nx < 2 || ny < 2) return walls;
  const at = (ix, iy) => heights[iy * nx + ix];

  for (let iy = 0; iy < ny; iy += 1) {
    for (let ix = 0; ix < nx - 1; ix += 1) {
      const a = at(ix, iy);
      const b = at(ix + 1, iy);
      if (Math.abs(a - b) > epsilon) walls.push({ axis: 'x', ix, iy, a, b });
    }
  }
  for (let iy = 0; iy < ny - 1; iy += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const a = at(ix, iy);
      const b = at(ix, iy + 1);
      if (Math.abs(a - b) > epsilon) walls.push({ axis: 'y', ix, iy, a, b });
    }
  }
  return walls;
}

/**
 * Tube stock (standard 3-axis router, manual flip between faces - see
 * tubestock.js) geometry model.
 *
 * There's no rotary axis on the real machine - the operator physically
 * flips the tube between faces so a fixed X/Y/Z spindle can reach each one
 * - but animating that flip live is a lot of extra complexity for no real
 * gain in what the sim needs to answer ("did this hole land in the right
 * XYZ spot on the part, at the right depth"). Instead this treats the tube
 * as ONE static
 * solid sitting in its own local frame (X = along tube length, Y = the
 * lengthAxis's `axisA` cross-section direction, Z = its `axisB` direction -
 * see extractTubeFeaturesFromMeshes in stepProfile.js, which this mirrors
 * exactly) and projects every move directly onto/into that solid using its
 * own angleDeg, the same way projectTurningToolpath statically projects
 * diameter-mode moves into a radius-based scene rather than animating a
 * spinning chuck.
 *
 * angleDeg -> local axis convention (matches extractTubeFeaturesFromMeshes'
 * own wall angle assignment exactly - see its own comment):
 *   0deg   -> +Y face (crossSection.a away from center), width runs along Z
 *   90deg  -> +Z face (crossSection.b away from center), width runs along Y
 *   180deg -> -Y face, width along Z
 *   270deg -> -Z face, width along Y
 */

/**
 * Maps one tube-stock move endpoint (lengthPos = machine X, lateralOffset =
 * machine Y, machineZ = machine Z measured outward from the wall's own
 * surface - positive above it, negative plunged into it) into the tube's
 * static local 3D frame, given the wall it's on (angleDeg) and the tube's
 * outer cross-section.
 *
 * @param {number} angleDeg face index angle - snapped to the nearest of
 *   0/90/180/270 (the only angles extractTubeFeaturesFromMeshes emits, but
 *   G-code is text round-tripped through toFixed(1), so exact float
 *   equality can't be assumed).
 * @param {{a:number, b:number}} crossSection outer width along axisA/axisB
 *   (extractTubeFeaturesFromMeshes' own field names).
 * @returns {{x:number, y:number, z:number}}
 */
export function tubeLocalPoint(angleDeg, lengthPos, lateralOffset, machineZ, crossSection) {
  const angle = (((Math.round((Number(angleDeg) || 0) / 90) * 90) % 360) + 360) % 360;
  const a = Number(crossSection?.a) || 0;
  const b = Number(crossSection?.b) || 0;
  let y = 0;
  let z = 0;
  if (angle === 0 || angle === 180) {
    const sign = angle === 0 ? 1 : -1;
    y = sign * (a / 2 + machineZ);
    z = lateralOffset;
  } else {
    const sign = angle === 90 ? 1 : -1;
    z = sign * (b / 2 + machineZ);
    y = lateralOffset;
  }
  return { x: lengthPos, y, z };
}

/**
 * Unit outward normal (in the tube's static local frame) of the wall at
 * angleDeg - the direction a drill on that wall plunges against. Shares
 * tubeLocalPoint's own angle-snapping so the two can never disagree about
 * which wall a given angleDeg means.
 */
export function tubeWallNormal(angleDeg) {
  const angle = (((Math.round((Number(angleDeg) || 0) / 90) * 90) % 360) + 360) % 360;
  if (angle === 0) return { x: 0, y: 1, z: 0 };
  if (angle === 180) return { x: 0, y: -1, z: 0 };
  if (angle === 90) return { x: 0, y: 0, z: 1 };
  return { x: 0, y: 0, z: -1 }; // 270
}

/**
 * Projects parseToolpath3D's raw tubestock moves (machine X/Y/Z, tagged
 * with angleDeg per parseToolpath3D's own A-tracking) into the tube's
 * static local 3D scene via tubeLocalPoint. One-to-one, order-preserving
 * (like projectTurningToolpath) so a move's index is stable across both the
 * raw and projected arrays - matchTubestockHolesToMoves relies on this to
 * join a drilled hole (matched by raw X/Y/angleDeg) back to its position in
 * the projected/rendered move list.
 */
export function projectTubestockToolpath(parsed, { crossSection } = {}) {
  let totalDistance = 0;
  const moves = (parsed?.moves || []).map((move) => {
    const from = tubeLocalPoint(move.angleDeg, move.from.x, move.from.y, move.from.z, crossSection);
    const to = tubeLocalPoint(move.angleDeg, move.to.x, move.to.y, move.to.z, crossSection);
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const projected = { ...move, from, to, length, startDistance: totalDistance };
    totalDistance += length;
    return projected;
  });

  const toolChangeIndices = (parsed?.toolChangeIndices || []).filter((index) => index < moves.length);
  return { moves, toolChangeIndices, totalDistance };
}

// Real drill diameter tolerance for matching a G-code plunge move back to
// the hole record (from extractTubeFeaturesFromMeshes) it drills - both are
// fmt()'d to 4 decimals in tubestock.js, so float noise is negligible; this
// only needs to be tight enough to not confuse two holes at nearly the same
// position on the same wall.
const HOLE_MATCH_TOLERANCE = 0.001;

/**
 * Joins each hole in `walls` (extractTubeFeaturesFromMeshes' own shape,
 * echoed into generateTubestockGcode's stats) to the raw (pre-projection)
 * move that drills it - the G01 plunge move whose angleDeg/X/Y match the
 * hole's own angleDeg/position/lateralOffset. Used to progressively reveal
 * each hole as playback reaches its plunge move, the same "has this move
 * happened yet" pattern buildRoutingHeightmap/buildTurningStockProfile use.
 *
 * @param {Array} walls tubeFeatures.walls (or stats.walls) shape
 * @param {Array} rawMoves parseToolpath3D's own moves (NOT
 *   projectTubestockToolpath's output - matching needs the original
 *   machine X/Y, which the local-frame projection overwrites)
 * @returns {Array<{angleDeg, position, lateralOffset, diameter, moveIndex, fullDepth}>}
 *   moveIndex is -1 when no matching plunge move was found (a stale
 *   walls/gcode pairing from before this feature, or a rounding mismatch) -
 *   rendered as always-drilled rather than silently dropped, since hiding a
 *   real hole is worse than showing it a moment early.
 */
export function matchTubestockHolesToMoves(walls, rawMoves) {
  const result = [];
  for (const wall of walls || []) {
    for (const hole of wall.holes || []) {
      let moveIndex = -1;
      let fullDepth = 0;
      for (let i = 0; i < (rawMoves || []).length; i += 1) {
        const move = rawMoves[i];
        if (move.kind !== 'ramp') continue; // only a downward plunge drills
        const angle = (((Math.round((Number(move.angleDeg) || 0) / 90) * 90) % 360) + 360) % 360;
        const wallAngle = (((Math.round((Number(wall.angleDeg) || 0) / 90) * 90) % 360) + 360) % 360;
        if (angle !== wallAngle) continue;
        if (Math.abs(move.to.x - hole.position) > HOLE_MATCH_TOLERANCE) continue;
        if (Math.abs(move.to.y - hole.lateralOffset) > HOLE_MATCH_TOLERANCE) continue;
        moveIndex = i;
        fullDepth = Math.max(0, -move.to.z);
        break;
      }
      result.push({
        angleDeg: wall.angleDeg,
        position: hole.position,
        lateralOffset: hole.lateralOffset,
        diameter: hole.diameter,
        moveIndex,
        fullDepth
      });
    }
  }
  return result;
}
