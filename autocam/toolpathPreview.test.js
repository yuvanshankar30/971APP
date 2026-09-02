import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  buildTurningStockRings,
  buildRoutingHeightmap,
  inferRoutingEdgeShift,
  estimateMachiningTime,
  formatMachiningTime,
  smoothRoutingHeightmap,
  findRoutingHeightmapWalls,
  tubeLocalPoint,
  tubeWallNormal,
  projectTubestockToolpath,
  matchTubestockHolesToMoves
} from './toolpathPreview.js';
import { generateRoutingGcode } from './routing.js';
import { generateTurningGcode, stockEnvelopeRadius } from './turning.js';
import { generateTubestockGcode } from './tubestock.js';
import { readStepMeshes, extractTubeFeaturesFromMeshes } from './stepProfile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUBE_05X05_SQUARE = path.join(__dirname, '__fixtures__', 'tube-05x05-square.step');

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

describe('buildTurningStockRings (hex stock rendered exactly, not the across-corners-circle approximation)', () => {
  const angularSegments = 24; // multiple of 12, so 0deg/30deg land exactly on sample points
  const ringSize = angularSegments + 1;
  const acrossFlatsRadius = 0.5;

  function ringRadii(position, ringIndex) {
    const radii = [];
    for (let a = 0; a < ringSize; a += 1) {
      const base = (ringIndex * ringSize + a) * 3;
      radii.push(Math.hypot(position[base + 1], position[base + 2]));
    }
    return radii;
  }

  it('an uncut hex ring shows the true hex cross-section: corners (theta=0,60,...) at the across-corners radius, flats (theta=30,90,...) at acrossFlatsRadius', () => {
    const acrossCorners = acrossFlatsRadius * (2 / Math.sqrt(3));
    const axial = [0, -1];
    // "Uncut" means outer still sits at the initial envelope - across
    // CORNERS for hex stock (stockEnvelopeRadius('hex'), what
    // buildTurningStockProfile actually initializes to), not across flats.
    const outer = [acrossCorners, acrossCorners];
    const { position } = buildTurningStockRings(axial, outer, { angularSegments, stockShape: 'hex', acrossFlatsRadius });
    const radii = ringRadii(position, 0);

    expect(radii[0]).toBeCloseTo(acrossCorners, 4); // theta=0deg - a corner
    const flatIndex = angularSegments / 12; // theta=30deg - a flat center
    expect(radii[flatIndex]).toBeCloseTo(acrossFlatsRadius, 4);
    // no vertex ever exceeds the true envelope
    expect(Math.max(...radii)).toBeLessThanOrEqual(acrossCorners + 1e-6);
  });

  it('once a ring is cut below the hex\'s own across-flats radius, it becomes a perfect circle - a lathe tool commands one radius uniformly around the full revolution, it cannot leave the corners standing once it reaches the flats', () => {
    const axial = [0];
    const outer = [0.3]; // well below acrossFlatsRadius (0.5) - fully round now
    const { position } = buildTurningStockRings(axial, outer, { angularSegments, stockShape: 'hex', acrossFlatsRadius });
    const radii = ringRadii(position, 0);
    for (const r of radii) expect(r).toBeCloseTo(0.3, 5);
  });

  it('round stock ignores the hex formula entirely - every angle at the same radius', () => {
    const axial = [0];
    const outer = [0.5];
    const { position } = buildTurningStockRings(axial, outer, { angularSegments, stockShape: 'round' });
    const radii = ringRadii(position, 0);
    for (const r of radii) expect(r).toBeCloseTo(0.5, 5);
  });

  it('produces the expected vertex/index counts for a well-formed triangle mesh', () => {
    const axial = [0, -1, -2];
    const outer = [0.5, 0.4, 0.3];
    const segs = 8;
    const { position, index } = buildTurningStockRings(axial, outer, { angularSegments: segs, stockShape: 'round' });
    expect(position.length).toBe(axial.length * (segs + 1) * 3);
    expect(index.length).toBe((axial.length - 1) * segs * 6);
    expect(Math.max(...index)).toBeLessThan(position.length / 3);
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

  it('keeps a pocket depth discontinuity sharp while smoothing only near-coplanar render noise', () => {
    const raw = new Float32Array([
      0, -0.0004, -0.2,
      0, 0.0004, -0.2,
      0, 0, -0.2
    ]);
    const smoothed = smoothRoutingHeightmap(raw, { nx: 3, ny: 3, epsilon: 0.001 });
    expect(Math.abs(smoothed[0])).toBeLessThan(0.001);
    expect(Math.abs(smoothed[1])).toBeLessThan(0.001);
    // The pocket floor must not get blended toward uncut stock.
    expect(smoothed[2]).toBeCloseTo(-0.2, 5);
    expect(smoothed[5]).toBeCloseTo(-0.2, 5);
  });

  it('finds every internal edge of a rectangular pocket as a wall, without flagging coplanar cells', () => {
    const heights = new Float32Array([
      0, 0, 0, 0,
      0, -0.25, -0.25, 0,
      0, -0.25, -0.25, 0,
      0, 0, 0, 0
    ]);
    const walls = findRoutingHeightmapWalls(heights, { nx: 4, ny: 4, epsilon: 0.001 });
    expect(walls).toHaveLength(8);
    expect(walls.every((wall) => Math.abs(wall.a - wall.b) > 0.001)).toBe(true);
    expect(walls.filter((wall) => wall.axis === 'x')).toHaveLength(4);
    expect(walls.filter((wall) => wall.axis === 'y')).toHaveLength(4);
  });
});

describe('parseToolpath3D - tube stock A-axis tracking', () => {
  it('tags each move with the angleDeg in effect at the time, including across an A-only indexing line that commands no X/Y/Z', () => {
    const program = gcode(
      'G20',
      'G90',
      'S8000 M03',
      'G00 A0 (index rotary axis to this wall)',
      'G00 X1.0 Y0.0',
      'G00 Z0.25',
      'G01 Z-0.15 F8',
      'G00 Z0.25',
      'G00 A90 (index rotary axis to this wall)',
      'G00 X2.0 Y0.1',
      'G00 Z0.25',
      'G01 Z-0.15 F8'
    );
    const { moves } = parseToolpath3D(program);
    const firstPlunge = moves.find((m) => m.kind === 'ramp' && m.to.x === 1);
    const secondPlunge = moves.find((m) => m.kind === 'ramp' && m.to.x === 2);
    expect(firstPlunge.angleDeg).toBe(0);
    expect(secondPlunge.angleDeg).toBe(90);
  });

  it('tags each move using the newer (FACE A..) comment tag - no real rotary axis, so no live A word is ever commanded', () => {
    const program = gcode(
      'G20',
      'G90',
      'S8000 M03',
      '(FACE A0 - FLIP TUBE to Top face and RE-ZERO Z before resuming - no rotary axis on this machine)',
      'M00 (FLIP TUBE to Top face (0.0 deg from Top) and RE-ZERO Z before resuming - no rotary axis on this machine)',
      'G00 X1.0 Y0.0',
      'G00 Z0.25',
      'G01 Z-0.15 F8',
      'G00 Z0.25',
      '(FACE A90 - FLIP TUBE to Right side face and RE-ZERO Z before resuming - no rotary axis on this machine)',
      'M00 (FLIP TUBE to Right side face (90.0 deg from Top) and RE-ZERO Z before resuming - no rotary axis on this machine)',
      'G00 X2.0 Y0.1',
      'G00 Z0.25',
      'G01 Z-0.15 F8'
    );
    const { moves } = parseToolpath3D(program);
    const firstPlunge = moves.find((m) => m.kind === 'ramp' && m.to.x === 1);
    const secondPlunge = moves.find((m) => m.kind === 'ramp' && m.to.x === 2);
    expect(firstPlunge.angleDeg).toBe(0);
    expect(secondPlunge.angleDeg).toBe(90);
  });

  it('routing/turning G-code (no A word ever appears) defaults every move to angleDeg 0', () => {
    const contour = [{ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], isHole: false }];
    const { gcode: programText } = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.1 });
    const { moves } = parseToolpath3D(programText);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.angleDeg === 0)).toBe(true);
  });
});

