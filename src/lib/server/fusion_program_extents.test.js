import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { measureNcFileExtents, measureProgramExtents } from './fusion_program_extents.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('measureProgramExtents', () => {
  it('measures per-axis travel from commanded coordinates', () => {
    const result = measureProgramExtents(['G20', 'G0 X1 Y2 Z0.5', 'G1 X4 Y-1 Z-0.25'].join('\n'));
    expect(result.units).toBe('in');
    expect(result.axes.X).toEqual({ min: 1, max: 4, span: 3 });
    expect(result.axes.Y).toEqual({ min: -1, max: 2, span: 3 });
    expect(result.axes.Z).toEqual({ min: -0.25, max: 0.5, span: 0.75 });
  });

  it('records declared units without converting them', () => {
    // The point of the span is comparing it to the machine's own travel
    // spec, so the program's own declared units are what matter.
    expect(measureProgramExtents('G21\nG1 X10').units).toBe('mm');
    expect(measureProgramExtents('G1 X10').units).toBe('unknown');
  });

  it('ignores coordinates inside comments', () => {
    // A post's header routinely describes the job in a comment; reading
    // those as real moves would inflate the span.
    const result = measureProgramExtents('(rough pass X999 Y999)\n; and Z999\nG1 X2 Y3');
    expect(result.axes.X).toEqual({ min: 2, max: 2, span: 0 });
    expect(result.axes.Y).toEqual({ min: 3, max: 3, span: 0 });
    expect(result.axes.Z).toBeUndefined();
  });

  it('ignores arc centre offsets, which are not positions', () => {
    const result = measureProgramExtents('G20\nG2 X1 Y1 I50 J50 K50');
    expect(result.axes.X.max).toBe(1);
    expect(result.axes.Y.max).toBe(1);
    expect(result.axes.Z).toBeUndefined();
  });

  it('omits an axis the program never commands rather than claiming a zero span', () => {
    const result = measureProgramExtents('G20\nG1 X1 Y1');
    expect(Object.keys(result.axes)).toEqual(['X', 'Y']);
  });

  it('handles line numbers, signs, and bare-decimal coordinates', () => {
    const result = measureProgramExtents('N10 G1 X-.5 Y+2.25 Z.125');
    expect(result.axes.X.min).toBe(-0.5);
    expect(result.axes.Y.max).toBe(2.25);
    expect(result.axes.Z.max).toBe(0.125);
  });

  it('returns an empty result for junk instead of throwing', () => {
    expect(measureProgramExtents('')).toEqual({ units: 'unknown', axes: {} });
    expect(measureProgramExtents(null)).toEqual({ units: 'unknown', axes: {} });
  });

  it('reproduces the real autocamtest43.ngc span from issue #359', () => {
    // Checked against the actual file in the shop's gcode/ folder - the very
    // program a "program exceeds machine maximum on X" report was filed
    // against. Its real span is ~12.28in x 8.16in, nowhere near a router's
    // travel, which is exactly what the issue concluded: the program was
    // never the problem, the G54 work offset was. Pinned here as a shape
    // check so the parser can't silently start disagreeing with a real post.
    const excerpt = [
      '%',
      '(1001)',
      'G90 G94 G17 G91.1',
      'G20',
      '(2D Contour1)',
      'G0 X0.4334 Y-0.077',
      'G1 Z-0.03 F20.',
      'G1 X12.7158 Y8.086',
      'G0 Z0.85',
      'M30',
      '%'
    ].join('\n');
    const result = measureProgramExtents(excerpt);
    expect(result.units).toBe('in');
    expect(result.axes.X.span).toBeCloseTo(12.2824, 4);
    expect(result.axes.Y.span).toBeCloseTo(8.163, 4);
    expect(result.axes.Z.span).toBeCloseTo(0.88, 4);
  });
});

describe('measureNcFileExtents', () => {
  it('combines every posted file into one overall span', () => {
    const result = measureNcFileExtents([
      { name: 'a.nc', contentBase64: b64('G20\nG1 X0 Y0') },
      { name: 'b.nc', contentBase64: b64('G20\nG1 X10 Y-4') }
    ]);
    expect(result.units).toBe('in');
    expect(result.combined.X).toEqual({ min: 0, max: 10, span: 10 });
    expect(result.combined.Y).toEqual({ min: -4, max: 0, span: 4 });
    expect(result.files.map((file) => file.name)).toEqual(['a.nc', 'b.nc']);
  });

  it('keeps each file measurable on its own, not just the combined span', () => {
    // A grouped job posts one file per operation; knowing which one is the
    // outlier is the point.
    const result = measureNcFileExtents([
      { name: 'small.nc', contentBase64: b64('G20\nG1 X1') },
      { name: 'big.nc', contentBase64: b64('G20\nG1 X40') }
    ]);
    expect(result.files.find((f) => f.name === 'big.nc').axes.X.max).toBe(40);
  });

  it('returns null when there is nothing measurable', () => {
    expect(measureNcFileExtents(null)).toBeNull();
    expect(measureNcFileExtents([])).toBeNull();
    expect(measureNcFileExtents([{ name: 'empty.nc', contentBase64: b64('(comment only)') }])).toBeNull();
  });
});
