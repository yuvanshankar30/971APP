import { describe, expect, it } from 'vitest';
import {
  parseGcodeToolpath,
  parseToolpath3D,
  toolpathPositionAtDistance,
  toolpathBounds,
  toolpathBounds3D
} from './toolpathPreview.js';
import { generateRoutingGcode } from './routing.js';

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