describe('tubeLocalPoint / tubeWallNormal (tube stock static local-frame geometry)', () => {
  const crossSection = { a: 2, b: 1 }; // a 2"x1" tube, matching am-5180's real dimensions

  it('places a point on the surface (machineZ=0) of the 0deg wall at +a/2 along Y, lateralOffset along Z', () => {
    const p = tubeLocalPoint(0, 5, 0.3, 0, crossSection);
    expect(p).toEqual({ x: 5, y: 1, z: 0.3 });
  });

  it('places a point on the surface of the 180deg wall at -a/2 along Y - same lateral (Z) direction as 0deg, not mirrored', () => {
    const p = tubeLocalPoint(180, 5, 0.3, 0, crossSection);
    expect(p).toEqual({ x: 5, y: -1, z: 0.3 });
  });

  it('places a point on the surface of the 90deg wall at +b/2 along Z, lateralOffset along Y', () => {
    const p = tubeLocalPoint(90, 5, 0.3, 0, crossSection);
    expect(p).toEqual({ x: 5, y: 0.3, z: 0.5 });
  });

  it('places a point on the surface of the 270deg wall at -b/2 along Z', () => {
    const p = tubeLocalPoint(270, 5, 0.3, 0, crossSection);
    expect(p).toEqual({ x: 5, y: 0.3, z: -0.5 });
  });

  it('a negative machineZ (a drill plunge) moves the point INWARD, toward the tube centerline, on every wall', () => {
    const atSurface0 = tubeLocalPoint(0, 5, 0, 0, crossSection);
    const drilled0 = tubeLocalPoint(0, 5, 0, -0.3, crossSection);
    expect(Math.abs(drilled0.y)).toBeLessThan(Math.abs(atSurface0.y));

    const atSurface180 = tubeLocalPoint(180, 5, 0, 0, crossSection);
    const drilled180 = tubeLocalPoint(180, 5, 0, -0.3, crossSection);
    expect(Math.abs(drilled180.y)).toBeLessThan(Math.abs(atSurface180.y));
  });

  it('snaps a slightly-off angle (float round-trip noise) to the nearest of 0/90/180/270', () => {
    const exact = tubeLocalPoint(90, 1, 0, 0, crossSection);
    const noisy = tubeLocalPoint(89.98, 1, 0, 0, crossSection);
    expect(noisy).toEqual(exact);
  });

  it('tubeWallNormal returns the outward unit normal for each wall, matching tubeLocalPoint\'s own sign convention', () => {
    expect(tubeWallNormal(0)).toEqual({ x: 0, y: 1, z: 0 });
    expect(tubeWallNormal(180)).toEqual({ x: 0, y: -1, z: 0 });
    expect(tubeWallNormal(90)).toEqual({ x: 0, y: 0, z: 1 });
    expect(tubeWallNormal(270)).toEqual({ x: 0, y: 0, z: -1 });
  });
});

