import { describe, it, expect } from 'vitest';
import { normalizeGcodeComments, MAX_GCODE_LINE_LENGTH } from './gcodeComments.js';
import { generateRoutingGcode } from './inprocess/routing.js';
import { HEADER_WARNING } from './inprocess/turning.js';
import { generateTurningGcode } from './inprocess/turning.js';
import { generateTubestockGcode } from './inprocess/tubestock.js';

const SQUARE = [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], isHole: false }];
const TUBE = { tubeLength: 12, walls: [{ angleDeg: 0, holes: [{ position: 2, lateralOffset: 0, diameter: 0.25 }] }] };

/**
 * Every line where a comment opens and then closes with text still after it -
 * that trailing text is live G-code the operator never intended to send.
 */
function linesWithLiveTextAfterAComment(gcode) {
  const offenders = [];
  for (const line of gcode.split('\n')) {
    for (const [open, close] of [['(', ')'], ['[', ']']]) {
      const start = line.indexOf(open);
      if (start === -1) continue;
      const end = line.indexOf(close, start);
      if (end === -1) continue;
      if (line.slice(end + 1).trim()) offenders.push(line);
    }
  }
  return offenders;
}

describe('normalizeGcodeComments', () => {
  it('strips parentheses out of comment text so the comment cannot close early', () => {
    const input = '(  CAMotics) and do a supervised air-cut before running on material. )';
    expect(normalizeGcodeComments(input)).toBe('(  CAMotics and do a supervised air-cut before running on material.)');
  });

  it('keeps the code ahead of an end-of-line comment untouched', () => {
    expect(normalizeGcodeComments('G01 X1.5 Y2.0 F20 (rapid to hole position)'))
      .toBe('G01 X1.5 Y2.0 F20 (rapid to hole position)');
  });

  it('renders wincnc comments in brackets without leaving live text behind', () => {
    const input = "(Jog to the workpiece origin and zero the controller (WinCNC local coordinates, G92) BEFORE running)";
    const out = normalizeGcodeComments(input, { dialect: 'wincnc' });
    expect(out).toBe('[Jog to the workpiece origin and zero the controller WinCNC local coordinates, G92 BEFORE running]');
    expect(linesWithLiveTextAfterAComment(out)).toEqual([]);
  });

  it('leaves a line with no comment alone', () => {
    expect(normalizeGcodeComments('G00 X1 Y2 Z0.25')).toBe('G00 X1 Y2 Z0.25');
    expect(normalizeGcodeComments('%')).toBe('%');
  });

  it('handles an unterminated comment', () => {
    expect(normalizeGcodeComments('(no closing delimiter')).toBe('(no closing delimiter)');
  });
});

