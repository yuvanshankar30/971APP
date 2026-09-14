import { buildEmitFilename } from './emitFilename.js';
import { holeProgramForThickness } from './holePrograms.js';

const coordinatePattern = /([XYIJ])\s*(-?\d*\.?\d+)/gi;
const terminatePattern = /^\s*(?:%|M2|M30)\b/i;

function transformLine(line, placement, state) {
  if (/\bG90\b/i.test(line)) state.absolute = true;
  if (/\bG91\b/i.test(line)) state.absolute = false;
  const values = {};
  let match;
  while ((match = coordinatePattern.exec(line))) values[match[1].toUpperCase()] = Number(match[2]);
  coordinatePattern.lastIndex = 0;
  if (!Object.keys(values).length) return line;
  const cos = Math.cos(placement.rotation || 0), sin = Math.sin(placement.rotation || 0);
  const rotate = (x, y) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const transformed = { ...values };
  if ('X' in values || 'Y' in values) {
    const localX = 'X' in values ? values.X : state.x, localY = 'Y' in values ? values.Y : state.y;
    const point = rotate(localX, localY);
    if (state.absolute) { transformed.X = point.x + placement.x; transformed.Y = point.y + placement.y; state.x = localX; state.y = localY; }
    else { transformed.X = point.x; transformed.Y = point.y; }
  }
  if ('I' in values || 'J' in values) {
    const vector = rotate(values.I || 0, values.J || 0);
    if ('I' in values) transformed.I = vector.x;
    if ('J' in values) transformed.J = vector.y;
  }
  return line.replace(coordinatePattern, (_all, axis) => `${axis.toUpperCase()}${Number(transformed[axis.toUpperCase()]).toFixed(4)}`);
}

function transformedProgram(source, placement) {
  const state = { x: 0, y: 0, absolute: true };
  return String(source || '').split(/\r?\n/).filter(line => !terminatePattern.test(line)).map(line => transformLine(line, placement, state));
}

function sourceForPlacement(placement, programs, suffix, thickness, dialect) {
  if (placement.kind === 'hole') return suffix === 'holes' ? holeProgramForThickness(thickness, dialect) : null;
  const candidate = programs[placement.part_library_path];
  if (!candidate) return null;
  if (candidate.variants) return candidate.variants.find(variant => variant.suffix === suffix)?.source || null;
  return candidate.suffix && candidate.suffix !== suffix ? null : candidate.source || candidate;
}

export function emitNestingGcode({ name, placements, programs, suffix = '', suffixCount = 1, dialect = 'linuxcnc', thickness = '0.125' }) {
  const lines = [`(${name} - Sheet Nesting)`, dialect === 'wincnc' ? 'G20' : 'G20 G90'];
  let emitted = 0;
  for (const placement of placements) {
    const source = sourceForPlacement(placement, programs, suffix, thickness, dialect);
    if (!source) continue;
    emitted += 1;
    lines.push(`(Part: ${placement.label})`, ...transformedProgram(source, placement));
  }
  lines.push('M30');
  return { filename: buildEmitFilename(name, suffix, suffixCount, dialect === 'wincnc' ? 'tap' : 'ngc'), text: lines.join('\n') + '\n', emitted };
}