describe('projectTubestockToolpath', () => {
  it('projects a rapid index + plunge sequence onto the correct wall, order-preserving with the raw moves (same length, same order)', () => {
    const crossSection = { a: 1, b: 1 };
    const raw = {
      moves: [
        { from: { x: 0, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0.25 }, kind: 'rapid', angleDeg: 0, toolIndex: 0 },
        { from: { x: 3, y: 0, z: 0.25 }, to: { x: 3, y: 0, z: -0.2 }, kind: 'ramp', angleDeg: 0, toolIndex: 0 }
      ],
      toolChangeIndices: [],
      totalDistance: 0
    };
    const { moves } = projectTubestockToolpath(raw, { crossSection });
    expect(moves.length).toBe(2);
    // The plunge move should end up sunk into the +Y face by 0.2" from the
    // 0.5" surface (a/2), i.e. at local Y = 0.3.
    expect(moves[1].to.y).toBeCloseTo(0.3, 5);
    expect(moves[1].to.x).toBe(3);
    expect(moves[1].kind).toBe('ramp'); // classification carries through unchanged
  });
});

describe('matchTubestockHolesToMoves', () => {
  it('joins each hole to its own plunge move by (angleDeg, position, lateralOffset), reporting the actual drilled depth', () => {
    const walls = [
      { angleDeg: 0, holes: [{ position: 3, lateralOffset: 0, diameter: 0.2 }] },
      { angleDeg: 90, holes: [{ position: 5, lateralOffset: 0.1, diameter: 0.15 }] }
    ];
    const rawMoves = [
      { from: { x: 0, y: 0, z: 0.25 }, to: { x: 3, y: 0, z: 0.25 }, kind: 'rapid', angleDeg: 0 },
      { from: { x: 3, y: 0, z: 0.25 }, to: { x: 3, y: 0, z: -0.18 }, kind: 'ramp', angleDeg: 0 },
      { from: { x: 3, y: 0, z: -0.18 }, to: { x: 5, y: 0.1, z: 0.25 }, kind: 'rapid', angleDeg: 90 },
      { from: { x: 5, y: 0.1, z: 0.25 }, to: { x: 5, y: 0.1, z: -0.12 }, kind: 'ramp', angleDeg: 90 }
    ];
    const matched = matchTubestockHolesToMoves(walls, rawMoves);
    expect(matched.length).toBe(2);
    expect(matched[0].moveIndex).toBe(1);
    expect(matched[0].fullDepth).toBeCloseTo(0.18, 5);
    expect(matched[1].moveIndex).toBe(3);
    expect(matched[1].fullDepth).toBeCloseTo(0.12, 5);
  });

  it('reports moveIndex -1 (rendered as always-drilled, not hidden) when no matching plunge move exists', () => {
    const walls = [{ angleDeg: 0, holes: [{ position: 99, lateralOffset: 0, diameter: 0.2 }] }];
    const matched = matchTubestockHolesToMoves(walls, []);
    expect(matched[0].moveIndex).toBe(-1);
    expect(matched[0].fullDepth).toBe(0);
  });

  it('against real generated G-code (tube-05x05-square.step): every hole in a real densely-drilled tube matches its own plunge move', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(TUBE_05X05_SQUARE));
    const features = extractTubeFeaturesFromMeshes(meshes);
    const { gcode: programText } = generateTubestockGcode(features, { holeDepth: 0.15 });
    const { moves: rawMoves } = parseToolpath3D(programText);
    const matched = matchTubestockHolesToMoves(features.walls, rawMoves);

    const totalHoles = features.walls.reduce((sum, w) => sum + w.holes.length, 0);
    expect(matched.length).toBe(totalHoles);
    const unmatched = matched.filter((h) => h.moveIndex === -1);
    expect(unmatched).toEqual([]);
    for (const hole of matched) expect(hole.fullDepth).toBeCloseTo(0.15, 3);

    // And every matched hole lands at a sane 3D point once projected: on
    // the surface of its own wall (not floating in space or buried past the
    // tube's own centerline).
    const { moves: projectedMoves } = projectTubestockToolpath({ moves: rawMoves, toolChangeIndices: [], totalDistance: 0 }, { crossSection: features.crossSection });
    for (const hole of matched) {
      const drilledPoint = projectedMoves[hole.moveIndex].to;
      const distanceFromAxis = Math.hypot(drilledPoint.y, drilledPoint.z);
      expect(distanceFromAxis).toBeLessThanOrEqual(Math.max(features.crossSection.a, features.crossSection.b) / 2 + 1e-6);
    }
  });
});

