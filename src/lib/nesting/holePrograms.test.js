import { describe, it, expect } from 'vitest';
import { holeProgramForThickness } from './holePrograms.js';
import { emitNestingGcode } from './gcodeEmit.js';
import { parseGcodeToolpath, toolpathBounds } from './gcodeToolpath.js';

const THICKNESSES = ['0.063', '0.09', '0.125', '0.1875', '0.25', '0.3125', '0.375', '0.5', '0.75'];

// The deepest Z each thickness's own bundled program actually cuts to -
// confirmed against the real checked-in .tap files. Scales with thickness
// (thicker sheet -> deeper hole), so any two different thicknesses landing
// on the same depth means one of them silently fell back to another
// thickness's program instead of using its own.
const EXPECTED_MIN_Z = { '0.063': -0.0825, '0.09': -0.11, '0.125': -0.145, '0.1875': -0.2075, '0.25': -0.27, '0.3125': -0.3325, '0.375': -0.395, '0.5': -0.52, '0.75': -0.77 };

function minZ(source) {
  const values = [...source.matchAll(/Z(-?[0-9]+\.[0-9]+)/g)].map(m => Number(m[1]));
  return Math.min(...values);
}

describe('hole programs: every thickness gets its own dedicated wincnc program', () => {
  // Direct bug fix: holePrograms.js's wincnc `tap` map was missing
  // 0.090/0.1875/0.3125 entirely, even though real dedicated files exist
  // for them - those three thicknesses silently fell back to the 0.125
  // program (see holeProgramForThickness's own `|| programs['0.125']`),
  // cutting to the wrong depth. This pins each thickness to its own real,
  // checked-in program by depth, not just "returned something truthy".
  for (const thickness of THICKNESSES) {
    it(`thickness ${thickness} cuts to its own real depth, on Tool 1 only`, () => {
      const source = holeProgramForThickness(thickness, 'wincnc');
      expect(source).toBeTruthy();
      const tools = new Set([...source.matchAll(/^T(\d+)\s*$/gm)].map((m) => m[1]));
      expect([...tools]).toEqual(['1']);
      expect(minZ(source)).toBeCloseTo(EXPECTED_MIN_Z[thickness], 4);
    });
  }
});

describe('a placed hole emits correctly on Tool 1', () => {
  for (const thickness of THICKNESSES) {
    it(`thickness ${thickness}`, () => {
      const placements = [{ kind: 'hole', label: 'Hole', x: -10, y: 10, part_library_path: null }];
      const result = emitNestingGcode({ name: 'hole-test', placements, programs: {}, suffix: 'holes', dialect: 'wincnc', thickness });
      expect(result.emitted).toBe(1);
      const toolHeaders = [...result.text.matchAll(/^\[Tool (\d+)\]$/gm)].map(m => m[1]);
      expect(toolHeaders).toEqual(['1']);
      expect(result.text).not.toMatch(/NaN|undefined/);
      const segments = parseGcodeToolpath(result.text);
      expect(segments.length).toBeGreaterThan(0);
      const bounds = toolpathBounds(segments);
      expect(Number.isFinite(bounds.minX)).toBe(true);
    });
  }

  it('a hole placed alongside real parts still ends up correctly grouped under Tool 1, not a separate swap', () => {
    const source = 'G90\nT1\nG0 X0 Y0\nG1 X1 Y1\nM5';
    const placements = [
      { kind: 'part', label: 'Plate-AUTOCAM', x: 2, y: 2, part_library_path: 'plate' },
      { kind: 'hole', label: 'Hole', x: 6, y: 2, part_library_path: null },
    ];
    const result = emitNestingGcode({ name: 'part-plus-hole', placements, programs: { plate: { source } }, suffix: 'holes', dialect: 'wincnc', thickness: '0.125' });
    const toolHeaders = [...result.text.matchAll(/^\[Tool (\d+)\]$/gm)].map(m => m[1]);
    expect(toolHeaders).toEqual(['1']);
    expect(result.emitted).toBe(2);
  });
});
