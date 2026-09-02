import { describe, expect, it } from 'vitest';
import { generateGroupedRoutingGcode, programBody, translateRoutingGcode } from './groupedGcode.js';

describe('programBody', () => {
  it.each(['G20', 'G21', 'G90', 'G17', 'G94', 'G54', 'M30', 'M02', 'M05', '%'])(
    'drops source setup/end line %s',
    (line) => expect(programBody(`G01 X1 Y1\n  ${line}  \nG01 X2 Y2`)).toEqual(['G01 X1 Y1', 'G01 X2 Y2'])
  );

  it.each(['S14000 M03', 'S14000 M3', 'S14000M03', '  S14000.5M3 (source spindle)'])(
    'drops source spindle-on spelling %s',
    (line) => expect(programBody(`G01 X1 Y1\n${line}\nG01 X2 Y2`)).toEqual(['G01 X1 Y1', 'G01 X2 Y2'])
  );

  it('keeps near-misses that are not source setup commands', () => {
    expect(programBody('G540 X1\nS14000 M04\nG01 X2 Y2')).toEqual(['G540 X1', 'S14000 M04', 'G01 X2 Y2']);
  });
});

describe('translateRoutingGcode', () => {
  it('does not translate a WinCNC dwell time', () => {
    expect(translateRoutingGcode('G04 X2.0', 8, 6)).toBe('G04 X2.0');
  });

  it.each([
    '(Part positioned clear of X0/Y0)',
    '[Part positioned clear of X0/Y0]'
  ])('keeps comment coordinates byte-identical: %s', (comment) => {
    expect(translateRoutingGcode(`G01 X1 Y2 ${comment}`, 8, 6)).toBe(`G01 X9 Y8 ${comment}`);
  });

  it('moves an arc endpoint without changing its relative I/J center', () => {
    const translated = translateRoutingGcode('G03 X1 Y2 I-0.5 J0.25', 8, 6);
    expect(translated).toBe('G03 X9 Y8 I-0.5 J0.25');
    const [, i, j] = translated.match(/I(-?[\d.]+) J(-?[\d.]+)/);
    expect(Math.hypot(Number(i), Number(j))).toBeCloseTo(Math.hypot(-0.5, 0.25), 12);
  });
});

describe('generateGroupedRoutingGcode', () => {
  const placements = [
    { name: 'A', gcode: 'G20\nG90\nS10000 M03\nG00 X0 Y0\nG01 X1 Y2\nM05\nM30', offsetX: 3, offsetY: 4 },
    { name: 'B', gcode: 'G20\nS10000M03\nG00 X0 Y0\nG01 X2 Y1\nM05\nM30', offsetX: 8, offsetY: 6 }
  ];

  it.each([
    ['linuxcnc', /M30 \(program end\)$/m],
    ['wincnc', /^\[PROGRAM END\]$/m]
  ])('emits one shared setup/end block and retracts before every part for %s', (controller, programEnd) => {
    const gcode = generateGroupedRoutingGcode({
      name: 'two parts', placements,
      params: { controller, safeZ: 0.5, spindleSpeed: 14000, edgeMargin: 0.5, toolDiameter: 0.25 }
    });
    expect(gcode.match(/^S\d+(?:\.\d+)?\s+M0?3\b/gm)).toHaveLength(1);
    expect(gcode.match(programEnd)).toHaveLength(1);
    expect(gcode.match(/retract between parts/g)).toHaveLength(2);
    expect(gcode).toContain('X4 Y6');
    expect(gcode).toContain('X10 Y7');
  });

  it('states both cut-edge and toolpath-centerline margins in the operator header', () => {
    const gcode = generateGroupedRoutingGcode({
      placements: [placements[0]],
      params: { edgeMargin: 0.125, toolDiameter: 0.25 }
    });
    expect(gcode).toContain('SHEET EDGE CLEARANCE: 0.125 in from cut edge; toolpath centerline margin 0.25 in for 0.25 in cutter');
  });
});
