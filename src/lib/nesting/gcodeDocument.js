import { parseGcodeToolpath, toolpathBounds } from './gcodeToolpath.js';

export function detectDialect(gcode) {
  return /\b(?:M32|G22|WinCNC)\b/i.test(gcode) ? 'wincnc' : 'linuxcnc';
}

export function gcodeSuffix(name = '') {
  const stem = String(name).replace(/\.[^.]+$/, '');
  const index = stem.lastIndexOf('_');
  return index === -1 ? '' : stem.slice(index + 1).toLowerCase();
}

export function gcodeBounds(text) {
  return toolpathBounds(parseGcodeToolpath(text));
}

export function parseGcodeDocument(text, name = 'program.ngc') {
  const tools = new Map(); let activeTool = null; const layers = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const toolMatch = raw.match(/\bT(\d+)\b/i);
    if (toolMatch) activeTool = Number(toolMatch[1]);
    const diameter = raw.match(/(?:D\s*=|DIAMETER\s*[:=])\s*([0-9.]+)/i);
    if (activeTool !== null && diameter) tools.set(activeTool, Number(diameter[1]));
    const key = activeTool ?? 0;
    if (!layers.has(key)) layers.set(key, []);
    layers.get(key).push(raw);
  }
  const source = String(text || ''), toolpath = parseGcodeToolpath(source);
  return { name, suffix: gcodeSuffix(name), source, dialect: detectDialect(text), bounds: toolpathBounds(toolpath), toolpath, tools: [...tools].map(([number, diameter]) => ({ number, diameter })), layers: [...layers].map(([tool, lines]) => ({ tool, text: lines.join('\n') })) };
}
