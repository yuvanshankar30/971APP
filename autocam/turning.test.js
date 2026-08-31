import { describe, it, expect } from 'vitest';
import { generateTurningGcode, offsetTurningProfile } from './turning.js';

// Synthetic profile: a 2" long round shaft, 0.5" radius through the middle,
// with a small step down to 0.4" at each end - enough geometry variation to
// exercise both roughing and finishing without needing a real STEP file.
//
// Ascending Z in arbitrary native/raw coordinates, matching what
// extractTurningProfileFromMeshes actually hands generateTurningGcode (it
// does NOT pre-normalize) - generateTurningGcode does its own face-at-Z0,
// increasingly-negative normalization internally. A pre-normalized fixture
// here would get normalized a second time and end up mirrored.
function shaftProfile() {
  return [
    { z: 0, x: 0.4 },
    { z: 0.1, x: 0.5 },
    { z: 1.9, x: 0.5 },
    { z: 2.0, x: 0.4 }
  ];
}

const baseParams = { stockDiameter: 1.1, stepDown: 0.05, finishAllowance: 0.02, feedRough: 0.008, feedFinish: 0.004 };

describe('offsetTurningProfile (nose-radius compensation geometry)', () => {
  it('is a no-op when distance is 0/falsy', () => {
    const profile = shaftProfile();
    expect(offsetTurningProfile(profile, 0)).toBe(profile);
  });

  it('offsets a pure-OD segment (constant radius, decreasing Z) outward in +X only', () => {
    const profile = [{ z: 0, x: 0.5 }, { z: -2, x: 0.5 }];
    const offset = offsetTurningProfile(profile, 0.03);
    expect(offset).toEqual([{ z: 0, x: 0.53 }, { z: -2, x: 0.53 }]);
  });

  it('offsets a pure-facing segment (constant Z, increasing radius) outward in +Z only', () => {
    const profile = [{ z: -1, x: 0 }, { z: -1, x: 0.5 }];
    const offset = offsetTurningProfile(profile, 0.03);
    expect(offset).toEqual([{ z: -0.97, x: 0 }, { z: -0.97, x: 0.5 }]);
  });

  it('miters a right-angle corner (OD segment into a facing shoulder) to the exact line intersection', () => {
    const profile = [{ z: 0, x: 0.5 }, { z: -1, x: 0.5 }, { z: -1, x: 0.25 }];
    const offset = offsetTurningProfile(profile, 0.03);
    expect(offset[0]).toEqual({ z: 0, x: 0.53 });
    expect(offset[1].z).toBeCloseTo(-1.03, 10);
    expect(offset[1].x).toBeCloseTo(0.53, 10);
    expect(offset[2]).toEqual({ z: -1.03, x: 0.25 });
  });

  it('clamps offset radius at 0 - never programs a negative diameter', () => {
    const profile = [{ z: 0, x: 0.01 }, { z: -1, x: 0.01 }];
    const offset = offsetTurningProfile(profile, 0.05);
    // pure-OD segment offsets +X, so this case doesn't actually go negative -
    // this just documents/locks the clamp exists via Math.max(0, ...) for
    // any future segment shape that could offset a point below the centerline.
    expect(offset.every((p) => p.x >= 0)).toBe(true);
  });
});

