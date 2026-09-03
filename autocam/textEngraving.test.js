import { describe, expect, it } from 'vitest';
import { buildTextEngraving, sanitizeTextGcodeFileName } from './textEngraving.js';

describe('text engraving G-code', () => {
  it('turns supported text into safe, retracting inch G-code', () => {
    const result = buildTextEngraving({ text: 'A1', height: .5, depth: .02, safeZ: .2, feedRate: 30, plungeRate: 10 });
    expect(result.strokes.length).toBeGreaterThan(2);
    expect(result.gcode).toContain('G20 G90 G17');
    expect(result.gcode).toContain('G1 Z-0.02 F10');
    expect(result.gcode).toContain('G0 Z0.2');
    expect(result.gcode).toMatch(/M30\n$/);
  });

  it('reports unsupported glyphs and makes a safe filename', () => {
    expect(buildTextEngraving({ text: 'A@' }).unsupported).toEqual(['@']);
    expect(sanitizeTextGcodeFileName(' Pit label / left ')).toBe('Pit-label-left.ngc');
  });
});
