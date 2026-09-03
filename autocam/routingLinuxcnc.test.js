/**
 * Every program the UNC router runs has to load in LinuxCNC. This puts the
 * real generator output through the same load-time rules the interpreter
 * applies, so a generator change that reintroduces something LinuxCNC
 * refuses is caught here rather than at the machine.
 *
 * Tube stock is included because it runs on the router too - it is drilled
 * on the router with the operator flipping the tube between faces, not on a
 * rotary axis.
 *
 * These assert the LinuxCNC dialect only. A WinCNC program is bracketed and
 * is not meant to load in LinuxCNC at all.
 *
 * The rules themselves are calibrated against the cncjs gcode-parser and
 * pygcode implementations, which agree with lintGcode line-for-line on a
 * real generated program.
 */

import { describe, it, expect } from 'vitest';
import { generateRoutingGcode } from './routing.js';
import { generateTubestockGcode } from './tubestock.js';
import { lintGcode } from './gcodeLint.js';
import { generateGroupedRoutingGcode } from './groupedGcode.js';
import { MAX_GCODE_LINE_LENGTH } from './gcodeComments.js';

function square(cx, cy, size) {
  const h = size / 2;
  return [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }, { x: cx - h, y: cy - h }];
}

function circle(cx, cy, r, segments = 64) {
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = (i / segments) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function tube() {
  return {
    tubeLength: 12,
    walls: [
      { angleDeg: 0, holes: [{ position: 2, lateralOffset: 0, diameter: 0.25 }, { position: 8, lateralOffset: 0, diameter: 0.25 }] },
      { angleDeg: 90, holes: [{ position: 5, lateralOffset: 0, diameter: 0.375 }] },
      { angleDeg: 180, holes: [] }
    ]
  };
}

const report = (name, result) => {
  const detail = [...result.errors, ...result.warnings]
    .map((entry) => `line ${entry.line}: ${entry.message}`)
    .join('\n');
  return `${name}\n${detail}`;
};

const outline = [{ points: square(0, 0, 4), isHole: false }];
const withHole = [
  { points: square(0, 0, 4), isHole: false },
  { points: circle(0, 0, 0.5), isHole: true }
];

const cases = [
  ['plain square', () => generateRoutingGcode(outline, { toolDiameter: 0.25, targetDepth: 0.25 })],
  ['square with tabs', () => generateRoutingGcode(outline, { toolDiameter: 0.25, targetDepth: 0.25, tabSpacing: 6 })],
  ['round part', () => generateRoutingGcode([{ points: circle(0, 0, 2), isHole: false }], { toolDiameter: 0.25, targetDepth: 0.25 })],
  ['part with an internal hole', () => generateRoutingGcode(withHole, { toolDiameter: 0.25, targetDepth: 0.25 })],
  ['metric output', () => generateRoutingGcode(outline, { toolDiameter: 0.25, targetDepth: 0.25, units: 'mm' })],
  ['explicit stock thickness', () => generateRoutingGcode(outline, { toolDiameter: 0.25, targetDepth: 0.25, stockThickness: 0.25 })],
  ['tube stock, all faces', () => generateTubestockGcode(tube(), { holeDepth: 0.15 })]
];

describe('router programs load in LinuxCNC', () => {
  for (const [name, generate] of cases) {
    it(`${name} has no load-time error`, () => {
      const generated = generate();
      const gcode = typeof generated === 'string' ? generated : generated.gcode;
      const result = lintGcode(gcode);
      expect(result.errors, report(name, result)).toEqual([]);
    });

    it(`${name} sets units and ends the program`, () => {
      const generated = generate();
      const gcode = typeof generated === 'string' ? generated : generated.gcode;
      const result = lintGcode(gcode);
      expect(result.warnings, report(name, result)).toEqual([]);
    });

    it(`${name} needs no comment repair`, () => {
      const generated = generate();
      const gcode = typeof generated === 'string' ? generated : generated.gcode;
      expect(lintGcode(gcode).repairedLines).toBe(0);
    });
  }
});

describe('unbounded names cannot make a program unloadable', () => {
  // Group and part names go into header comments verbatim and have no
  // length limit anywhere - the manufacture table already has to wrap
  // rather than truncate them. A 227-character group name used to produce a
  // 253-character line, one past what LinuxCNC will read, which makes it
  // refuse the whole program rather than just that line.
  const longName = 'p006946-rev-b-slapdih-lower-pivot-plate-left-hand-mirrored-2026-offseason-drivetrain-subassembly-weldment-bracket';
  const body = generateRoutingGcode(outline, { toolDiameter: 0.25, targetDepth: 0.25 }).gcode;

  const grouped = (name, partName) => generateGroupedRoutingGcode({
    name,
    placements: [{ name: partName, offsetX: 1, offsetY: 1, gcode: body }],
    params: { toolDiameter: 0.25, targetDepth: 0.25, stockThickness: 0.25 }
  });

  for (const [label, name, partName] of [
    ['short names', 'sheet-1', 'plate-a'],
    ['a long part name', 'sheet-1', longName],
    ['a long group name', `${longName}-${longName}`, 'plate-a'],
    ['both long', `${longName}-${longName}`, `${longName}-${longName}`]
  ]) {
    it(`loads with ${label}`, () => {
      const gcode = grouped(name, partName);
      const result = lintGcode(gcode);
      expect(result.errors, report(label, result)).toEqual([]);
      const longest = Math.max(...gcode.split('\n').map((line) => line.length));
      expect(longest).toBeLessThanOrEqual(MAX_GCODE_LINE_LENGTH);
    });
  }

  it('keeps the part name readable rather than dropping the comment', () => {
    const gcode = grouped('sheet-1', `${longName}-${longName}`);
    expect(gcode).toMatch(/\(--- PART: p006946-rev-b-slapdih-lower-pivot-plate/);
  });
});

/**
 * Every code below was confirmed present in the LinuxCNC 2.7.15 interpreter
 * source, which is the oldest release checked. The point of the list is not
 * the codes already in it - it is that adding a newer one (G64 path
 * blending, G43 tool length offset, G95/G96 for turning) now has to be a
 * deliberate edit here, with a note about which release introduced it,
 * rather than something that silently raises the minimum version a shop
 * needs to run our output.
 *
 * G54 is handled in 2.7 as "case 540:" inside convert_coordinate_system
 * rather than as a G_54 symbol, which is why grepping for the symbol name
 * alone suggests it is missing.
 */
const SUPPORTED_SINCE_2_7 = new Set([
  'G0', 'G1', 'G2', 'G3', 'G4',
  'G17', 'G20', 'G21', 'G40', 'G49', 'G54', 'G80', 'G90', 'G94',
  'M0', 'M3', 'M5', 'M30'
]);

function executableText(gcode) {
  return gcode.split('\n').map((line) => {
    let out = '';
    let open = false;
    for (const ch of line) {
      if (!open && ch === ';') break;
      if (open) { if (ch === ')' || ch === ']') open = false; continue; }
      if (ch === '(' || ch === '[') { open = true; continue; }
      out += ch;
    }
    return out;
  }).join('\n');
}

function codesUsed(gcode) {
  const found = new Set();
  for (const match of executableText(gcode).matchAll(/\b([GM])\s*0*(\d+(?:\.\d+)?)/gi)) {
    found.add((match[1] + match[2]).toUpperCase());
  }
  return found;
}

describe('generated programs run on older LinuxCNC', () => {
  for (const [name, generate] of cases) {
    it(`${name} uses only codes present in 2.7`, () => {
      const generated = generate();
      const gcode = typeof generated === 'string' ? generated : generated.gcode;
      const unsupported = [...codesUsed(gcode)].filter((code) => !SUPPORTED_SINCE_2_7.has(code));
      expect(unsupported, `${name} uses ${unsupported.join(' ')}, which needs a newer LinuxCNC than 2.7`).toEqual([]);
    });
  }

  it('stays within the line length every checked release enforces', () => {
    // LINELEN is 255 in 2.7.15, 2.8.4 and current, and all three reject a
    // line once strlen(raw_line) reaches LINELEN - 1.
    for (const [name, generate] of cases) {
      const generated = generate();
      const gcode = typeof generated === 'string' ? generated : generated.gcode;
      const longest = Math.max(...gcode.split('\n').map((line) => line.length));
      expect(longest, `${name} has a ${longest} character line`).toBeLessThanOrEqual(MAX_GCODE_LINE_LENGTH);
    }
  });
});

describe('the tube stock program number stays a bare O-word', () => {
  /**
   * Tube stock emits "O1002" as a Fanuc-style program number. That is the
   * one genuinely version-sensitive thing in our output, and it is benign at
   * both ends: LinuxCNC 2.7 maps a bare O-word with no following keyword to
   * O_none and ignores it, while 2.8 onward recognises it as a Fanuc-style
   * program and, per interp_o_word.cc, continues executing without skipping
   * into it as a subroutine body.
   *
   * What must not happen is this turning into real o-word control flow
   * ("o100 sub", "o100 call", "o100 while"). That is skipped entirely by 2.7
   * rather than ignored, so it would change what the machine cuts, not just
   * whether the file loads.
   *
   * A shop whose INI sets DISABLE_FANUC_STYLE_SUB rejects even the bare form
   * on 2.8+, which is a configuration to check rather than a version.
   */
  it('never emits o-word control flow', () => {
    const generated = generateTubestockGcode(tube(), { holeDepth: 0.15 });
    const gcode = typeof generated === 'string' ? generated : generated.gcode;
    for (const line of executableText(gcode).split('\n')) {
      expect(line.trim()).not.toMatch(/^o\s*[0-9<].*\b(sub|endsub|call|while|endwhile|if|else|endif|repeat|return|break|continue)\b/i);
    }
  });

  it('emits the program number alone on its line', () => {
    const generated = generateTubestockGcode(tube(), { holeDepth: 0.15 });
    const gcode = typeof generated === 'string' ? generated : generated.gcode;
    const oLines = executableText(gcode).split('\n').map((l) => l.trim()).filter((l) => /^o/i.test(l));
    expect(oLines.length).toBeGreaterThan(0);
    for (const line of oLines) expect(line).toMatch(/^O\d+$/i);
  });
});
