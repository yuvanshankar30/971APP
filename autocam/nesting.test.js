import { describe, expect, it } from 'vitest';
import { gcodeBounds, minimumPartClearance, packRects } from './nesting.js';
import { generateGroupedRoutingGcode } from './groupedGcode.js';
import { generateRoutingGcode } from './routing.js';

describe('router job grouping', () => {
  it('measures absolute XY toolpath bounds', () => {
    expect(gcodeBounds('G00 X1 Y2\nG01 X4 Y6')).toMatchObject({ minX: 1, minY: 2, width: 3, height: 4 });
  });
  it('ignores coordinates that appear only in comments', () => {
    expect(gcodeBounds('G00 X8 Y6\nG01 X10 Y6 (clear of X0/Y0)\nG01 X10 Y8 [leave X99/Y99 alone]'))
      .toMatchObject({ minX: 8, minY: 6, maxX: 10, maxY: 8, width: 2, height: 2 });
  });
  it('measures only material-removing moves, not rapid park positions', () => {
    expect(gcodeBounds('G00 X50 Y50\nG00 X1 Y2\nG01 X4 Y6\nG00 X100 Y100'))
      .toMatchObject({ minX: 1, minY: 2, maxX: 4, maxY: 6 });
  });
  it('matches the contour extents of a real generated routing job', () => {
    const square = [{ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], isHole: false }];
    const toolDiameter = 0.25;
    const { gcode, stats } = generateRoutingGcode(square, { toolDiameter, targetDepth: 0.1, edgeMargin: 1 });
    expect(gcodeBounds(gcode)).toMatchObject({
      minX: stats.edgeShiftX - toolDiameter / 2,
      minY: stats.edgeShiftY - toolDiameter / 2,
      maxX: stats.edgeShiftX + 2 + toolDiameter / 2,
      maxY: stats.edgeShiftY + 2 + toolDiameter / 2
    });
  });
  it('keeps a cutter- and tolerance-aware web between packed paths', () => {
    expect(minimumPartClearance(0.1575, 0.01)).toBeCloseTo(0.1775);
    const plan = packRects([{ id: 'a', bounds: { width: 2, height: 1 } }, { id: 'b', bounds: { width: 2, height: 1 } }], { stockWidth: 6, stockHeight: 3, edgeMargin: 0.25, clearance: 0.2, toolDiameter: 0.25 });
    expect(plan.placements[1].x - plan.placements[0].x).toBeCloseTo(2.2);
  });
  it('keeps the cutter edge inside the requested sheet-edge margin', () => {
    const plan = packRects([{ id: 'a', bounds: { width: 1.5, height: 1.5 } }], {
      stockWidth: 2, stockHeight: 2, edgeMargin: 0.125, clearance: 0, toolDiameter: 0.25
    });
    expect(plan.placements[0].x - 0.25 / 2).toBeCloseTo(0.125);
    expect(plan.placements[0].y - 0.25 / 2).toBeCloseTo(0.125);
    expect(2 - (plan.placements[0].x + 1.5 + 0.25 / 2)).toBeCloseTo(0.125);
    expect(2 - (plan.placements[0].y + 1.5 + 0.25 / 2)).toBeCloseTo(0.125);
    expect(plan.centerlineMargin).toBeCloseTo(0.25);
  });
  it('keeps the existing default setup yield for a representative four-part sheet', () => {
    const items = Array.from({ length: 4 }, (_, index) => ({ id: index, bounds: { width: 2, height: 1 } }));
    const plan = packRects(items, {
      stockWidth: 6, stockHeight: 4, edgeMargin: 0.5, clearance: 0.1775, toolDiameter: 0.1575
    });
    expect(plan.placements).toHaveLength(4);
  });
  it('combines translated programs with one program end', () => {
    const gcode = generateGroupedRoutingGcode({ placements: [{ name: 'A', gcode: 'G20\nG90\nS10000 M03\nG01 X1 Y2\nM05\nM30', offsetX: 3, offsetY: 4 }], params: { safeZ: 0.5, edgeMargin: 0.5, toolDiameter: 0.1575 } });
    expect(gcode).toContain('X4 Y6');
    expect((gcode.match(/M30/g) || []).length).toBe(1);
  });
});

describe('grouped program header', () => {
  it('states the depth every part was cut to, so the sheet can be checked against it', () => {
    const gcode = generateGroupedRoutingGcode({
      name: 'Sheet 1',
      placements: [{ name: 'A', gcode: 'G20\nG90\nG01 X1 Y2 F20', offsetX: 0, offsetY: 0 }],
      params: { safeZ: 0.25, stockThickness: 0.125, toolDiameter: 0.25 }
    });
    expect(gcode).toContain('EVERY PART HERE IS CUT TO 0.125" - CONFIRM THE SHEET MATCHES');
  });

  it('says nothing about thickness when the group does not know it', () => {
    const gcode = generateGroupedRoutingGcode({
      name: 'Sheet 1',
      placements: [{ name: 'A', gcode: 'G20\nG90\nG01 X1 Y2 F20', offsetX: 0, offsetY: 0 }],
      // toolDiameter is now required - a group cannot state a real edge
      // clearance without knowing the cutter.
      params: { safeZ: 0.25, toolDiameter: 0.25 }
    });
    expect(gcode).not.toContain('CONFIRM THE SHEET MATCHES');
  });
});
