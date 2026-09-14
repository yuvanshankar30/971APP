export function detectDialect(gcode) {
  return /\b(?:M32|G22|WinCNC)\b/i.test(gcode) ? 'wincnc' : 'linuxcnc';
}

export function gcodeSuffix(name = '') {
  const stem = String(name).replace(/\.[^.]+$/, '');
  const index = stem.lastIndexOf('_');
  return index === -1 ? '' : stem.slice(index + 1).toLowerCase();
}

export function gcodeBounds(text) {
  let x = 0, y = 0, minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const xMatch = line.match(/\bX\s*(-?\d*\.?\d+)/i), yMatch = line.match(/\bY\s*(-?\d*\.?\d+)/i);
    if (xMatch) x = Number(xMatch[1]);
    if (yMatch) y = Number(yMatch[1]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: Math.max(0.01, maxX - minX), height: Math.max(0.01, maxY - minY) };
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
  return { name, suffix: gcodeSuffix(name), source: String(text || ''), dialect: detectDialect(text), bounds: gcodeBounds(text), tools: [...tools].map(([number, diameter]) => ({ number, diameter })), layers: [...layers].map(([tool, lines]) => ({ tool, text: lines.join('\n') })) };
}
