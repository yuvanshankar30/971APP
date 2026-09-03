import { describe, it, expect } from 'vitest';
import { generateTubestockGcode, tubestockFaceFileName, tubestockFaceLabel, tubestockFaceClock, holeDepthForWall } from './tubestock.js';

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
    expect(result.gcodeFiles.map((file) => file.label)).toEqual(['Side 12', 'Side 3']);
    expect(result.stats.facePrograms).toHaveLength(2);
    // Each face program names only its own face, so an operator who opens
    // the wrong file sees the wrong number immediately.
    expect(result.gcodeFiles[0].gcode).toContain('Side 12 - turn this face up');
    expect(result.gcodeFiles[0].gcode).not.toContain('Side 3 - turn this face up');
    expect(result.gcodeFiles[1].gcode).toContain('Side 3 - turn this face up');
    expect(result.gcodeFiles[1].gcode).not.toContain('Side 12 - turn this face up');
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
    expect(result.gcodeFiles.map((file) => file.label)).toEqual(['Side 12', 'Side 3', 'Side 6', 'Side 9']);
  });

  it('emits one program for equivalent face angles (0 and 360) on the same face', () => {
    const duplicateTop = {
      tubeLength: 12,
      walls: [
        { angleDeg: 0, holes: [{ position: 2, lateralOffset: 0, diameter: 0.25 }] },
        { angleDeg: 360, holes: [{ position: 8, lateralOffset: 0, diameter: 0.25 }] }
      ]
    };
    const result = generateTubestockGcode(duplicateTop, baseParams);
    expect(result.gcodeFiles).toHaveLength(1);
    expect(result.gcodeFiles[0].label).toBe('Side 12');
    expect(result.gcodeFiles[0].gcode).toContain('X2.0000');
    expect(result.gcodeFiles[0].gcode).toContain('X8.0000');
    expect(tubestockFaceFileName('tube.ngc', 360)).toBe('tube-side-12.ngc');
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
    // Comment text carries no parentheses - see autocam/gcodeComments.js,
    // which strips them so a comment cannot close itself early.
    const planIdx375 = result.gcode.indexOf('0.375" drill T1');
    const planIdx250 = result.gcode.indexOf('0.250" drill T2');
    expect(planIdx375).toBeGreaterThan(-1);
    expect(planIdx250).toBeGreaterThan(planIdx375);
  });

  it('only emits a tool-change pause between different diameters, not between every hole', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    const pauseCount = (result.gcode.match(/TOOL CHANGE/g) || []).length;
    expect(pauseCount).toBe(1); // 2 distinct diameters -> exactly 1 change
  });

  it('prompts to flip the tube once per wall in the combined program, not once per hole', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    // Each flip emits both a machine-readable (FACE A..) comment tag (for
    // the 3D preview) and an M00 pause instructing the operator - one pair
    // per wall change, not per hole.
    const tagCount = (result.gcode.match(/\(FACE A/g) || []).length;
    const pauseCount = (result.gcode.match(/M00 \(FLIP TUBE/g) || []).length;
    // T1 (0.375" @ 90deg, 1 hole) -> 1 flip. T2 (0.25" @ 0deg, 2 holes,
    // same wall) -> 1 flip. Total 2, not 3 (one per hole would be wrong) -
    // and no rotary axis, so this is a manual pause, not an axis move.
    expect(tagCount).toBe(2);
    expect(pauseCount).toBe(2);
  });

  it('never prompts to flip the tube within a single-face program - it only ever covers one already-fixtured face', () => {
    const result = generateTubestockGcode(twoWallTube(), baseParams);
    for (const file of result.gcodeFiles) {
      expect(file.gcode).not.toMatch(/FLIP TUBE|index rotary axis/);
    }
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
    it('defaults to linuxcnc: parenthesis comments, G55, M00 tool-change pause, M30 end', () => {
      const result = generateTubestockGcode(twoWallTube(), baseParams);
      expect(result.gcode).toContain('G55');
      expect(result.gcode).toContain('M00 (TOOL CHANGE');
      expect(result.gcode).toContain('M30 (program end)');
      expect(result.gcode).not.toContain('[');
    });

    it('wincnc: bracket comments, no stored work offset, G4 dwell-pause instead of M00, no M30', () => {
      const result = generateTubestockGcode(twoWallTube(), { ...baseParams, controller: 'wincnc' });
      // Not a blanket substring check - the WinCNC path's own explanatory
      // comment mentions "G54-style" prose, which would false-positive a
      // plain .not.toContain('G54') check without actually emitting the code.
      expect(result.gcode.split('\n').some((l) => /^G5[45]\b/.test(l))).toBe(false);
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

  describe('real-stock cross-section check (CamParamFields.svelte\'s "Stock" picker, resolved server-side into expectedOuterA/B - see /api/cam-generate)', () => {
    function tubeWithCrossSection(a, b) {
      return { ...twoWallTube(), crossSection: { a, b } };
    }

    it('generates normally when the selected stock matches the STEP file\'s measured cross-section', () => {
      const result = generateTubestockGcode(tubeWithCrossSection(1.0, 2.0), { ...baseParams, expectedOuterA: 1.0, expectedOuterB: 2.0 });
      expect(result.gcode).toContain('M30');
    });

    it('matches regardless of which axis the STEP file happened to call "a" vs "b" - same real tube either way', () => {
      const result = generateTubestockGcode(tubeWithCrossSection(2.0, 1.0), { ...baseParams, expectedOuterA: 1.0, expectedOuterB: 2.0 });
      expect(result.gcode).toContain('M30');
    });

    it('tolerates real extrusion tolerance (a hair under/over nominal), not just an exact match', () => {
      const result = generateTubestockGcode(tubeWithCrossSection(1.01, 1.99), { ...baseParams, expectedOuterA: 1.0, expectedOuterB: 2.0 });
      expect(result.gcode).toContain('M30');
    });

    it('rejects generation when the selected stock does not match the STEP file\'s real measured cross-section - the wrong tube would otherwise silently get loaded', () => {
      expect(() => generateTubestockGcode(tubeWithCrossSection(1.0, 1.0), { ...baseParams, expectedOuterA: 1.0, expectedOuterB: 2.0 }))
        .toThrow(/Selected stock is 1x2|measured cross-section/);
    });

    it('skips the check entirely when no stock was selected (expectedOuterA/B absent) - optional, not a new required field on old jobs', () => {
      const result = generateTubestockGcode(tubeWithCrossSection(5, 5), baseParams);
      expect(result.gcode).toContain('M30');
    });
  });
});

describe('tube faces are numbered the way the shop numbers them', () => {
  // The router manual labels tube sides 3, 6, 9 and 12 clockwise, and the
  // checklist has the operator write those numbers on the tube. The files
  // have to match, or they are translating between two schemes at the
  // machine with a tube already clamped in the fixture.
  it('maps each wall to its clock position', () => {
    expect(tubestockFaceClock(0)).toBe(12);
    expect(tubestockFaceClock(90)).toBe(3);
    expect(tubestockFaceClock(180)).toBe(6);
    expect(tubestockFaceClock(270)).toBe(9);
  });

  it('wraps a full turn back onto 12', () => {
    expect(tubestockFaceClock(360)).toBe(12);
    expect(tubestockFaceLabel(360)).toBe('Side 12');
  });

  it('labels and names files by that number', () => {
    expect(tubestockFaceLabel(90)).toBe('Side 3');
    expect(tubestockFaceFileName('p006946.ngc', 90)).toBe('p006946-side-3.ngc');
    expect(tubestockFaceFileName('p006946.ngc', 270)).toBe('p006946-side-9.ngc');
  });

  it('keeps the file extension it was given', () => {
    expect(tubestockFaceFileName('part.nc', 180)).toBe('part-side-6.nc');
  });

  it('falls back rather than inventing a clock position for a non-cardinal wall', () => {
    expect(tubestockFaceClock(45)).toBeNull();
    expect(tubestockFaceLabel(45)).toBe('Face A45');
    expect(tubestockFaceFileName('tube.ngc', 45)).toBe('tube-face-a45.ngc');
  });

  it('gives every face of a real tube a distinct file', () => {
    const fourFace = { tubeLength: 12, walls: [0, 90, 180, 270].map((angleDeg, i) => ({
      angleDeg, holes: [{ position: 2 + i, lateralOffset: 0, diameter: 0.25 }]
    })) };
    const { gcodeFiles } = generateTubestockGcode(fourFace, baseParams);
    expect(gcodeFiles.map((f) => f.label)).toEqual(['Side 12', 'Side 3', 'Side 6', 'Side 9']);
    const names = gcodeFiles.map((f) => tubestockFaceFileName('t.ngc', f.angleDeg));
    expect(new Set(names).size).toBe(4);
  });
});

describe('tube stock work offset', () => {
  // The router manual has the operator type g55 into the MDI "before doing
  // anything else" for tube stock, and repeats it in the tube stock
  // checklist as something to redo for every cut. Emitting it means the
  // program cannot silently run in the sheet-setup coordinate system
  // because that step was missed - on a fixture the tube is clamped into,
  // that would put the entire program in the wrong place.
  it('selects G55 rather than the sheet setup G54', () => {
    const { gcode } = generateTubestockGcode(twoWallTube(), baseParams);
    const codeLines = gcode.split('\n').map((line) => line.replace(/\(.*$/, '').trim());
    expect(codeLines.some((line) => /^G55\b/.test(line))).toBe(true);
    expect(codeLines.some((line) => /^G54\b/.test(line))).toBe(false);
  });

  it('selects it in every per-face program, not only the combined one', () => {
    const { gcodeFiles } = generateTubestockGcode(twoWallTube(), baseParams);
    expect(gcodeFiles.length).toBeGreaterThan(1);
    for (const face of gcodeFiles) {
      const codeLines = face.gcode.split('\n').map((line) => line.replace(/\(.*$/, '').trim());
      expect(codeLines.some((line) => /^G55\b/.test(line)), face.label).toBe(true);
    }
  });

  it('leaves routing alone - sheets are still set up in G54', async () => {
    const { generateRoutingGcode } = await import('./routing.js');
    const square = [{ points: [{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4},{x:0,y:0}], isHole: false }];
    const { gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.25 });
    expect(gcode.split('\n').some((line) => /^G54\b/.test(line.trim()))).toBe(true);
  });
});

describe('holeDepthForWall', () => {
  // Wall thickness is a property of the tube, so there is exactly one correct
  // depth per stock. These are the two walls the team actually stocks.
  it('adds the break-through allowance to a 1/16" wall', () => {
    expect(holeDepthForWall(0.0625)).toBe(0.0825);
  });

  it('adds the break-through allowance to a 1/8" wall', () => {
    expect(holeDepthForWall(0.125)).toBe(0.145);
  });

  it('always clears the wall it is drilling', () => {
    for (const wall of [0.0625, 0.09, 0.125, 0.25]) {
      expect(holeDepthForWall(wall)).toBeGreaterThan(wall);
    }
  });

  it('produces a depth the generator accepts', () => {
    const depth = holeDepthForWall(0.125);
    const result = generateTubestockGcode(twoWallTube(), { holeDepth: depth });
    const gcode = typeof result === 'string' ? result : result.gcode;
    expect(gcode).toContain('Z-0.1450');
  });

  it('returns null rather than a guess when the stock has no wall recorded', () => {
    expect(holeDepthForWall(undefined)).toBeNull();
    expect(holeDepthForWall(null)).toBeNull();
    expect(holeDepthForWall(0)).toBeNull();
    expect(holeDepthForWall(-0.1)).toBeNull();
    expect(holeDepthForWall('thin')).toBeNull();
  });
});