describe('parseToolpath3D - WinCNC bracket comments', () => {
  it('strips [...] comments instead of reading their text as axis words', () => {
    // Real bug: comments are "[...]" in the wincnc dialect, but only "(...)"
    // was stripped - so "[-- pass at Z-0.0300, ramped entry over 0.20" --]"
    // parsed as a Z move to -0.03, and "[Part positioned 0.50" clear of
    // X0/Y0 ...]" as a move to X0 Y0.
    const { moves } = parseToolpath3D(gcode(
      'G20', 'G90',
      'G00 X1 Y1 Z0.25',
      '[Part positioned 0.50" clear of X0/Y0 - keep clamps outside that boundary]',
      'G01 X2 Y1 Z-0.03 F20',
      '[-- pass at Z-0.0300, ramped entry over 0.20" --]',
      'G01 X3 Y1 F20'
    ));
    // Exactly the two commanded moves - no move to X0 Y0 from the first
    // comment, and no plunge to Z-0.03 from the second.
    expect(moves).toHaveLength(2);
    expect(moves[0].to).toEqual({ x: 2, y: 1, z: -0.03 });
    expect(moves[1].to).toEqual({ x: 3, y: 1, z: -0.03 });
  });

  it('reads a tool change and a tube-stock face tag in either dialect', () => {
    const wincnc = parseToolpath3D(gcode(
      'G20', 'G90', 'G00 X0 Y0 Z1',
      '[FACE A90 - FLIP TUBE to Right side face and RE-ZERO Z]',
      'G01 X1 F20',
      '[TOOL CHANGE: load 0.25" drill]',
      'G01 X2 F20'
    ));
    expect(wincnc.toolChangeIndices).toEqual([1]);
    expect(wincnc.moves[1].angleDeg).toBe(90);
  });

  it('parses a real wincnc program to exactly the same geometry as its linuxcnc twin', () => {
    const square = [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], isHole: false }];
    const build = (controller) => parseToolpath3D(
      generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.2, controller }).gcode
    );
    const linuxcnc = build('linuxcnc');
    const wincnc = build('wincnc');
    // Same part, same params - only the comment syntax differs, so the
    // toolpath the operator previews must be identical.
    expect(wincnc.moves).toHaveLength(linuxcnc.moves.length);
    expect(wincnc.totalDistance).toBeCloseTo(linuxcnc.totalDistance, 9);
  });
});