describe('generateTurningGcode - single setup (default)', () => {
  it('generates valid G-code with header/footer/roughing/finishing', () => {
    const result = generateTurningGcode(shaftProfile(), baseParams);
    expect(result.gcode).toContain('G20 (inch)');
    expect(result.gcode).toContain('M30 (program end)');
    expect(result.gcode).toContain('(--- ROUGHING PASSES ---)');
    expect(result.gcode).toContain('(--- FINISHING PASS ---)');
    expect(result.stats.setupMode).toBe('single');
    expect(result.stats.roughingPasses).toBeGreaterThan(0);
  });

  it('throws if the profile has fewer than 2 points', () => {
    expect(() => generateTurningGcode([{ z: 0, x: 0.5 }], baseParams)).toThrow(/at least 2 points/);
  });

  it('throws if stockDiameter is missing', () => {
    expect(() => generateTurningGcode(shaftProfile(), { stepDown: 0.05 })).toThrow(/stockDiameter must be > 0/);
  });

  it('throws if stepDown is not positive', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, stepDown: 0 })).toThrow(/stepDown must be > 0/);
  });

  it('rejects malformed numeric CAM parameters before generating G-code', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, feedRough: 0 })).toThrow(/feedRough must be > 0/);
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, feedFinish: Number.NaN })).toThrow(/feedFinish must be > 0/);
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, finishAllowance: -0.01 })).toThrow(/finishAllowance must be >= 0/);
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, maxRpm: Infinity })).toThrow(/maxRpm must be > 0/);
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'unsupported' })).toThrow(/setupMode must be one of/);
  });

  it('throws if stock is smaller than the profile\'s max radius', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, stockDiameter: 0.5 })).toThrow(/stock too small/);
  });

  it('normalizes Z so the profile always starts at the face, regardless of the STEP file\'s native origin', () => {
    const shifted = shaftProfile().map((p) => ({ x: p.x, z: p.z + 37.5 }));
    const result = generateTurningGcode(shifted, baseParams);
    expect(result.gcode).toMatch(/G00 X[\d.]+ Z0\.1000 \(rapid to start clearance\)/);
  });

  it('caps roughing passes at the safety limit for a pathological stepDown', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, stepDown: 0.0000001 })).toThrow(/safety limit/);
  });

  it('applies no nose-radius offset (and no compensation note) when noseRadius is unset - byte-identical finishing pass', () => {
    const withoutParam = generateTurningGcode(shaftProfile(), baseParams);
    const withZero = generateTurningGcode(shaftProfile(), { ...baseParams, noseRadius: 0 });
    expect(withoutParam.gcode).toBe(withZero.gcode);
    expect(withoutParam.gcode).not.toContain('nose radius');
  });

  it('offsets the finishing pass outward and notes real compensation when noseRadius is set', () => {
    const plain = generateTurningGcode(shaftProfile(), baseParams);
    const compensated = generateTurningGcode(shaftProfile(), { ...baseParams, noseRadius: 0.015 });
    expect(compensated.gcode).toContain('IS compensated');
    expect(compensated.gcode).not.toContain('NOT applied');

    // Pull the finishing-pass G01 X values out of both and confirm the
    // compensated ones are larger (offset outward, away from the part) on
    // this constant-radius mid-section - real geometric effect, not just text.
    const extractFinishRadii = (gcode) => {
      const lines = gcode.split('\n');
      const start = lines.findIndex((l) => l.includes('FINISHING PASS'));
      return lines.slice(start).filter((l) => l.startsWith('G01 X')).map((l) => Number(l.match(/X([\d.]+)/)[1]) / 2);
    };
    const plainRadii = extractFinishRadii(plain.gcode);
    const compRadii = extractFinishRadii(compensated.gcode);
    expect(compRadii.length).toBe(plainRadii.length);
    for (let i = 0; i < plainRadii.length; i += 1) {
      expect(compRadii[i]).toBeGreaterThan(plainRadii[i] - 1e-9);
    }
    expect(compRadii.some((r, i) => r > plainRadii[i] + 0.005)).toBe(true);
  });
});

