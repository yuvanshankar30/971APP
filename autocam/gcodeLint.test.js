import { describe, it, expect } from 'vitest';
import { lintGcode, repairGcodeComments } from './gcodeLint.js';

const messages = (list) => list.map((entry) => entry.message).join(' | ');

describe('lintGcode comments', () => {
  it('flags a nested comment', () => {
    const { errors } = lintGcode('(run this through a simulator (ncviewer.com))\nG21\nM2\n');
    expect(messages(errors)).toMatch(/Nested comment/);
  });

  it('flags an unclosed comment', () => {
    const { errors } = lintGcode('G21\n(this comment never closes\nM2\n');
    expect(messages(errors)).toMatch(/Unclosed comment/);
  });

  it('flags a stray closing parenthesis', () => {
    const { errors } = lintGcode('G21\nG1 X1 F10)\nM2\n');
    expect(messages(errors)).toMatch(/no comment open/);
  });

  it('accepts a well-formed comment', () => {
    const { errors } = lintGcode('(facing pass)\nG21\nG1 X1 F10\nM2\n');
    expect(errors).toEqual([]);
  });

  it('treats a semicolon as a comment to end of line', () => {
    const { errors } = lintGcode('G21 ; units are mm (really)\nG1 X1 F10\nM2\n');
    expect(errors).toEqual([]);
  });
});

describe('lintGcode characters and values', () => {
  it('flags a typographic character pasted from a document', () => {
    const { errors } = lintGcode('G21\nG1 X–10 F10\nM2\n');
    expect(messages(errors)).toMatch(/Bad character .*U\+2013/);
  });

  it('ignores bad characters inside a comment', () => {
    const { errors } = lintGcode('(feed – 20 in/min, 50% stepover)\nG21\nG1 X1 F10\nM2\n');
    expect(errors).toEqual([]);
  });

  it('flags a word with no value', () => {
    const { errors } = lintGcode('G21\nG1 X Y2 F10\nM2\n');
    expect(messages(errors)).toMatch(/"X" has no value/);
  });

  it('accepts negative, decimal and parameter values', () => {
    const { errors } = lintGcode('G21\n#1=4.5\nG1 X-1.5 Y#1 Z[#1+2] F10\nM2\n');
    expect(errors).toEqual([]);
  });

  it('does not read expression operators as valueless words', () => {
    const { errors } = lintGcode('G21\nG1 X[2 MOD 3] F10\nM2\n');
    expect(errors).toEqual([]);
  });

  it('leaves o-word programs alone rather than misreading their keywords', () => {
    const { errors } = lintGcode('G21\no100 sub\nG1 X1 F10\no100 endsub\nM2\n');
    expect(errors).toEqual([]);
  });
});

describe('lintGcode warnings', () => {
  it('warns when no units are set', () => {
    const { warnings } = lintGcode('G1 X1 F10\nM2\n');
    expect(messages(warnings)).toMatch(/G20 or G21/);
  });

  it('warns when the program has no end', () => {
    const { warnings } = lintGcode('G21\nG1 X1 F10\n');
    expect(messages(warnings)).toMatch(/M2 or M30/);
  });

  it('stays quiet on a complete program', () => {
    const { warnings } = lintGcode('G21\nG1 X1 F10\nM30\n');
    expect(warnings).toEqual([]);
  });

  it('says nothing at all about empty input', () => {
    const result = lintGcode('');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.commandLines).toBe(0);
  });
});

describe('lintGcode ordering', () => {
  it('reports findings in line order across both passes', () => {
    const { errors } = lintGcode('(a (b))\nG21\nG1 X Y2\nG0 Z0.25 (retract\nM2\n');
    const reported = errors.map((entry) => entry.line);
    expect(reported).toEqual([...reported].sort((a, b) => a - b));
    expect(reported).toContain(3);
    expect(reported).toContain(4);
  });
});

describe('lintGcode counts', () => {
  it('counts only lines that carry commands', () => {
    const result = lintGcode('(header)\n\nG21\nG1 X1 F10\n%\nM2\n');
    expect(result.commandLines).toBe(3);
    expect(result.lines).toBe(7);
  });
});

describe('repairGcodeComments', () => {
  it('removes the inner parenthesis that ends a comment early', () => {
    expect(repairGcodeComments('(simulate first (ncviewer.com))')).toBe('(simulate first ncviewer.com)');
  });

  it('closes an unclosed comment', () => {
    expect(repairGcodeComments('G21 (units')).toBe('G21 (units)');
  });

  it('drops a stray closing parenthesis', () => {
    expect(repairGcodeComments('G1 X1 F10)')).toBe('G1 X1 F10');
  });

  it('leaves an arithmetic expression untouched', () => {
    const line = 'G1 X[#1+2.0] Y3 F20';
    expect(repairGcodeComments(line)).toBe(line);
  });

  it('leaves a semicolon comment untouched', () => {
    const line = 'G21 ; feed is 20 (fast)';
    expect(repairGcodeComments(line)).toBe(line);
  });

  it('changes nothing in an already-clean program', () => {
    const program = '(facing pass)\nG21\nG90\nG1 X1 Y2 F10\nM2\n';
    expect(repairGcodeComments(program)).toBe(program);
  });

  it('produces output the linter then finds clean', () => {
    const broken = '(run it (ncviewer.com))\nG21 (units\nG1 X1 F10)\nM2\n';
    const { errors } = lintGcode(repairGcodeComments(broken));
    expect(errors).toEqual([]);
  });

  it('preserves every executable word while repairing', () => {
    const broken = '(a (b))\nG1 X1 Y2 F10 (feed (ipm))\nM2\n';
    const strip = (text) => text.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    expect(strip(repairGcodeComments(broken))).toBe(strip('(a)\nG1 X1 Y2 F10 (f)\nM2\n'));
  });
});