describe('inferRoutingEdgeShift - recovering the edge margin for legacy jobs', () => {
  // A square part, cut with cutter compensation offsetting the profile
  // outward by the tool radius, then shifted clear of X0/Y0 the way
  // generateRoutingGcode does.
  const squareToolpath = (shiftX, shiftY, radius) => {
    const x0 = shiftX - radius, x1 = shiftX + 2 + radius;
    const y0 = shiftY - radius, y1 = shiftY + 2 + radius;
    return parseToolpath3D(gcode(
      'G20', 'G90',
      `G00 X${x0} Y${y0} Z0.25`,
      'G01 Z-0.1 F20',
      `G01 X${x1} Y${y0}`,
      `G01 X${x1} Y${y1}`,
      `G01 X${x0} Y${y1}`,
      `G01 X${x0} Y${y0}`,
      'G00 Z0.25'
    )).moves;
  };
  // The same part in raw, pre-shift coordinates: a 2x2 square at the origin.
  const rawBounds = { min: { x: 0, y: 0, z: -0.1 }, max: { x: 2, y: 2, z: 0 } };

  it('recovers the shift that was applied, cancelling out the cutter radius', () => {
    const shift = inferRoutingEdgeShift(squareToolpath(4.25, 2.75, 0.125), rawBounds);
    expect(shift.x).toBeCloseTo(4.25, 9);
    expect(shift.y).toBeCloseTo(2.75, 9);
  });

  it('is independent of the tool radius, since compensation is symmetric', () => {
    for (const radius of [0.0625, 0.125, 0.25, 0.5]) {
      const shift = inferRoutingEdgeShift(squareToolpath(3, 1.5, radius), rawBounds);
      expect(shift.x, `radius ${radius}`).toBeCloseTo(3, 9);
      expect(shift.y, `radius ${radius}`).toBeCloseTo(1.5, 9);
    }
  });

  it('ignores rapids, which retract to positions unrelated to where the part sits', () => {
    const withStrayRapid = parseToolpath3D(gcode(
      'G20', 'G90',
      'G00 X0 Y0 Z1',            // a park position far from the part
      'G00 X50 Y50 Z1',          // and a stray rapid way off to one side
      'G00 X3.875 Y1.375 Z0.25',
      'G01 Z-0.1 F20',
      'G01 X6.125 Y1.375',
      'G01 X6.125 Y3.625',
      'G01 X3.875 Y3.625',
      'G01 X3.875 Y1.375',
      'G00 Z1'
    )).moves;
    const shift = inferRoutingEdgeShift(withStrayRapid, rawBounds);
    expect(shift.x).toBeCloseTo(4, 9);
    expect(shift.y).toBeCloseTo(1.5, 9);
  });

  it('returns no shift rather than a wrong one when it cannot tell', () => {
    expect(inferRoutingEdgeShift([], rawBounds)).toEqual({ x: 0, y: 0 });
    expect(inferRoutingEdgeShift(squareToolpath(3, 3, 0.125), null)).toEqual({ x: 0, y: 0 });
    // Rapids only - nothing was actually cut.
    const rapidsOnly = parseToolpath3D(gcode('G20', 'G90', 'G00 X0 Y0 Z1', 'G00 X5 Y5 Z1')).moves;
    expect(inferRoutingEdgeShift(rapidsOnly, rawBounds)).toEqual({ x: 0, y: 0 });
    // A degenerate part with no extent to line up against.
    const degenerate = { min: { x: 1, y: 1, z: 0 }, max: { x: 1, y: 1, z: 0 } };
    expect(inferRoutingEdgeShift(squareToolpath(3, 3, 0.125), degenerate)).toEqual({ x: 0, y: 0 });
  });

  it('matches the real edgeShift generateRoutingGcode reports for the same part', () => {
    // End to end against the real generator rather than a hand-built path.
    const square = [{ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], isHole: false }];
    const { gcode: program, stats } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.1, edgeMargin: 1 });
    expect(stats.edgeShiftX).toBeGreaterThan(0);

    const { moves } = parseToolpath3D(program);
    const shift = inferRoutingEdgeShift(moves, rawBounds);
    expect(shift.x).toBeCloseTo(stats.edgeShiftX, 6);
    expect(shift.y).toBeCloseTo(stats.edgeShiftY, 6);
  });
});
describe('parseToolpath3D - dwells are not motion', () => {
  it('does not read a wincnc dwell (G04 X<seconds>) as a move to X=<seconds>', () => {
    // Real bug: `G04 X2.0` emitted a phantom 2" rapid to X=2 and left the
    // machine position wrong for every move after it, in the 2D preview and
    // the 3D sim alike, for every program generated in the wincnc dialect.
    const { moves, dwellSeconds } = parseToolpath3D(gcode(
      'G20', 'G90',
      'G00 X0 Y0 Z1',
      'S8000 M03',
      'G04 X2.0 (wait for spindle to reach speed)',
      'G01 X1 Y0 Z-0.1 F20'
    ));
    expect(moves).toHaveLength(1);
    expect(moves[0].from).toEqual({ x: 0, y: 0, z: 1 });
    expect(moves[0].to).toEqual({ x: 1, y: 0, z: -0.1 });
    expect(dwellSeconds).toBe(2);
  });

  it('reads a linuxcnc dwell (G04 P<seconds>) as time too', () => {
    const { moves, dwellSeconds } = parseToolpath3D(gcode('G20', 'G90', 'G00 X0 Y0 Z1', 'G04 P1.5', 'G01 X1 F20'));
    expect(dwellSeconds).toBe(1.5);
    expect(moves).toHaveLength(1);
  });
});

