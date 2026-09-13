import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertGcodeToInches } from './gcodeUnitConvert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('convertGcodeToInches - real Fusion-cammed WinCNC (.tap) output', () => {
  // Real job pulled directly from the live Supabase project's cam_jobs table
  // (fusion_nc_files[].contentBase64) - not synthetic. As of this writing,
  // every single completed .tap job in that table came out in millimeters
  // (G22) - this fixture is one of them, unmodified.
  const real = fs.readFileSync(path.join(__dirname, '__fixtures__', 'real-shopsabre-mm-example.tap'), 'utf8');

  it('detects wincnc dialect and mm units, converts, and reports the 25.4 factor', () => {
    const result = convertGcodeToInches(real);
    expect(result.converted).toBe(true);
    expect(result.dialect).toBe('wincnc');
    expect(result.factor).toBe(25.4);
  });

  it('replaces G22 with G20 and leaves no G22 anywhere in the output', () => {
    const { gcode } = convertGcodeToInches(real);
    expect(gcode).toMatch(/\bG20\b/);
    expect(gcode).not.toMatch(/\bG22\b/);
  });

  it('converts every X/Y/Z/I/J/F value by exactly 1/25.4, spot-checked against real lines', () => {
    const { gcode } = convertGcodeToInches(real);
    // Real line from the fixture: "G0 X28.277 Y95.658"
    expect(gcode).toContain(`X${(28.277 / 25.4).toFixed(4)}`);
    expect(gcode).toContain(`Y${(95.658 / 25.4).toFixed(4)}`);
    // Real line: "G1 Z1.67 F508."
    expect(gcode).toContain(`Z${(1.67 / 25.4).toFixed(4)}`);
    expect(gcode).toContain(`F${(508 / 25.4).toFixed(4)}`);
    // Real arc line: "G3 X28.677 Y94.658 I0.4 J0."
    expect(gcode).toContain(`I${(0.4 / 25.4).toFixed(4)}`);
  });

  it('never touches S (spindle speed), T (tool number), or M-codes', () => {
    const { gcode } = convertGcodeToInches(real);
    expect(gcode).toContain('S22000');
    expect(gcode).toMatch(/\bT1\b/);
    expect(gcode).toContain('M3');
  });

  it('leaves the WinCNC dwell line\'s X (a duration in seconds, not a length) untouched', () => {
    expect(real).toContain('G4 X4.');
    const { gcode } = convertGcodeToInches(real);
    expect(gcode).toContain('G4 X4.');
  });

  it('converts the tool-definition comment\'s D/CR/ZMIN dimensional fields too', () => {
    const { gcode } = convertGcodeToInches(real);
    expect(gcode).toContain(`D=${(4.001 / 25.4).toFixed(4)}`);
    expect(gcode).toContain(`ZMIN=${(-3.683 / 25.4).toFixed(4)}`);
  });

  it('keeps every non-comment line count and ordering identical to the source', () => {
    const { gcode } = convertGcodeToInches(real);
    expect(gcode.split('\n').length).toBe(real.split(/\r\n|\r|\n/).length);
  });
});

describe('convertGcodeToInches - dialect and edge cases', () => {
  it('passes an already-inch (G20) program through byte-for-byte unchanged', () => {
    const gcode = '[job]\nG90\nG20\nG0 X1.5 Y2.25\n';
    const result = convertGcodeToInches(gcode);
    expect(result.converted).toBe(false);
    expect(result.gcode).toBe(gcode);
  });

  it('leaves a program with no recognized unit selector untouched rather than guessing', () => {
    const gcode = '[job]\nG90\nG0 X1.5 Y2.25\n';
    const result = convertGcodeToInches(gcode);
    expect(result.converted).toBe(false);
    expect(result.gcode).toBe(gcode);
  });

  it('detects linuxcnc dialect ("(...)" comments) and treats G21 as millimeters', () => {
    const gcode = '%\n(1001)\nG90 G94 G17\nG21\nG0 X25.4 Y50.8\n';
    const result = convertGcodeToInches(gcode);
    expect(result.dialect).toBe('linuxcnc');
    expect(result.factor).toBe(25.4);
    expect(result.gcode).toContain('G20');
    expect(result.gcode).not.toMatch(/\bG21\b/);
    expect(result.gcode).toContain('X1.0000');
    expect(result.gcode).toContain('Y2.0000');
  });

  it('treats wincnc G21 as centimeters (never millimeters, per the real shopsabre.cps convention)', () => {
    const gcode = '[job]\nG90\nG21\nG0 X2.54 Y5.08\n';
    const result = convertGcodeToInches(gcode);
    expect(result.dialect).toBe('wincnc');
    expect(result.factor).toBe(2.54);
    expect(result.gcode).toContain('X1.0000');
    expect(result.gcode).toContain('Y2.0000');
  });

  it('linuxcnc dwell (G4 P...) needs no X exception - P is never a coordinate letter', () => {
    const gcode = '%\n(1001)\nG21\nG4 P2.0\nG0 X25.4\n';
    const result = convertGcodeToInches(gcode);
    expect(result.gcode).toContain('G4 P2.0'); // P untouched (not in LENGTH_WORD at all)
    expect(result.gcode).toContain('X1.0000');
  });

  it('handles a bare continuation line (no G word) using the still-modal previous motion', () => {
    const gcode = '[job]\nG90\nG22\nG1 X25.4 Y50.8 F508.\nY76.2 Z12.7\n';
    const { gcode: out } = convertGcodeToInches(gcode);
    expect(out).toContain('Y3.0000');
    expect(out).toContain('Z0.5000');
  });

  it('returns unchanged input for an empty string', () => {
    expect(convertGcodeToInches('')).toEqual({ gcode: '', converted: false, dialect: null, factor: null });
  });
});
