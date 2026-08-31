import { describe, expect, it } from 'vitest';
import {
  parseGcodeToolpath,
  parseToolpath3D,
  projectTurningToolpath,
  toolpathPositionAtDistance,
  toolpathBounds,
  toolpathBounds3D,
  buildTurningStockProfile,
  turningProfileToLathePoints,
  buildRoutingHeightmap
} from './toolpathPreview.js';
import { generateRoutingGcode } from './routing.js';
import { generateTurningGcode, stockEnvelopeRadius } from './turning.js';

const gcode = (...lines) => lines.join('\n');

// Distance of a point from a circle centre - the invariant every arc point
// must satisfy, and the thing a wrong sweep or centre breaks first.
const radiusFrom = (point, cx, cy) => Math.hypot(point.x - cx, point.y - cy);

describe('parseToolpath3D - linear moves', () => {
  it('keeps Z, which the 2D projection throws away', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z1', 'G01 X0 Y0 Z-0.25'));
    expect(moves).toHaveLength(1);
    expect(moves[0].from.z).toBe(1);
    expect(moves[0].to.z).toBe(-0.25);
  });

  it('measures length in three dimensions', () => {
    const { moves, totalDistance } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G01 X3 Y4 Z0'));
    expect(moves[0].length).toBeCloseTo(5, 10);
    expect(totalDistance).toBeCloseTo(5, 10);
  });

  it('carries a running start distance so a scrubber can seek by distance', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G01 X1 Y0', 'G01 X1 Y2'));
    expect(moves.map((m) => m.startDistance)).toEqual([0, 1]);
    expect(moves[1].length).toBeCloseTo(2, 10);
  });

  it('interpolates a cutter position from cumulative distance', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G01 X2 Y0 Z0', 'G01 X2 Y2 Z-2'));
    expect(toolpathPositionAtDistance(moves, 1)).toMatchObject({
      moveIndex: 0,
      position: { x: 1, y: 0, z: 0 }
    });
    const halfwayDown = toolpathPositionAtDistance(moves, 3);
    expect(halfwayDown?.moveIndex).toBe(1);
    expect(halfwayDown?.position.x).toBe(2);
    expect(halfwayDown?.position.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(halfwayDown?.position.z).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('clamps a cutter position to the first and final toolpath points', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G01 X1 Y0 Z0'));
    expect(toolpathPositionAtDistance(moves, -5)?.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(toolpathPositionAtDistance(moves, 99)?.position).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('honours modal motion on a bare coordinate line', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G01 X1 Y0', 'X2 Y0'));
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.kind !== 'rapid')).toBe(true);
  });

  it('drops repeated coordinates rather than emitting zero-length moves', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G01 X1 Y1', 'G01 X1 Y1'));
    expect(moves).toHaveLength(1);
  });

  it('ignores comments, line numbers and program markers', () => {
    const { moves } = parseToolpath3D(gcode('%', 'O1000', '(a comment X9 Y9)', 'G00 X0 Y0 Z0', 'G01 X1 Y0'));
    expect(moves).toHaveLength(1);
    expect(moves[0].to.x).toBe(1);
  });

  it('supports incremental mode', () => {
    const { moves } = parseToolpath3D(gcode('G90', 'G00 X1 Y1 Z0', 'G91', 'G01 X2 Y0'));
    expect(moves[0].to.x).toBe(3);
  });
});

describe('projectTurningToolpath', () => {
  it('maps machine Z to the spindle axis and diameter-mode X to radius', () => {
    const parsed = parseToolpath3D(gcode('G00 X1.0 Z0.1', 'G01 X0.5 Z-2.0'));
    const projected = projectTurningToolpath(parsed);
    expect(projected.moves[0].from).toEqual({ x: 0.1, y: 0.5, z: 0 });
    expect(projected.moves[0].to).toEqual({ x: -2, y: 0.25, z: 0 });
  });

  it('recomputes distance in the projected radius coordinate system', () => {
    const projected = projectTurningToolpath(parseToolpath3D(gcode('G00 X2 Z0', 'G01 X0 Z0')));
    expect(projected.totalDistance).toBe(1);
    expect(projected.moves[0].length).toBe(1);
  });

  it('treats every feed as a cut and preserves tool changes', () => {
    const projected = projectTurningToolpath(parseToolpath3D(gcode(
      'G00 X1 Z0', 'G01 X1 Z-1',
      'M00 (TOOL CHANGE: finish insert)',
      'G01 X0.5 Z-2'
    )));
    expect(projected.moves.map((move) => move.kind)).toEqual(['cut', 'cut']);
    expect(projected.toolChangeIndices).toEqual([1]);
    expect(projected.moves[1].toolIndex).toBe(1);
  });
});

