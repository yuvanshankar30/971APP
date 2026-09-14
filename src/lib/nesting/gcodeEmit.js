import { buildEmitFilename } from './emitFilename.js';

function translateLine(line, x, y) {
  return line.replace(/([XY])\s*(-?\d*\.?\d+)/gi, (_all, axis, value) => `${axis.toUpperCase()}${(Number(value) + (axis.toUpperCase() === 'X' ? x : y)).toFixed(4)}`);
}
export function emitNestingGcode({ name, placements, programs, suffix = '', suffixCount = 1, dialect = 'linuxcnc' }) {
  const lines = [`(${name} - Sheet Nesting)`, dialect === 'wincnc' ? 'G20' : 'G20 G90'];
  for (const placement of placements) {
    const program = programs[placement.part_library_path];
    if (!program) continue;
    lines.push(`(Part: ${placement.label})`);
    lines.push(...String(program.source || program).split(/\r?\n/).filter(line => !/^\s*(M2|M30)\b/i.test(line)).map(line => translateLine(line, placement.x, placement.y)));
  }
  lines.push('M30');
  return { filename: buildEmitFilename(name, suffix, suffixCount, dialect === 'wincnc' ? 'tap' : 'ngc'), text: lines.join('\n') + '\n' };
}
