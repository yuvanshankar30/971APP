import { describe, it, expect } from 'vitest';
import { normalizeGcodeComments } from './gcodeComments.js';
import { generateRoutingGcode } from './routing.js';
import { generateTurningGcode } from './turning.js';
import { generateTubestockGcode } from './tubestock.js';

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