describe('parseToolpath3D - move classification', () => {
  it('calls G0 a rapid', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z1', 'G00 X5 Y0 Z1'));
    expect(moves[0].kind).toBe('rapid');
  });

  it('calls a descending feed a ramp, matching how Fusion colours a plunge', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G01 X1 Y0 Z-0.1'));
    expect(moves[0].kind).toBe('ramp');
  });

  it('calls a level feed a cut', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z-0.1', 'G01 X1 Y0 Z-0.1'));
    expect(moves[0].kind).toBe('cut');
  });

  it('tags moves with the tool that made them and records the change points', () => {
    const { moves, toolChangeIndices } = parseToolpath3D(gcode(
      'G00 X0 Y0 Z0', 'G01 X1 Y0',
      'M00 (TOOL CHANGE: load 0.25" tool)',
      'G01 X2 Y0'
    ));
    expect(moves.map((m) => m.toolIndex)).toEqual([0, 1]);
    expect(toolChangeIndices).toEqual([1]);
  });
});

describe('parseToolpath3D - arcs', () => {
  // These are the moves routing.js actually emits for holes and circular
  // bosses. The parser previously ignored them outright.
  it('tessellates an I/J arc onto the true circle', () => {
    const { moves } = parseToolpath3D(gcode('G00 X1 Y0 Z0', 'G03 X-1 Y0 I-1 J0'));
    expect(moves.length).toBeGreaterThan(8);
    for (const move of moves) {
      expect(radiusFrom(move.to, 0, 0)).toBeCloseTo(1, 6);
    }
  });

  it('sweeps counter-clockwise for G03 and clockwise for G02', () => {
    const ccw = parseToolpath3D(gcode('G00 X1 Y0 Z0', 'G03 X0 Y1 I-1 J0')).moves;
    const cw = parseToolpath3D(gcode('G00 X1 Y0 Z0', 'G02 X0 Y1 I-1 J0')).moves;
    // Both end at the same place, but the CCW quarter-turn stays in +Y while
    // the CW one takes the long way round through -Y.
    expect(ccw.every((m) => m.to.y >= -1e-9)).toBe(true);
    expect(cw.some((m) => m.to.y < 0)).toBe(true);
    expect(cw.length).toBeGreaterThan(ccw.length);
  });

  it('treats a start-equals-end arc as a full circle, not a no-op', () => {
    // routing.js emits exactly this for a circular contour. Reading it as a
    // zero-length move would erase every hole in the program.
    const { moves } = parseToolpath3D(gcode('G00 X1 Y0 Z0', 'G03 X1 Y0 I-1 J0'));
    expect(moves.length).toBeGreaterThan(8);
    const swept = moves.reduce((sum, m) => sum + m.length, 0);
    expect(swept).toBeCloseTo(2 * Math.PI, 1);
  });

  it('interpolates Z through an arc so a helix comes out as a helix', () => {
    const { moves } = parseToolpath3D(gcode('G00 X1 Y0 Z0', 'G03 X1 Y0 Z-0.1 I-1 J0'));
    const depths = moves.map((m) => m.to.z);
    expect(depths[depths.length - 1]).toBeCloseTo(-0.1, 10);
    // Monotonic descent - never bobbing back up mid-helix.
    for (let i = 1; i < depths.length; i += 1) {
      expect(depths[i]).toBeLessThanOrEqual(depths[i - 1] + 1e-12);
    }
  });

  it('lands exactly on the commanded endpoint, so moves chain without gaps', () => {
    const { moves } = parseToolpath3D(gcode('G00 X1 Y0 Z0', 'G03 X0 Y1 I-1 J0'));
    const last = moves[moves.length - 1].to;
    expect(last.x).toBeCloseTo(0, 12);
    expect(last.y).toBeCloseTo(1, 12);
  });

  it('subdivides a larger arc more finely to hold chord tolerance', () => {
    const small = parseToolpath3D(gcode('G00 X0.1 Y0 Z0', 'G03 X0.1 Y0 I-0.1 J0')).moves.length;
    const large = parseToolpath3D(gcode('G00 X5 Y0 Z0', 'G03 X5 Y0 I-5 J0')).moves.length;
    expect(large).toBeGreaterThan(small);
  });

  it('supports the R form, choosing minor vs major arc by sign', () => {
    // Radius must exceed half the chord for the two arcs to differ at all -
    // at exactly half, both are the same semicircle.
    const minor = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G03 X2 Y0 R2')).moves;
    const major = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G03 X2 Y0 R-2')).moves;
    const sweep = (moves) => moves.reduce((sum, m) => sum + m.length, 0);
    // Same circle either way, so every point sits at radius 2 from a centre
    // on the chord's perpendicular bisector.
    expect(sweep(major)).toBeGreaterThan(sweep(minor));
    expect(sweep(minor) + sweep(major)).toBeCloseTo(2 * Math.PI * 2, 1);
  });

  it('degrades an impossible R arc to a straight move instead of NaN', () => {
    // No circle of radius 0.1 reaches two points 4 apart.
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G03 X4 Y0 R0.1'));
    expect(moves).toHaveLength(1);
    expect(moves[0].to.x).toBe(4);
    expect(Number.isFinite(moves[0].length)).toBe(true);
  });

  it('never emits NaN coordinates for a degenerate arc', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z0', 'G02 X0 Y0 I0 J0'));
    for (const move of moves) {
      expect(Number.isFinite(move.to.x) && Number.isFinite(move.to.y)).toBe(true);
    }
  });
});

