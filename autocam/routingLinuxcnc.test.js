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