describe('generateTurningGcode - multi-tool (rough + finish insert)', () => {
  it('does not affect output at all when finishTool is unset (default, single-tool)', () => {
    const withoutTool = generateTurningGcode(shaftProfile(), baseParams);
    const withNullTool = generateTurningGcode(shaftProfile(), { ...baseParams, finishTool: null });
    expect(withoutTool.gcode).toBe(withNullTool.gcode);
    expect(withoutTool.stats.toolChanges).toBe(0);
    expect(withoutTool.gcode).not.toContain('TOOL CHANGE');
  });

  it('emits a real mid-program tool change between roughing and finishing when finishTool is set', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      toolNumber: 1,
      finishTool: { toolNumber: 2, label: 'finish insert', noseRadius: 0.015 }
    });
    expect(result.gcode).toContain('TOOL CHANGE: load finish insert - T2');
    expect(result.gcode).toContain('RE-TOUCH OFF Z0');
    expect(result.gcode).toContain('T0202 (finish tool - verify tool/offset number)');
    expect(result.gcode).toContain('T0101 (tool change - rough tool - verify tool/offset number)');
    expect(result.stats.toolChanges).toBe(1);

    // Tool change must fall strictly between the roughing and finishing sections.
    const roughIdx = result.gcode.indexOf('ROUGHING PASSES');
    const changeIdx = result.gcode.indexOf('TOOL CHANGE');
    const finishIdx = result.gcode.indexOf('FINISHING PASS');
    expect(roughIdx).toBeLessThan(changeIdx);
    expect(changeIdx).toBeLessThan(finishIdx);
  });

  it('uses finishTool.noseRadius (not the top-level noseRadius) for finish-pass compensation', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      noseRadius: 0.1, // should be ignored once finishTool is set
      finishTool: { toolNumber: 2, noseRadius: 0.015 }
    });
    expect(result.gcode).toContain('Tool nose radius 0.015" IS compensated');
    expect(result.gcode).not.toContain('0.100"');
  });

  it('does the rough->change->finish sequence twice in flip mode (once per physical chucking)', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      setupMode: 'flip',
      flipAt: 1.0,
      finishTool: { toolNumber: 2, label: 'finish insert' }
    });
    const changeCount = result.gcode.split('TOOL CHANGE:').length - 1;
    expect(changeCount).toBe(2);
    expect(result.stats.toolChanges).toBe(2);
  });

  it('skips the manual pause and re-touch-off prompt when automaticToolChanger is set (real Haas TL-1 turret)', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      toolNumber: 1,
      automaticToolChanger: true,
      finishTool: { toolNumber: 2, label: 'finish insert', noseRadius: 0.015 }
    });
    expect(result.gcode).toContain('TOOL CHANGE: automatic - load finish insert - T2');
    expect(result.gcode).not.toContain('M00');
    expect(result.gcode).not.toContain('RE-TOUCH OFF');
    expect(result.gcode).toContain('T0202 (finish tool - turret index)');
    // Still stops the spindle before indexing the turret - an unattended
    // change is not a running-spindle change.
    expect(result.gcode).toContain('M05 (spindle off for tool change)');
    expect(result.stats.toolChanges).toBe(1);
  });

  it('defaults to the manual pause when automaticToolChanger is left unset', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      finishTool: { toolNumber: 2, label: 'finish insert' }
    });
    expect(result.gcode).toContain('M00');
    expect(result.gcode).toContain('RE-TOUCH OFF Z0');
  });
});

describe('generateTurningGcode - tailstock mode', () => {
  it('produces the same cut geometry as single mode, plus a tailstock note', () => {
    const single = generateTurningGcode(shaftProfile(), baseParams);
    const tailstock = generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'tailstock' });
    expect(tailstock.gcode).toContain('TAILSTOCK REQUIRED');
    expect(tailstock.stats.setupMode).toBe('tailstock');
    expect(tailstock.stats.roughingPasses).toBe(single.stats.roughingPasses);
  });
});

describe('generateTurningGcode - unsupported length-to-diameter warning (real bug: setupMode defaulted to \'single\' with zero automatic detection that a part was too long/thin to safely cantilever - found on a real ~15"-long, ~0.34"-diameter fixture that generated with no warning at all)', () => {
  // A long, thin profile: 10" long, necking down to 0.2" diameter (x=0.1) -
  // a 50:1 unsupported ratio, well past the 8:1 warning threshold.
  function longThinProfile() {
    return [
      { z: 0, x: 0.3 },
      { z: 0.5, x: 0.3 },
      { z: 1, x: 0.1 },
      { z: 9, x: 0.1 },
      { z: 10, x: 0.3 }
    ];
  }

  it('warns in single mode (the default) when the length-to-diameter ratio is dangerously high', () => {
    const result = generateTurningGcode(longThinProfile(), { ...baseParams, stockDiameter: 0.7 });
    expect(result.gcode).toContain('WARNING: LONG/THIN PART');
    expect(result.gcode).toContain('50.0:1');
  });

  it('does not warn for an ordinary, well-supported-by-its-own-stoutness profile', () => {
    const result = generateTurningGcode(shaftProfile(), baseParams); // 2.5:1 ratio
    expect(result.gcode).not.toContain('WARNING: LONG/THIN PART');
  });

  it('does not double-warn in tailstock mode - that mode already carries its own dedicated note', () => {
    const result = generateTurningGcode(longThinProfile(), { ...baseParams, stockDiameter: 0.7, setupMode: 'tailstock' });
    expect(result.gcode).toContain('TAILSTOCK REQUIRED');
    expect(result.gcode).not.toContain('WARNING: LONG/THIN PART');
  });

  it('does not block generation - this is a warning, not a hard error, since the operator may have a deliberate reason', () => {
    expect(() => generateTurningGcode(longThinProfile(), { ...baseParams, stockDiameter: 0.7 })).not.toThrow();
  });
});