describe('parseGcodeToolpath - the 2D preview keeps working', () => {
  it('still returns its established {a,b} contract', () => {
    const segments = parseGcodeToolpath(gcode('G00 X0 Y0 Z0', 'G01 X1 Y2'), 'routing');
    expect(segments).toEqual([
      { from: { a: 0, b: 0 }, to: { a: 1, b: 2 }, rapid: false, toolIndex: 0 }
    ]);
  });

  it('marks rapids', () => {
    const segments = parseGcodeToolpath(gcode('G00 X0 Y0 Z0', 'G00 X1 Y0'), 'routing');
    expect(segments[0].rapid).toBe(true);
  });

  it('converts turning X from diameter to radius', () => {
    const segments = parseGcodeToolpath(gcode('G00 X2 Z0', 'G01 X1 Z-1'), 'turning');
    expect(segments[0].from).toEqual({ a: 0, b: 1 });
    expect(segments[0].to).toEqual({ a: -1, b: 0.5 });
  });

  it('now shows arc geometry it used to omit entirely', () => {
    // The regression this whole change exists for: a hole cut with G02/G03
    // previously produced no segments at all.
    const segments = parseGcodeToolpath(gcode('G00 X1 Y0 Z0', 'G03 X1 Y0 I-1 J0'), 'routing');
    expect(segments.length).toBeGreaterThan(8);
  });
});

describe('bounds', () => {
  it('frames 2D segments', () => {
    const segments = parseGcodeToolpath(gcode('G00 X0 Y0 Z0', 'G01 X3 Y4'), 'routing');
    expect(toolpathBounds(segments)).toEqual({ minA: 0, maxA: 3, minB: 0, maxB: 4 });
  });

  it('falls back to a unit box when there is nothing to frame', () => {
    expect(toolpathBounds([])).toEqual({ minA: 0, maxA: 1, minB: 0, maxB: 1 });
    expect(toolpathBounds3D([])).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } });
  });

  it('frames 3D moves including depth', () => {
    const { moves } = parseToolpath3D(gcode('G00 X0 Y0 Z1', 'G01 X2 Y3 Z-0.5'));
    const { min, max } = toolpathBounds3D(moves);
    expect(min).toEqual({ x: 0, y: 0, z: -0.5 });
    expect(max).toEqual({ x: 2, y: 3, z: 1 });
  });
});

