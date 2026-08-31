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
  let cur = { x: null, y: null, z: null };
  let motion = null; // 0 rapid, 1 feed, 2 arc CW, 3 arc CCW

  // An axis never commanded stays at 0, the way a machine sits at its origin
  // until told otherwise. This matters for turning, which uses X/Z and never
  // mentions Y - gating on "we know X and Y" would emit nothing at all for a
  // whole turning program.
  const at = (point) => ({ x: point.x ?? 0, y: point.y ?? 0, z: point.z ?? 0 });

  const push = (rawFrom, rawTo, kind) => {
    const from = at(rawFrom);
    const to = at(rawTo);
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    if (!(length > 0)) return; // a repeated coordinate is not a move
    moves.push({ from, to, kind, toolIndex, length, startDistance: totalDistance });
    totalDistance += length;
  };

  for (const rawLine of (gcode || '').split('\n')) {
    if (/\(TOOL CHANGE:/i.test(rawLine)) {
      toolIndex += 1;
      toolChangeIndices.push(moves.length);
    }

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

    if (xWord === null && yWord === null && zWord === null) continue;
    if (motion === null) continue; // no motion mode established yet

    const axis = (word, prev) => {
      if (word === null) return prev;
      if (!incremental || prev === null) return word;
      return prev + word;
    };
    const next = {
      x: axis(xWord, cur.x),
      y: axis(yWord, cur.y),
      z: axis(zWord, cur.z)
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
        push(previous, point, classify(previous, point, motion));
        previous = point;
      }
    } else {
      push({ ...cur }, { ...next }, classify(cur, next, motion));
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
