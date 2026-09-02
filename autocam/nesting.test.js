import { describe, expect, it } from 'vitest';
import { gcodeBounds, minimumPartClearance, packRects } from './nesting.js';
import { generateGroupedRoutingGcode } from './groupedGcode.js';

describe('router job grouping', () => {
  it('measures absolute XY toolpath bounds', () => {
    expect(gcodeBounds('G00 X1 Y2\nG01 X4 Y6')).toMatchObject({ minX: 1, minY: 2, width: 3, height: 4 });
  });
  it('keeps a cutter- and tolerance-aware web between packed paths', () => {
    expect(minimumPartClearance(0.1575, 0.01)).toBeCloseTo(0.1775);
    const plan = packRects([{ id: 'a', bounds: { width: 2, height: 1 } }, { id: 'b', bounds: { width: 2, height: 1 } }], { stockWidth: 6, stockHeight: 3, edgeMargin: 0.25, clearance: 0.2 });
    expect(plan.placements[1].x - plan.placements[0].x).toBeCloseTo(2.2);
  });
  it('combines translated programs with one program end', () => {
    const gcode = generateGroupedRoutingGcode({ placements: [{ name: 'A', gcode: 'G20\nG90\nS10000 M03\nG01 X1 Y2\nM05\nM30', offsetX: 3, offsetY: 4 }], params: { safeZ: 0.5 } });
    expect(gcode).toContain('X4 Y6');
    expect((gcode.match(/M30/g) || []).length).toBe(1);
  });
});

describe('grouped program header', () => {
  it('states the depth every part was cut to, so the sheet can be checked against it', () => {
    const gcode = generateGroupedRoutingGcode({
      name: 'Sheet 1',
      placements: [{ name: 'A', gcode: 'G20\nG90\nG01 X1 Y2 F20', offsetX: 0, offsetY: 0 }],
      params: { safeZ: 0.25, stockThickness: 0.125 }
    });
    expect(gcode).toContain('EVERY PART HERE IS CUT TO 0.125" - CONFIRM THE SHEET MATCHES');
  });

  it('says nothing about thickness when the group does not know it', () => {
    const gcode = generateGroupedRoutingGcode({
      name: 'Sheet 1',
      placements: [{ name: 'A', gcode: 'G20\nG90\nG01 X1 Y2 F20', offsetX: 0, offsetY: 0 }],
      params: { safeZ: 0.25 }
    });
    expect(gcode).not.toContain('CONFIRM THE SHEET MATCHES');
  });
});