describe('against real generated G-code', () => {
  // Parsing hand-written G-code proves the interpreter; parsing routing.js's
  // own output proves the two agree about what it emits.
  const square = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  const circle = [];
  for (let step = 0; step < 64; step += 1) {
    const angle = (Math.PI * 2 * step) / 64;
    circle.push({ x: 2 + 0.4 * Math.cos(angle), y: 2 + 0.4 * Math.sin(angle) });
  }

  const program = generateRoutingGcode(
    [
      { points: square, isHole: false },
      { points: circle, isHole: true }
    ],
    { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.125 }
  );
  const text = typeof program === 'string' ? program : (program?.gcode ?? '');

  it('produces a parseable program', () => {
    expect(text.length).toBeGreaterThan(0);
    const { moves } = parseToolpath3D(text);
    expect(moves.length).toBeGreaterThan(20);
  });

  it('finds every kind of move a router makes', () => {
    const kinds = new Set(parseToolpath3D(text).moves.map((m) => m.kind));
    expect(kinds.has('rapid')).toBe(true);
    expect(kinds.has('cut')).toBe(true);
  });

  it('never produces a NaN coordinate anywhere in a real program', () => {
    for (const move of parseToolpath3D(text).moves) {
      for (const point of [move.from, move.to]) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(Number.isFinite(point.z)).toBe(true);
      }
      expect(Number.isFinite(move.length)).toBe(true);
    }
  });

  it('cuts to the requested depth and no deeper', () => {
    const { min } = toolpathBounds3D(parseToolpath3D(text).moves);
    expect(min.z).toBeCloseTo(-0.5, 3);
  });
});

describe('buildTurningStockProfile', () => {
  it('with no moves executed, the outer profile is the initial (uncut) radius everywhere and there is no bore', () => {
    const { axial, outer, inner } = buildTurningStockProfile([], {
      samples: 10, axialMin: -2, axialMax: 0, initialOuterRadius: 0.5, uptoMoveIndex: 0, partialProgress: 0
    });
    expect(axial.length).toBe(10);
    expect(Array.from(outer).every((r) => r === 0.5)).toBe(true);
    expect(Array.from(inner).every((r) => r === 0)).toBe(true);
  });

  it('a cutting move lowers the outer profile only within the axial range it sweeps', () => {
    const moves = [{ kind: 'cut', from: { x: -2, y: 0.5 }, to: { x: -1, y: 0.3 } }];
    const { outer } = buildTurningStockProfile(moves, {
      samples: 21, axialMin: -2, axialMax: 0, initialOuterRadius: 0.5, uptoMoveIndex: 1
    });
    // axial step is 0.1: index 0 = -2 (move start), 5 = -1.5 (midpoint),
    // 10 = -1 (move end), 20 = 0 (past the move's near end - never swept)
    expect(outer[0]).toBeCloseTo(0.5, 5);
    expect(outer[5]).toBeCloseTo(0.4, 5);
    expect(outer[10]).toBeCloseTo(0.3, 5);
    expect(outer[20]).toBeCloseTo(0.5, 5);
  });

  it('ignores rapid moves - they do not cut', () => {
    const moves = [{ kind: 'rapid', from: { x: -2, y: 0.6 }, to: { x: -1, y: 0.6 } }];
    const { outer } = buildTurningStockProfile(moves, {
      samples: 5, axialMin: -2, axialMax: 0, initialOuterRadius: 0.5, uptoMoveIndex: 1
    });
    expect(Array.from(outer).every((r) => r === 0.5)).toBe(true);
  });

  it('a centerline move (both endpoints at radius 0) cuts a bore, raising inner but never touching outer', () => {
    const moves = [{ kind: 'cut', from: { x: -1, y: 0 }, to: { x: 0, y: 0 } }];
    const { axial, outer, inner } = buildTurningStockProfile(moves, {
      samples: 11, axialMin: -2, axialMax: 0, initialOuterRadius: 0.5, drillRadius: 0.1, uptoMoveIndex: 1
    });
    expect(Array.from(outer).every((r) => r === 0.5)).toBe(true);
    for (let i = 0; i < axial.length; i += 1) {
      if (axial[i] >= -1 - 1e-6) expect(inner[i]).toBeCloseTo(0.1, 5);
      else expect(inner[i]).toBe(0);
    }
  });

  it('applies partial progress on the in-progress move only, not the moves after it', () => {
    const moves = [
      { kind: 'cut', from: { x: -2, y: 0.5 }, to: { x: -1, y: 0.5 } },
      { kind: 'cut', from: { x: -1, y: 0.5 }, to: { x: 0, y: 0.2 } }
    ];
    const full = buildTurningStockProfile(moves, { samples: 11, axialMin: -2, axialMax: 0, initialOuterRadius: 0.5, uptoMoveIndex: 2 });
    const half = buildTurningStockProfile(moves, { samples: 11, axialMin: -2, axialMax: 0, initialOuterRadius: 0.5, uptoMoveIndex: 1, partialProgress: 0.5 });
    expect(full.outer[10]).toBeCloseTo(0.2, 5); // fully cut to the far end
    expect(half.outer[10]).toBeCloseTo(0.5, 5); // partial move only reached -0.5, never got here
    expect(half.outer[7]).toBeCloseTo(0.38, 2); // within the partially-swept range
  });

  it('against real generated G-code: after the full program, the outer profile matches the finished (constant-radius) part', () => {
    const profile = [{ z: 0, x: 0.4 }, { z: 2, x: 0.4 }];
    const params = { stockDiameter: 0.9, stepDown: 0.05, finishAllowance: 0.02, feedRough: 0.008, feedFinish: 0.004 };
    const { gcode: programText } = generateTurningGcode(profile, params);
    const projected = projectTurningToolpath(parseToolpath3D(programText));
    // Clamp to <= 0: Z=0 is always the face (turning.js's own normalization
    // convention) and nothing physically exists past it - the finishing
    // pass's approach move rapids to X0 then cuts to the first profile
    // point, which technically sweeps through Z>0 (empty clearance air, not
    // real stock); sampling out that far would pick up that artifact.
    const axialMin = Math.min(...projected.moves.flatMap((m) => [m.from.x, m.to.x]));
    const { outer } = buildTurningStockProfile(projected.moves, {
      samples: 50,
      axialMin,
      axialMax: 0,
      initialOuterRadius: stockEnvelopeRadius(params.stockDiameter, 'round'),
      uptoMoveIndex: projected.moves.length
    });
    for (const r of outer) expect(r).toBeCloseTo(0.4, 2);
  });
});