describe('generated programs have well-formed comments', () => {
  // Regression: the header banner every program starts with contained
  // "...simulator (e.g. ncviewer.com, CAMotics) and do a supervised air-cut
  // ...", whose inner ")" ended the comment and left the rest of the line as
  // live code. The wincnc path was worse - a blanket "(" -> "[" swap turned
  // that into "[G92] BEFORE running this file - WinCNC has no G54-style
  // stored work offset]", leaving a bare G54 on a controller that same
  // comment says has no G54 support.
  const programs = {
    'routing (linuxcnc)': () => generateRoutingGcode(SQUARE, { toolDiameter: 0.25, targetDepth: 0.2 }).gcode,
    'routing (wincnc)': () => generateRoutingGcode(SQUARE, { toolDiameter: 0.25, targetDepth: 0.2, controller: 'wincnc' }).gcode,
    'routing (long/thin turning warning path)': () => generateTurningGcode(
      [{ z: 0, radius: 0.06 }, { z: -4, radius: 0.06 }], { stockDiameter: 0.25 }
    ).gcode,
    'turning': () => generateTurningGcode([{ z: 0, radius: 0.5 }, { z: -1, radius: 0.5 }], { stockDiameter: 1.25 }).gcode,
    'tubestock (linuxcnc)': () => generateTubestockGcode(TUBE, { holeDepth: 0.15 }).gcode,
    'tubestock (wincnc)': () => generateTubestockGcode(TUBE, { holeDepth: 0.15, controller: 'wincnc' }).gcode
  };

  for (const [name, build] of Object.entries(programs)) {
    it(`${name}: no comment leaves live text on its line`, () => {
      expect(linesWithLiveTextAfterAComment(build())).toEqual([]);
    });
  }

  it('never emits a nested comment delimiter', () => {
    for (const build of Object.values(programs)) {
      for (const line of build().split('\n')) {
        const start = line.indexOf('(') !== -1 ? line.indexOf('(') : line.indexOf('[');
        if (start === -1) continue;
        // Between the opening delimiter and the end of the line there must
        // be no second opening delimiter - that is what nesting looks like.
        expect(line.slice(start + 1)).not.toMatch(/[([]/);
      }
    }
  });

  it('wincnc output uses brackets and keeps no stray parentheses', () => {
    const gcode = generateRoutingGcode(SQUARE, { toolDiameter: 0.25, targetDepth: 0.2, controller: 'wincnc' }).gcode;
    expect(gcode).not.toMatch(/[()]/);
    expect(gcode).toMatch(/\[/);
  });
});

describe('normalizeGcodeComments - cleaning an already-generated program', () => {
  const nestedLines = (gcode) => gcode.split('\n').filter((line) => {
    const start = line.search(/[([]/);
    return start !== -1 && /[([]/.test(line.slice(start + 1));
  });

  it("fixes a stored linuxcnc program without changing its dialect", () => {
    // Verbatim line 4 of every job generated before the comment fix. A
    // controller reports "nested comment found" and stops on it.
    const stored = '(  CAMotics) and do a supervised air-cut before running on material. )\nG01 X1.5 Y2 F20';
    const out = normalizeGcodeComments(stored, { dialect: 'preserve' });
    expect(nestedLines(out)).toEqual([]);
    expect(out).toContain('(  CAMotics and do a supervised air-cut before running on material.)');
    expect(out).toContain('G01 X1.5 Y2 F20');
  });

  it('fixes a stored wincnc program and leaves it bracketed', () => {
    // Looking only for "(" meant a WinCNC program passed through untouched,
    // which is exactly the one that needed it most.
    const stored = '[  SIMULATOR. Run this through a simulator [e.g. ncviewer.com,]\nG01 X1 Y2 F20';
    const out = normalizeGcodeComments(stored, { dialect: 'preserve' });
    expect(nestedLines(out)).toEqual([]);
    expect(out).toContain('[');
    expect(out).not.toContain('(');
  });

  it('never touches a command line', () => {
    const program = ['%', 'G20', 'G90', 'G01 X1.5 Y-2.25 Z-0.1 F20', 'G02 X3 Y0 I-1 J0', 'M05', 'M30'].join('\n');
    expect(normalizeGcodeComments(program, { dialect: 'preserve' })).toBe(program);
  });

  it('does not rewrite LinuxCNC bracket expressions as WinCNC comments', () => {
    const program = 'G01 X[#1+2] Y[3*4] Z[SIN[30]] F20 (calculated move)';
    expect(normalizeGcodeComments(program, { dialect: 'preserve' })).toBe(program);
  });

  it('repairs a following comment without touching LinuxCNC bracket expressions', () => {
    const program = 'G01 X[#1+2] Y[3*4] F20 (calculated (move))';
    expect(normalizeGcodeComments(program, { dialect: 'preserve' }))
      .toBe('G01 X[#1+2] Y[3*4] F20 (calculated move)');
  });

  it('still cleans a WinCNC comment that begins with a function word', () => {
    const program = 'G01 X1 [sin setup (dry run)]';
    expect(normalizeGcodeComments(program, { dialect: 'preserve' }))
      .toBe('G01 X1 [sin setup dry run]');
  });

  it('leaves an already-clean comment exactly as it is', () => {
    const clean = 'G01 X1 Y2 F20 (rapid to hole position)';
    expect(normalizeGcodeComments(clean, { dialect: 'preserve' })).toBe(clean);
  });
});

describe('normalizeGcodeComments line length', () => {
  it('shortens a comment that would push the line past the interpreter limit', () => {
    const line = `(GROUPED ROUTER PROGRAM: ${'part-name-'.repeat(30)})`;
    expect(line.length).toBeGreaterThan(MAX_GCODE_LINE_LENGTH);
    const out = normalizeGcodeComments(line);
    expect(out.length).toBeLessThanOrEqual(MAX_GCODE_LINE_LENGTH);
    expect(out.startsWith('(GROUPED ROUTER PROGRAM: part-name-')).toBe(true);
    expect(out.endsWith(')')).toBe(true);
  });

  it('leaves the code before the comment untouched while shortening it', () => {
    const out = normalizeGcodeComments(`G01 X1.5 Y2.5 F20 (${'reason '.repeat(60)})`);
    expect(out.startsWith('G01 X1.5 Y2.5 F20 (')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_GCODE_LINE_LENGTH);
  });

  it('does not touch a comment that already fits', () => {
    const line = 'G01 X1.5 Y2.5 F20 (feed move)';
    expect(normalizeGcodeComments(line)).toBe(line);
  });

  it('shortens in the WinCNC dialect too', () => {
    const out = normalizeGcodeComments(`(${'x'.repeat(400)})`, { dialect: 'wincnc' });
    expect(out.length).toBeLessThanOrEqual(MAX_GCODE_LINE_LENGTH);
    expect(out.startsWith('[')).toBe(true);
    expect(out.endsWith(']')).toBe(true);
  });
});

describe('the shared header banner', () => {
  it('contains no parenthesis inside its own text, so it can never nest', () => {
    for (const line of HEADER_WARNING) {
      expect(line.startsWith('(')).toBe(true);
      expect(line.endsWith(')')).toBe(true);
      expect(line.slice(1, -1)).not.toMatch(/[()[\]]/);
    }
  });

  it('needs no repair from the normalizer', () => {
    const banner = HEADER_WARNING.join('\n');
    expect(normalizeGcodeComments(banner)).toBe(banner);
  });

  it('fits the interpreter line limit', () => {
    for (const line of HEADER_WARNING) {
      expect(line.length).toBeLessThanOrEqual(MAX_GCODE_LINE_LENGTH);
    }
  });

  // The output has been cut on the machine, so the banner must not keep
  // telling the operator it is unproven - a warning nobody can act on is a
  // warning people learn to scroll past.
  it('no longer claims the output is unverified on real hardware', () => {
    const banner = HEADER_WARNING.join('\n');
    expect(banner).not.toMatch(/NOT VERIFIED/i);
    expect(banner).not.toMatch(/real hardware/i);
    expect(banner).not.toMatch(/ncviewer|CAMotics/i);
  });

  it('still asks for the per-setup check before cutting', () => {
    const banner = HEADER_WARNING.join('\n').toLowerCase();
    expect(banner).toContain('work zero');
    expect(banner).toContain('dry-run');
  });
});