describe('estimateMachiningTime', () => {
  it('times a feed-per-minute (G94) cut as distance / feed', () => {
    const { moves } = parseToolpath3D(gcode('G20', 'G90', 'G94', 'G00 X0 Y0 Z0', 'G01 X10 Y0 F20'));
    const est = estimateMachiningTime(moves);
    expect(est.cuttingSeconds).toBeCloseTo(30, 6); // 10in at 20in/min
    expect(est.unknownFeedMoves).toBe(0);
  });

  it('times rapids at the rapid rate, not the cutting feed', () => {
    const { moves } = parseToolpath3D(gcode('G20', 'G90', 'G94', 'G00 X0 Y0 Z0', 'G01 X1 F1', 'G00 X101'));
    const est = estimateMachiningTime(moves, { rapidRate: 200 });
    expect(est.cuttingSeconds).toBeCloseTo(60, 6);  // 1in at 1in/min
    expect(est.rapidSeconds).toBeCloseTo(30, 6);    // 100in at 200in/min
  });

  it('converts feed per revolution (G95) using the spindle speed', () => {
    // G97 S1000 with F0.005 in/rev = 5 in/min, so 10in takes 2 minutes.
    const { moves } = parseToolpath3D(gcode('G20', 'G90', 'G95', 'G97 S1000 M03', 'G00 X0 Z0', 'G01 Z-10 F0.005'));
    const est = estimateMachiningTime(moves);
    expect(est.cuttingSeconds).toBeCloseTo(120, 6);
  });

  it('derives RPM from the diameter under G96 constant surface speed', () => {
    // At 2" diameter, 100 SFM -> 100*12/(pi*2) = 190.99 rpm.
    // F0.01 in/rev -> 1.9099 in/min, so a 1" cut takes 31.416s.
    const { moves } = parseToolpath3D(gcode('G20', 'G90', 'G95', 'G96 S100 M03', 'G00 X2 Z0', 'G01 Z-1 F0.01'));
    const est = estimateMachiningTime(moves);
    expect(est.cuttingSeconds).toBeCloseTo(60 / ((100 * 12) / (Math.PI * 2) * 0.01), 4);
  });

  it('honours the G50 max-RPM clamp instead of the surface-speed formula', () => {
    // At 0.05" diameter the G96 formula demands ~7639 rpm; G50 caps it at 500.
    const { moves } = parseToolpath3D(gcode('G20', 'G90', 'G95', 'G50 S500', 'G96 S100 M03', 'G00 X0.05 Z0', 'G01 Z-1 F0.01'));
    const cut = moves.find((m) => m.kind !== 'rapid');
    expect(cut.rpm).toBe(500);
    expect(estimateMachiningTime(moves).cuttingSeconds).toBeCloseTo(60 / (500 * 0.01), 6);
  });

  it('counts dwell time but leaves human pauses out of the total', () => {
    // An M00 waits on a person - there is no defensible number of seconds
    // for it, so it is reported as a count rather than invented.
    const parsed = parseToolpath3D(gcode(
      'G20', 'G90', 'G94', 'G00 X0 Y0 Z0',
      'G04 P3',
      'M00 (TOOL CHANGE: load 0.125" endmill)',
      'G01 X10 F20'
    ));
    const est = estimateMachiningTime(parsed.moves, { dwellSeconds: parsed.dwellSeconds, pauseCount: parsed.pauseCount });
    expect(est.dwellSeconds).toBe(3);
    expect(est.pauseCount).toBe(1);
    expect(est.totalSeconds).toBeCloseTo(30 + 3, 6);
  });

  it('reports moves it cannot time rather than guessing a feed for them', () => {
    const { moves } = parseToolpath3D(gcode('G20', 'G90', 'G94', 'G00 X0 Y0 Z0', 'G01 X5'));
    const est = estimateMachiningTime(moves);
    expect(est.unknownFeedMoves).toBe(1);
    expect(est.cuttingSeconds).toBe(0);
  });

  it('estimates a real generated routing program end to end', () => {
    const square = [{ points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }], isHole: false }];
    const { gcode: program } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.25 });
    const parsed = parseToolpath3D(program);
    const est = estimateMachiningTime(parsed.moves, { dwellSeconds: parsed.dwellSeconds, pauseCount: parsed.pauseCount });
    // Every move in this app's own output carries a feed - nothing untimed.
    expect(est.unknownFeedMoves).toBe(0);
    expect(est.totalSeconds).toBeGreaterThan(0);
    expect(est.cuttingSeconds).toBeGreaterThan(est.rapidSeconds);
  });

  it('estimates a real generated turning program, which is feed-per-rev', () => {
    const profile = [{ z: 0, radius: 0.5 }, { z: -1, radius: 0.5 }, { z: -1, radius: 0.375 }, { z: -2, radius: 0.375 }];
    const { gcode: program } = generateTurningGcode(profile, { stockDiameter: 1.25 });
    const parsed = parseToolpath3D(program);
    const projected = projectTurningToolpath(parsed);
    const est = estimateMachiningTime(projected.moves, { dwellSeconds: parsed.dwellSeconds });
    expect(est.unknownFeedMoves).toBe(0);
    expect(est.cuttingSeconds).toBeGreaterThan(0);
    // Feed-per-rev survives the projection that rewrites the axes.
    expect(projected.moves.some((m) => m.feedPerRev && m.rpm > 0)).toBe(true);
  });
});