describe('turningProfileToLathePoints', () => {
  // Plain arrays here (not Float32Array) so the expected values in these
  // tests can compare exactly - the function itself doesn't care which kind
  // of array it's given, it only indexes into them.
  it('with no bore, returns the outer wall only, one point per sample, in order', () => {
    const axial = [-2, -1, 0];
    const outer = [0.5, 0.4, 0.4];
    const inner = [0, 0, 0];
    const points = turningProfileToLathePoints(axial, outer, inner);
    expect(points.length).toBe(3);
    expect(points[0]).toEqual([0.5, -2]);
    expect(points[2]).toEqual([0.4, 0]);
  });

  it('with a bore touching the face end, closes a loop tracing outer wall, face annulus, bore wall, and hole bottom', () => {
    const axial = [-2, -1, 0];
    const outer = [0.5, 0.5, 0.5];
    const inner = [0, 0.1, 0.1];
    const points = turningProfileToLathePoints(axial, outer, inner);
    expect(points[0][1]).toBe(-2); // starts at the far end, on axis
    expect(points[0][0]).toBeLessThan(0.01);
    expect(points[points.length - 1]).toEqual(points[0]); // closes the loop
    expect(points.some((p) => Math.abs(p[0] - 0.1) < 1e-6)).toBe(true); // traces the bore wall
  });

  it('clamps radius at a small positive epsilon rather than exactly 0, avoiding degenerate geometry', () => {
    const axial = [-1, 0];
    const outer = [0, 0];
    const inner = [0, 0];
    const points = turningProfileToLathePoints(axial, outer, inner);
    expect(points.every((p) => p[0] > 0)).toBe(true);
  });
});