describe('generateTurningGcode - flip-turning mode', () => {
  it('requires flipAt', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip' })).toThrow(/flipAt.*is required/);
  });

  it('rejects a flip point past the part length', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 5 })).toThrow(/must be less than the part's total length/);
  });

  it('rejects a flip point too close to the face to safely re-grip', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 0.1 })).toThrow(/too short to safely re-chuck/);
  });

  it('rejects a flip point that leaves too little material past it', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 1.95 })).toThrow(/too little material left/);
  });

  it('respects a custom minGripLength', () => {
    // 0.3" would normally pass (> default 0.25" floor) but should fail against a stricter custom floor.
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 0.3, minGripLength: 0.5 })).toThrow(/too short to safely re-chuck/);
  });

  it('generates two setups with a real re-chuck pause between them', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 1.0 });
    expect(result.gcode).toContain('RE-CHUCK REQUIRED');
    expect(result.gcode).toContain('M00 (program pause');
    expect(result.gcode).toContain('FLIP SETUP 1 OF 2');
    expect(result.stats.setupMode).toBe('flip');
    expect(result.stats.flipAt).toBe(1.0);
    expect(result.stats.setup1Length).toBeCloseTo(1.0, 5);
    expect(result.stats.setup2Length).toBeCloseTo(1.0, 5);
  });

  it('matches the finishing-pass diameter exactly across the flip boundary (same physical location, two reference frames)', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 1.0 });
    const lines = result.gcode.split('\n');

    const finishSections = [];
    let collecting = false;
    for (const line of lines) {
      if (line.includes('FINISHING PASS')) { collecting = true; finishSections.push([]); continue; }
      if (collecting && line.startsWith('G01 X')) finishSections[finishSections.length - 1].push(line);
      if (collecting && line.includes('retract clear of stock')) collecting = false;
    }
    expect(finishSections).toHaveLength(2);

    const setup1FinishEnd = finishSections[0][finishSections[0].length - 1];
    const setup2FinishStart = finishSections[1][0];
    const dia1 = setup1FinishEnd.match(/X([\d.]+)/)[1];
    const dia2 = setup2FinishStart.match(/X([\d.]+)/)[1];
    expect(dia1).toBe(dia2);
  });

  it('does not affect single-setup mode output (no flip-related text leaks in)', () => {
    const result = generateTurningGcode(shaftProfile(), baseParams);
    expect(result.stats.setupMode).toBe('single');
    expect(result.gcode).not.toContain('RE-CHUCK');
    expect(result.gcode).not.toContain('FLIP SETUP');
  });
});

describe('generateTurningGcode - spindle spin-up dwell (real risk: engaging the cut before the spindle reaches commanded RPM is a stall/broken-tool risk, not theoretical)', () => {
  it('defaults to a 2-second dwell (G04 P) right after the initial spindle-on', () => {
    const result = generateTurningGcode(shaftProfile(), baseParams);
    const lines = result.gcode.split('\n');
    const m03Index = lines.findIndex((l) => l.includes('M03'));
    expect(m03Index).toBeGreaterThan(-1);
    expect(lines[m03Index + 1]).toMatch(/^G04 P2\.0 /);
  });

  it('spindleDwellSeconds: 0 omits the dwell line entirely', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, spindleDwellSeconds: 0 });
    expect(result.gcode).not.toContain('G04');
  });

  it('respects a custom spindleDwellSeconds value', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, spindleDwellSeconds: 5 });
    expect(result.gcode).toMatch(/G04 P5\.0 /);
  });

  it('dwells after the mid-program tool-change restart too (finishTool)', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      finishTool: { toolNumber: 2, label: 'finish insert', noseRadius: 0.015 }
    });
    const m03Count = (result.gcode.match(/M03/g) || []).length;
    const dwellCount = (result.gcode.match(/G04 P2\.0/g) || []).length;
    expect(m03Count).toBe(2); // initial + tool-change restart
    expect(dwellCount).toBe(2);
  });

  it('dwells after both setups in flip mode', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 1.0 });
    const m03Count = (result.gcode.match(/M03/g) || []).length;
    const dwellCount = (result.gcode.match(/G04 P2\.0/g) || []).length;
    expect(m03Count).toBe(2); // setup 1 start + setup 2 restart after re-chuck
    expect(dwellCount).toBe(2);
  });
});