describe('formatMachiningTime', () => {
  it('reads as a duration a machinist can scan', () => {
    expect(formatMachiningTime(48)).toBe('48s');
    expect(formatMachiningTime(252)).toBe('4m 12s');
    expect(formatMachiningTime(3780)).toBe('1h 03m');
    expect(formatMachiningTime(0)).toBe('—');
    expect(formatMachiningTime(null)).toBe('—');
  });
});

describe('buildRoutingHeightmap - sub-cell boundary for the displayed surface', () => {
  // A 1.0" circular bore traced by 720 short arc moves with a 0.25" cutter.
  const bore = () => {
    const cx = 3, cy = 3, R = 1.0, depth = -0.25, N = 720;
    const moves = [];
    for (let i = 0; i < N; i += 1) {
      const a0 = (2 * Math.PI * i) / N;
      const a1 = (2 * Math.PI * (i + 1)) / N;
      const from = { x: cx + R * Math.cos(a0), y: cy + R * Math.sin(a0), z: depth };
      const to = { x: cx + R * Math.cos(a1), y: cy + R * Math.sin(a1), z: depth };
      moves.push({ from, to, kind: 'cut', length: Math.hypot(to.x - from.x, to.y - from.y) });
    }
    return { cx, cy, R, depth, moves };
  };
  const GRID = { nx: 300, ny: 300, minX: 0, minY: 0, cellSize: 0.02, topZ: 0 };

  // Bilinear, matching what the rendered mesh interpolates between vertices.
  const sampler = (field) => (x, y) => {
    const gx = (x - GRID.minX) / GRID.cellSize - 0.5;
    const gy = (y - GRID.minY) / GRID.cellSize - 0.5;
    const i0 = Math.floor(gx), j0 = Math.floor(gy);
    const tx = gx - i0, ty = gy - j0;
    const at = (i, j) => field[Math.max(0, Math.min(GRID.ny - 1, j)) * GRID.nx + Math.max(0, Math.min(GRID.nx - 1, i))];
    return (at(i0, j0) * (1 - tx) + at(i0 + 1, j0) * tx) * (1 - ty)
         + (at(i0, j0 + 1) * (1 - tx) + at(i0 + 1, j0 + 1) * tx) * ty;
  };

  // Radius at which the surface crosses half depth, swept around the bore.
  const boundaryRadii = (field, { cx, cy, R, depth }) => {
    const sample = sampler(field);
    const radii = [];
    for (let k = 0; k < 720; k += 1) {
      const a = (2 * Math.PI * k) / 720;
      let prevR = null, prevV = null;
      for (let r = R; r <= R + 0.4; r += 0.0005) {
        const v = sample(cx + r * Math.cos(a), cy + r * Math.sin(a));
        if (prevV !== null && prevV <= depth / 2 && v > depth / 2) {
          radii.push(prevR + (r - prevR) * ((depth / 2 - prevV) / (v - prevV)));
          break;
        }
        prevR = r; prevV = v;
      }
    }
    return radii;
  };
  const stdev = (values) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, sd: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) };
  };

  it('follows a circular bore far more closely than the cell-centre test alone', () => {
    const geometry = bore();
    const surface = new Float32Array(GRID.nx * GRID.ny);
    const heights = buildRoutingHeightmap(geometry.moves, {
      ...GRID, floorZ: geometry.depth, cutterRadiusForMove: () => 0.125,
      uptoMoveIndex: geometry.moves.length, partialProgress: 1, surfaceOut: surface
    });

    const binary = stdev(boundaryRadii(heights, geometry));
    const covered = stdev(boundaryRadii(surface, geometry));

    // Testing only a cell's centre quantises the boundary to the grid, which
    // is the staircase on a bore wall. Sub-cell coverage cuts that wobble to
    // a fraction of a cell.
    expect(covered.sd).toBeLessThan(binary.sd * 0.5);
    expect(covered.sd).toBeLessThan(GRID.cellSize * 0.1);
    // And it stays centred on the true boundary (bore radius + cutter radius)
    // rather than dilating outward, which a per-move blend would do.
    expect(covered.mean).toBeCloseTo(geometry.R + 0.125, 2);
  });

  it('leaves the simulation state binary and deepest-wins for the gouge check', () => {
    const geometry = bore();
    const surface = new Float32Array(GRID.nx * GRID.ny);
    const heights = buildRoutingHeightmap(geometry.moves, {
      ...GRID, floorZ: geometry.depth, cutterRadiusForMove: () => 0.125,
      uptoMoveIndex: geometry.moves.length, partialProgress: 1, surfaceOut: surface
    });
    // Every raw cell is either untouched or at full depth - a partial value
    // here could report a cut shallower than the material actually removed.
    const distinct = new Set(Array.from(heights).map((v) => v.toFixed(6)));
    expect(distinct.size).toBe(2);
    expect(Math.min(...distinct.size ? Array.from(distinct).map(Number) : [0])).toBeCloseTo(geometry.depth, 6);
  });

  it('is unchanged when no surface output is requested', () => {
    const geometry = bore();
    const withSurface = new Float32Array(GRID.nx * GRID.ny);
    const a = buildRoutingHeightmap(geometry.moves, { ...GRID, floorZ: geometry.depth, cutterRadiusForMove: () => 0.125, uptoMoveIndex: geometry.moves.length, partialProgress: 1 });
    const b = buildRoutingHeightmap(geometry.moves, { ...GRID, floorZ: geometry.depth, cutterRadiusForMove: () => 0.125, uptoMoveIndex: geometry.moves.length, partialProgress: 1, surfaceOut: withSurface });
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
