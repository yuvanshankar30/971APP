import { normalizeGcodeComments } from '../gcodeComments.js';

function format(value) { return Number(value).toFixed(4).replace(/\.?0+$/, ''); }

const COMMENT_SPAN = /(\([^)]*\)|\[[^\]]*\])/g;

function codeOutsideComments(line) {
  return line.replace(COMMENT_SPAN, '').replace(/[([].*$/, '');
}

/** Translate absolute XY words. I/J arc centers remain untouched because
 * they are relative offsets, so circular moves stay geometrically correct. */
export function translateRoutingGcode(gcode, offsetX, offsetY) {
  return String(gcode || '').split(/\r?\n/).map((line) => {
    // WinCNC spells a dwell as G04 X<seconds>. That X is time, not an axis.
    if (/\bG0?4\b/i.test(codeOutsideComments(line))) return line;
    return line.split(COMMENT_SPAN).map((span) => {
      if (span.startsWith('(') || span.startsWith('[')) return span;
      return span
        .replace(/\bX\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/gi, (_, value) => `X${format(Number(value) + offsetX)}`)
        .replace(/\bY\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/gi, (_, value) => `Y${format(Number(value) + offsetY)}`);
    }).join('');
  }).join('\n');
}

export function programBody(gcode) {
  return String(gcode || '').split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '%' && !/^M30\b/i.test(trimmed) && !/^M02\b/i.test(trimmed) && !/^M05\b/i.test(trimmed)
      && !/^G(?:20|21|90|17|94|54)\b/i.test(trimmed) && !/^S\d+(?:\.\d+)?\s*M0?3\b/i.test(trimmed);
  });
}

/** Build a single-router-program artifact from completed, compatible jobs. */
export function generateGroupedRoutingGcode({ name, placements, params = {} }) {
  if (!placements?.length) throw new Error('Select at least one completed router job');
  const safeZ = Number(params.safeZ) || 0.25;
  const spindleSpeed = Number(params.spindleSpeed) || 14000;
  const edgeMargin = Number(params.edgeMargin ?? 0.5);
  const toolDiameter = Number(params.toolDiameter);
  if (!(edgeMargin >= 0)) throw new Error('Edge margin must be zero or greater');
  if (!(toolDiameter > 0)) throw new Error('A positive end-mill diameter is required for grouped G-code');
  const centerlineMargin = edgeMargin + toolDiameter / 2;
  const controller = params.controller === 'wincnc' ? 'wincnc' : 'linuxcnc';
  // Stated so the operator can check the sheet on the table against what
  // every part in this program was cut for. The group only forms when all
  // its jobs agree on this (see the depth check in /api/cam-groups), so one
  // number is the truth for the whole sheet.
  const stockThickness = Number(params.stockThickness ?? params.targetDepth);
  const lines = [
    `(GROUPED ROUTER PROGRAM: ${name || 'unnamed group'})`,
    `(VERIFY STOCK, WORK ZERO, CLAMPS, AND THE NESTING PREVIEW BEFORE RUNNING)`,
    // What the sheet is, then how the parts sit on it - both are things the
    // operator checks against the material in front of them before starting.
    ...(stockThickness > 0 ? [`(EVERY PART HERE IS CUT TO ${format(stockThickness)}" - CONFIRM THE SHEET MATCHES)`] : []),
    `(SHEET EDGE CLEARANCE: ${format(edgeMargin)} in from cut edge; toolpath centerline margin ${format(centerlineMargin)} in for ${format(toolDiameter)} in cutter)`,
    controller === 'wincnc' ? 'G20 (inch)' : 'G20 (inch)',
    'G90 (absolute)',
    ...(controller === 'wincnc' ? [] : ['G17 (XY plane)', 'G94 (feed per minute)', 'G54 (work offset - verify before running)', 'G80 G40 G49 (defensive reset)']),
    `S${spindleSpeed} M03 (spindle on)`,
    `G00 Z${format(safeZ)} (safe height)`
  ];
  for (const placement of placements) {
    lines.push(`(--- PART: ${placement.name} | offset X${format(placement.offsetX)} Y${format(placement.offsetY)} ---)`);
    lines.push(`G00 Z${format(safeZ)} (retract between parts)`);
    lines.push(...programBody(translateRoutingGcode(placement.gcode, placement.offsetX, placement.offsetY)));
  }
  lines.push(`G00 Z${format(safeZ)} (safe height)`);
  lines.push('M05 (spindle off)');
  lines.push(controller === 'wincnc' ? '(PROGRAM END)' : 'M30 (program end)');
  return normalizeGcodeComments(lines.join('\n'), { dialect: controller });
}