describe('buildRoutingHeightmap', () => {
  const gridOpts = { nx: 5, ny: 5, minX: 0, minY: 0, cellSize: 1, topZ: 0, floorZ: -1 };

  it('with no moves executed, every cell stays at the top surface (topZ)', () => {
    const heights = buildRoutingHeightmap([], { ...gridOpts, cutterRadiusForMove: () => 0.25, uptoMoveIndex: 0 });
    expect(Array.from(heights).every((h) => h === 0)).toBe(true);
  });

  it('a cutting move lowers only the cells its capsule (segment + cutter radius) actually sweeps', () => {
    const moves = [{ kind: 'cut', from: { x: 1, y: 2.5, z: -0.1 }, to: { x: 4, y: 2.5, z: -0.1 } }];
    const heights = buildRoutingHeightmap(moves, { ...gridOpts, cutterRadiusForMove: () => 0.6, uptoMoveIndex: 1 });
    for (let iy = 0; iy < 5; iy += 1) {
      for (let ix = 0; ix < 5; ix += 1) {
        const expected = iy === 2 ? -0.1 : 0;
        expect(heights[iy * 5 + ix]).toBeCloseTo(expected, 5);
      }
    }
  });

  it('ignores rapid moves - they do not cut', () => {
    const moves = [{ kind: 'rapid', from: { x: 1, y: 2.5, z: -0.5 }, to: { x: 4, y: 2.5, z: -0.5 } }];
    const heights = buildRoutingHeightmap(moves, { ...gridOpts, cutterRadiusForMove: () => 0.6, uptoMoveIndex: 1 });
    expect(Array.from(heights).every((h) => h === 0)).toBe(true);
  });

  it('skips a move with no resolvable cutter radius (e.g. an unset tool)', () => {
    const moves = [{ kind: 'cut', from: { x: 1, y: 2.5, z: -0.5 }, to: { x: 4, y: 2.5, z: -0.5 } }];
    const heights = buildRoutingHeightmap(moves, { ...gridOpts, cutterRadiusForMove: () => 0, uptoMoveIndex: 1 });
    expect(Array.from(heights).every((h) => h === 0)).toBe(true);
  });

  it('clamps a cut deeper than floorZ - never renders through the stock', () => {
    const moves = [{ kind: 'cut', from: { x: 1, y: 2.5, z: -5 }, to: { x: 4, y: 2.5, z: -5 } }];
    const heights = buildRoutingHeightmap(moves, { ...gridOpts, cutterRadiusForMove: () => 0.6, uptoMoveIndex: 1 });
    expect(heights[2 * 5 + 2]).toBe(-1);
  });

  it('a later, shallower move never raises a cell back up - only the deepest cut at each cell wins', () => {
    const moves = [
      { kind: 'cut', from: { x: 1, y: 2.5, z: -0.5 }, to: { x: 4, y: 2.5, z: -0.5 } },
      { kind: 'cut', from: { x: 1, y: 2.5, z: -0.1 }, to: { x: 4, y: 2.5, z: -0.1 } }
    ];
    const heights = buildRoutingHeightmap(moves, { ...gridOpts, cutterRadiusForMove: () => 0.6, uptoMoveIndex: 2 });
    expect(heights[2 * 5 + 2]).toBeCloseTo(-0.5, 5);
  });

  it('applies partial progress on the in-progress move only', () => {
    const moves = [{ kind: 'cut', from: { x: 0, y: 2.5, z: -0.4 }, to: { x: 4, y: 2.5, z: -0.4 } }];
    const half = buildRoutingHeightmap(moves, { ...gridOpts, cutterRadiusForMove: () => 0.55, uptoMoveIndex: 0, partialProgress: 0.5 });
    expect(half[2 * 5 + 4]).toBe(0); // far column - never reached at half progress
    expect(half[2 * 5 + 0]).toBeCloseTo(-0.4, 5);
  });

  it('against real generated G-code: cuts reach the programmed depth somewhere along the toolpath', () => {
    const contour = [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], isHole: false }];
    const { gcode: programText } = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.2, stepDown: 0.2 });
    const { moves } = parseToolpath3D(programText);
    const minX = Math.min(...moves.flatMap((m) => [m.from.x, m.to.x])) - 0.2;
    const minY = Math.min(...moves.flatMap((m) => [m.from.y, m.to.y])) - 0.2;
    const maxX = Math.max(...moves.flatMap((m) => [m.from.x, m.to.x])) + 0.2;
    const maxY = Math.max(...moves.flatMap((m) => [m.from.y, m.to.y])) + 0.2;
    const cellSize = 0.05;
    const nx = Math.round((maxX - minX) / cellSize) + 1;
    const ny = Math.round((maxY - minY) / cellSize) + 1;
    const heights = buildRoutingHeightmap(moves, {
      nx, ny, minX, minY, cellSize, topZ: 0, floorZ: -0.3,
      cutterRadiusForMove: () => 0.125,
      uptoMoveIndex: moves.length
    });
    expect(Math.min(...heights)).toBeCloseTo(-0.2, 2);
  });
});
