export function detectDialect(gcode) {
  return /\b(?:M32|G22|WinCNC)\b/i.test(gcode) ? 'wincnc' : 'linuxcnc';
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
  return { name, source: String(text || ''), dialect: detectDialect(text), tools: [...tools].map(([number, diameter]) => ({ number, diameter })), layers: [...layers].map(([tool, lines]) => ({ tool, text: lines.join('\n') })) };
}
