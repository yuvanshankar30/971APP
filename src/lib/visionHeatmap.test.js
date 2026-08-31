import { describe, expect, it } from 'vitest';
import { buildVisionHeatmap } from './visionHeatmap.js';

describe('buildVisionHeatmap', () => {
  it('stays empty until calibrated trajectory points exist', () => {
    expect(buildVisionHeatmap([{ alliance: 'red', trajectory: [{ x: 1, y: 2, calibrated: false }] }]).points).toBe(0);
  });

  it('bins calibrated points and preserves alliance density', () => {
    const result = buildVisionHeatmap([
      { alliance: 'red', trajectory: [{ x: 0, y: 0, calibrated: true }, { x: 0, y: 0, calibrated: true }] },
      { alliance: 'blue', trajectory: [{ x: 10, y: 5, calibrated: true }] }
    ], { columns: 10, rows: 5 });
    expect(result.points).toBe(3);
    expect(result.cells.reduce((sum, cell) => sum + cell.red, 0)).toBe(2);
    expect(result.cells.reduce((sum, cell) => sum + cell.blue, 0)).toBe(1);
  });
});