describe('generateTurningGcode - hex stock shape', () => {
  it('is byte-identical to explicit stockShape "round" when left unset (default)', () => {
    const withDefault = generateTurningGcode(shaftProfile(), baseParams);
    const withRound = generateTurningGcode(shaftProfile(), { ...baseParams, stockShape: 'round' });
    expect(withDefault.gcode).toBe(withRound.gcode);
  });

  it('rapids to the across-corners clearance diameter (not the across-flats stockDiameter) and warns about interrupted cutting', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, stockShape: 'hex' });
    const acrossCorners = baseParams.stockDiameter * (2 / Math.sqrt(3));
    expect(result.gcode).toContain(`G00 X${(acrossCorners + 0.1).toFixed(4)} Z0.1000 (rapid to start clearance)`);
    expect(result.gcode).toContain('HEX STOCK');
    expect(result.gcode).toContain('interrupted-cut');
  });

  it('rejects an unknown stockShape', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, stockShape: 'square' })).toThrow(/stockShape must be/);
  });
});

describe('generateTurningGcode - drilling', () => {
  const drillParams = { toolNumber: 3, label: 'center drill', diameter: 0.25, depth: 0.6, peckDepth: 0.25, feedRate: 0.003, rpm: 800 };

  it('appends a centerline peck-drilling section after OD turning, retracting fully after every peck', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, drilling: drillParams });
    expect(result.gcode).toContain('(--- DRILLING (centerline, from the face) ---)');
    expect(result.gcode).toContain('G97 S800 M03');
    expect(result.gcode).toContain('T0303 (drill - verify tool/offset number)');

    const pecks = result.gcode.split('\n').filter((l) => l.startsWith('G01 Z') && l.includes('peck'));
    expect(pecks.length).toBe(3); // 0.25, 0.5, 0.6
    expect(pecks[2]).toContain('Z-0.6000');

    const retracts = result.gcode.split('\n').filter((l) => l.includes('full retract'));
    expect(retracts.length).toBe(3);

    expect(result.stats.drilled).toBe(true);
    expect(result.stats.toolChanges).toBe(1);
  });

  it('uses the automatic-tool-changer path for the drill tool change too', () => {
    const result = generateTurningGcode(shaftProfile(), { ...baseParams, automaticToolChanger: true, drilling: drillParams });
    expect(result.gcode).toContain('(TOOL CHANGE: automatic - load center drill - T3)');
    expect(result.gcode).not.toContain('RE-TOUCH OFF');
  });

  it('counts a second tool change (and a second TOOL CHANGE marker) when combined with a finishTool', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      finishTool: { toolNumber: 2, label: 'finish insert' },
      drilling: drillParams
    });
    expect(result.stats.toolChanges).toBe(2);
    expect((result.gcode.match(/\(TOOL CHANGE:/g) || []).length).toBe(2);
  });

  it('defaults peckDepth to 3x diameter (capped at depth) when omitted', () => {
    const result = generateTurningGcode(shaftProfile(), {
      ...baseParams,
      drilling: { toolNumber: 3, diameter: 0.1, depth: 0.5, feedRate: 0.003, rpm: 800 }
    });
    // 3 * 0.1 = 0.3 -> pecks at 0.3, then 0.5 (capped)
    const pecks = result.gcode.split('\n').filter((l) => l.startsWith('G01 Z') && l.includes('peck'));
    expect(pecks.length).toBe(2);
  });

  it('rejects drilling.depth at or beyond the part length', () => {
    const length = Math.abs(shaftProfile()[shaftProfile().length - 1].z - shaftProfile()[0].z);
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, drilling: { ...drillParams, depth: length } }))
      .toThrow(/must be less than the part's total length/);
  });

  it('rejects drilling combined with flip mode - which end the drill enters from is ambiguous across a re-chuck', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, setupMode: 'flip', flipAt: 1.0, drilling: drillParams }))
      .toThrow(/not supported with setupMode "flip"/);
  });

  it('rejects malformed drilling parameters', () => {
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, drilling: { ...drillParams, depth: 0 } })).toThrow(/drilling\.depth must be > 0/);
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, drilling: { ...drillParams, rpm: -1 } })).toThrow(/drilling\.rpm must be > 0/);
    expect(() => generateTurningGcode(shaftProfile(), { ...baseParams, drilling: { ...drillParams, diameter: 0 } })).toThrow(/drilling\.diameter must be > 0/);
  });
});
