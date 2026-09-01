import { describe, it, expect } from 'vitest';
import { generateTubestockGcode } from './tubestock.js';

// Synthetic tube features matching extractTubeFeaturesFromMeshes' output
// shape directly - 2 holes on one wall (0.25"), 1 on another (0.375"), 2
// blank walls.
function twoWallTube() {
  return {
    tubeLength: 12,
    walls: [
      { angleDeg: 0, holes: [{ position: 2, lateralOffset: 0, diameter: 0.25 }, { position: 8, lateralOffset: 0, diameter: 0.25 }] },
      { angleDeg: 90, holes: [{ position: 5, lateralOffset: 0, diameter: 0.375 }] },
      { angleDeg: 180, holes: [] },
      { angleDeg: 270, holes: [] }
    ]
  };
}

const baseParams = { holeDepth: 0.15 };

describe('generateTubestockGcode', () => {
  it('generates a complete program ending in M30 for a real multi-wall, multi-diameter tube', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    expect(result.gcode).toContain('M30');
    expect(result.gcode).toContain('%');
  });

  it('creates one self-contained program for each drilled face', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    expect(result.gcodeFiles).toHaveLength(2);
    expect(result.gcodeFiles.map((file) => file.angleDeg)).toEqual([0, 90]);
    expect(result.stats.facePrograms).toHaveLength(2);
    expect(result.gcodeFiles[0].gcode).toContain('FACE A0.0');
    expect(result.gcodeFiles[0].gcode).not.toContain('A90.0');
    expect(result.gcodeFiles[1].gcode).toContain('FACE A90.0');
    expect(result.gcodeFiles[1].gcode).not.toContain('A0.0');
    expect(result.gcodeFiles.every((file) => file.gcode.includes('M30 (program end)'))).toBe(true);
  });

  it('creates four files when all four tube faces contain holes', () => {
    const fourFaceTube = {
      tubeLength: 12,
      walls: [0, 90, 180, 270].map((angleDeg, index) => ({
        angleDeg,
        holes: [{ position: index + 1, lateralOffset: 0, diameter: 0.25 }]
      }))
    };
    const result = generateTubestockGcode(fourFaceTube, baseParams);
    expect(result.gcodeFiles).toHaveLength(4);
    expect(result.gcodeFiles.map((file) => file.angleDeg)).toEqual([0, 90, 180, 270]);
  });

  it('rejects tube features with no walls', () => {
    expect(() => generateTubestockGcode({ walls: [] }, baseParams)).toThrow(/at least one wall/);
  });

  it('rejects tube features where every wall has zero holes', () => {
    const empty = { walls: [{ angleDeg: 0, holes: [] }, { angleDeg: 90, holes: [] }] };
    expect(() => generateTubestockGcode(empty, baseParams)).toThrow(/No holes found/);
  });

  it('requires holeDepth', () => {
    expect(() => generateTubestockGcode(twoWallTube(), {})).toThrow(/holeDepth is required/);
  });

  it('rejects a non-positive holeDepth', () => {
    expect(() => generateTubestockGcode(twoWallTube(), { holeDepth: 0 })).toThrow(/holeDepth is required/);
  });

  it('groups holes by diameter, largest first, and reports the right tool/hole counts in stats', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    expect(result.stats.toolsUsed).toBe(2);
    expect(result.stats.totalHoles).toBe(3);
    expect(result.stats.toolChanges).toBe(1);
    expect(result.stats.wallsUsed).toBe(2);
    // 0.375" (T1, 1 hole) listed before 0.25" (T2, 2 holes) in the tool plan.
    const planIdx375 = result.gcode.indexOf('0.375" drill (T1)');
    const planIdx250 = result.gcode.indexOf('0.250" drill (T2)');
    expect(planIdx375).toBeGreaterThan(-1);
    expect(planIdx250).toBeGreaterThan(planIdx375);
  });

  it('only emits a tool-change pause between different diameters, not between every hole', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    const pauseCount = (result.gcode.match(/TOOL CHANGE/g) || []).length;
    expect(pauseCount).toBe(1); // 2 distinct diameters -> exactly 1 change
  });

  it('indexes the rotary axis (A) once per wall, not once per hole', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    const indexCount = (result.gcode.match(/index rotary axis/g) || []).length;
    // T1 (0.375" @ 90deg, 1 hole) -> 1 index. T2 (0.25" @ 0deg, 2 holes,
    // same wall) -> 1 index. Total 2, not 3 (one per hole would be wrong).
    expect(indexCount).toBe(2);
  });

  it('plunges to the negative of holeDepth and retracts to +safeZ', () => {
    const result = generateTubestockGcode(twoWallTube(), { holeDepth: 0.2, safeZ: 0.3 });
    expect(result.gcode).toContain('Z-0.2000');
    expect(result.gcode).toContain('Z0.3000');
  });

  it('rejects a non-positive safeZ', () => {
    expect(() => generateTubestockGcode(twoWallTube(), { holeDepth: 0.15, safeZ: 0 })).toThrow(/safeZ must be > 0/);
  });

  it('drills side-by-side holes on a wide face at their own Y (lateralOffset), not all at Y0 (real bug found against a real AndyMark 2"x1" tube fixture: a wide face can have two holes at the same length-position but different offsets across its width - a real hole pair, not a duplicate)', () => {
    const wideFaceTube = {
      tubeLength: 10,
      walls: [{ angleDeg: 0, holes: [
        { position: 3, lateralOffset: -0.4, diameter: 0.196 },
        { position: 3, lateralOffset: 0.4, diameter: 0.196 }
      ] }]
    };
    const result = generateTubestockGcode(wideFaceTube, baseParams);
    expect(result.gcode).toContain('X3.0000 Y-0.4000');
    expect(result.gcode).toContain('X3.0000 Y0.4000');
    expect(result.stats.totalHoles).toBe(2);
  });

  it('defaults lateralOffset to 0 for hand-built tubeFeatures that omit it', () => {
    const noOffset = { tubeLength: 4, walls: [{ angleDeg: 0, holes: [{ position: 2, diameter: 0.25 }] }] };
    const result = generateTubestockGcode(noOffset, baseParams);
    expect(result.gcode).toContain('X2.0000 Y0.0000');
  });

  describe('controller dialect (linuxcnc default vs wincnc)', () => {
    it('defaults to linuxcnc: parenthesis comments, G54, M00 tool-change pause, M30 end', () => {
      const result = generateTubestockGcode(twoWallTube(), baseParams);
      expect(result.gcode).toContain('G54');
      expect(result.gcode).toContain('M00 (TOOL CHANGE');
      expect(result.gcode).toContain('M30 (program end)');
      expect(result.gcode).not.toContain('[');
    });

    it('wincnc: bracket comments, no G54, G4 dwell-pause instead of M00, no M30', () => {
      const result = generateTubestockGcode(twoWallTube(), { ...baseParams, controller: 'wincnc' });
      // Not a blanket substring check - the WinCNC path's own explanatory
      // comment mentions "G54-style" prose, which would false-positive a
      // plain .not.toContain('G54') check without actually emitting the code.
      expect(result.gcode.split('\n').some((l) => /^G54\b/.test(l))).toBe(false);
      expect(result.gcode).not.toContain('M00');
      expect(result.gcode).toContain('G4 [TOOL CHANGE');
      expect(result.gcode).not.toContain('M30');
      expect(result.gcode).toContain('[PROGRAM END]');
      expect(result.gcode).not.toContain('(');
    });
  });

  it('supports a single-wall, single-diameter tube with no tool changes at all', () => {
    const single = { tubeLength: 4, walls: [{ angleDeg: 0, holes: [{ position: 2, diameter: 0.25 }] }] };
    const result = generateTubestockGcode(single, baseParams);
    expect(result.stats.toolChanges).toBe(0);
    expect(result.stats.totalHoles).toBe(1);
    expect(result.gcode).toContain('M30');
  });
});
