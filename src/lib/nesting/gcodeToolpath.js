const coordinate = /([XYIJ])\s*(-?\d*\.?\d+)/gi;

function valuesFor(line) {
  const values = {}; let match;
  const code = line.replace(/\([^)]*\)|\[[^\]]*\]/g, '');
  while ((match = coordinate.exec(code))) values[match[1].toUpperCase()] = Number(match[2]);
  coordinate.lastIndex = 0;
  return values;
}

function arcPoints(from, to, center, clockwise) {
  const start = Math.atan2(from.y - center.y, from.x - center.x);
  let sweep = Math.atan2(to.y - center.y, to.x - center.x) - start;
  if (clockwise && sweep >= 0) sweep -= Math.PI * 2;
  if (!clockwise && sweep <= 0) sweep += Math.PI * 2;
  const radius = Math.hypot(from.x - center.x, from.y - center.y);
  const steps = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = start + sweep * index / steps;
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  });
}

export function parseGcodeToolpath(text) {
  const segments = []; let position = { x: 0, y: 0 }, absolute = true, motion = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\([^)]*\)|\[[^\]]*\]/g, '');
    if (/\bG90\b/i.test(line)) absolute = true;
    if (/\bG91(?!\.)\b/i.test(line)) absolute = false;
    const command = line.match(/\bG0?([0-3])\b/i);
    if (command) motion = Number(command[1]);
    const values = valuesFor(line);
    if (!('X' in values || 'Y' in values)) continue;
    const next = absolute
      ? { x: 'X' in values ? values.X : position.x, y: 'Y' in values ? values.Y : position.y }
      : { x: position.x + (values.X || 0), y: position.y + (values.Y || 0) };
    if (motion === 2 || motion === 3) {
      const center = { x: position.x + (values.I || 0), y: position.y + (values.J || 0) };
      if ('I' in values || 'J' in values) segments.push({ rapid: false, points: arcPoints(position, next, center, motion === 2) });
      else segments.push({ rapid: false, points: [position, next] });
    } else segments.push({ rapid: motion === 0, points: [position, next] });
    position = next;
  }
  return segments;
}

export function toolpathBounds(segments) {
  const points = segments.flatMap(segment => segment.points);
  if (!points.length) return { minX: 0, minY: 0, maxX: 0.01, maxY: 0.01, width: 0.01, height: 0.01, centerX: 0, centerY: 0 };
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
  return { minX, minY, maxX, maxY, width: Math.max(.01, maxX - minX), height: Math.max(.01, maxY - minY), centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 };
}
