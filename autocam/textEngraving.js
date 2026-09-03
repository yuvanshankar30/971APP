// Single-line 5x7-style glyphs for engraving. The strokes are intentionally
// open paths: a router follows each segment once instead of pocketing the
// letter, making compact labels fast and readable on a machine.
const GLYPHS = {
  A: [[[0, 0], [.5, 1], [1, 0]], [[.2, .45], [.8, .45]]], B: [[[0, 0], [0, 1], [.7, 1], [1, .82], [1, .58], [.7, .5], [0, .5]], [[.7, .5], [1, .36], [1, .12], [.7, 0], [0, 0]]],
  C: [[[1, .88], [.78, 1], [.22, 1], [0, .78], [0, .22], [.22, 0], [.78, 0], [1, .12]]], D: [[[0, 0], [0, 1], [.68, 1], [1, .75], [1, .25], [.68, 0], [0, 0]]],
  E: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0, .5], [.72, .5]]], F: [[[0, 0], [0, 1], [1, 1]], [[0, .5], [.72, .5]]],
  G: [[[1, .82], [.78, 1], [.22, 1], [0, .78], [0, .22], [.22, 0], [.78, 0], [1, .2], [1, .48], [.55, .48]]], H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, .5], [1, .5]]],
  I: [[[0, 1], [1, 1]], [[.5, 1], [.5, 0]], [[0, 0], [1, 0]]], J: [[[0, 1], [1, 1], [1, .2], [.8, 0], [.25, 0], [0, .2]]],
  K: [[[0, 0], [0, 1]], [[1, 1], [0, .48], [1, 0]]], L: [[[0, 1], [0, 0], [1, 0]]], M: [[[0, 0], [0, 1], [.5, .42], [1, 1], [1, 0]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]], O: [[[.2, 0], [0, .2], [0, .8], [.2, 1], [.8, 1], [1, .8], [1, .2], [.8, 0], [.2, 0]]],
  P: [[[0, 0], [0, 1], [.72, 1], [1, .8], [1, .62], [.72, .5], [0, .5]]], Q: [[[.2, 0], [0, .2], [0, .8], [.2, 1], [.8, 1], [1, .8], [1, .2], [.8, 0], [.2, 0]], [[.58, .35], [1, -.08]]],
  R: [[[0, 0], [0, 1], [.72, 1], [1, .8], [1, .62], [.72, .5], [0, .5]], [[.55, .5], [1, 0]]], S: [[[1, .84], [.78, 1], [.22, 1], [0, .8], [0, .58], [1, .42], [1, .2], [.78, 0], [.22, 0], [0, .16]]],
  T: [[[0, 1], [1, 1]], [[.5, 1], [.5, 0]]], U: [[[0, 1], [0, .2], [.2, 0], [.8, 0], [1, .2], [1, 1]]], V: [[[0, 1], [.5, 0], [1, 1]]],
  W: [[[0, 1], [.2, 0], [.5, .55], [.8, 0], [1, 1]]], X: [[[0, 1], [1, 0]], [[1, 1], [0, 0]]], Y: [[[0, 1], [.5, .5], [1, 1]], [[.5, .5], [.5, 0]]], Z: [[[0, 1], [1, 1], [0, 0], [1, 0]]],
  0: [[[.2, 0], [0, .2], [0, .8], [.2, 1], [.8, 1], [1, .8], [1, .2], [.8, 0], [.2, 0]], [[.12, .1], [.88, .9]]], 1: [[[.25, .78], [.5, 1], [.5, 0]], [[.2, 0], [.8, 0]]],
  2: [[[0, .78], [.22, 1], [.78, 1], [1, .78], [1, .58], [0, 0], [1, 0]]], 3: [[[0, .88], [.22, 1], [.78, 1], [1, .78], [1, .55], [.75, .5], [1, .35], [1, .15], [.78, 0], [.22, 0], [0, .12]]],
  4: [[[.85, 0], [.85, 1]], [[.85, .55], [0, .55], [.62, 1]]], 5: [[[1, 1], [0, 1], [0, .52], [.72, .52], [1, .35], [1, .15], [.78, 0], [.22, 0], [0, .12]]],
  6: [[[1, .84], [.78, 1], [.25, 1], [0, .7], [0, .2], [.22, 0], [.78, 0], [1, .2], [1, .42], [.78, .55], [0, .52]]], 7: [[[0, 1], [1, 1], [.35, 0]]],
  8: [[[.22, .5], [0, .68], [0, .84], [.2, 1], [.8, 1], [1, .84], [1, .68], [.78, .5], [.22, .5], [0, .32], [0, .16], [.2, 0], [.8, 0], [1, .16], [1, .32], [.78, .5]]], 9: [[[1, .48], [.22, .48], [0, .62], [0, .82], [.22, 1], [.78, 1], [1, .82], [1, .2], [.78, 0], [.22, 0], [0, .16]]],
  '-': [[[.15, .5], [.85, .5]]], _: [[[0, 0], [1, 0]]], '.': [[[.45, 0], [.55, 0]]], '/': [[[0, 0], [1, 1]]], ':': [[[.5, .72], [.5, .78]], [[.5, .18], [.5, .24]]], ' ': []
};

const GLYPH_WIDTH = 1;
const CHARACTER_GAP = .22;
const LINE_GAP = .45;

function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function fixed(value) {
  return Number(value.toFixed(4)).toString();
}

export function sanitizeTextGcodeFileName(value) {
  const base = String(value || 'text-engraving').trim().replace(/\.n(?:gc|c)$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'text-engraving';
  return `${base}.ngc`;
}

export function buildTextEngraving({ text = '', height = .5, depth = .02, safeZ = .2, feedRate = 35, plungeRate = 12 } = {}) {
  const letterHeight = number(height, .5, .05, 4);
  const cutDepth = number(depth, .02, .001, .25);
  const clearance = number(safeZ, .2, .05, 2);
  const feed = number(feedRate, 35, 1, 250);
  const plunge = number(plungeRate, 12, 1, 100);
  const lines = String(text).toUpperCase().replace(/\r/g, '').split('\n').slice(0, 12).map((line) => line.slice(0, 72));
  const strokes = [];
  const unsupported = new Set();
  let maxWidth = 0;

  lines.forEach((line, row) => {
    let cursor = 0;
    for (const character of line) {
      const glyph = GLYPHS[character];
      if (!glyph) unsupported.add(character);
      for (const stroke of glyph || []) {
        strokes.push(stroke.map(([x, y]) => [
          (cursor + x * GLYPH_WIDTH) * letterHeight,
          (row * (1 + LINE_GAP) + y) * letterHeight
        ]));
      }
      cursor += GLYPH_WIDTH + CHARACTER_GAP;
    }
    maxWidth = Math.max(maxWidth, Math.max(0, cursor - CHARACTER_GAP) * letterHeight);
  });
  const totalHeight = Math.max(letterHeight, lines.length * (1 + LINE_GAP) * letterHeight - LINE_GAP * letterHeight);
  const gcode = [
    '(Spartans Hub text engraving)',
    '(Verify stock zero, workholding, cutter, and safe Z before running.)',
    'G20 G90 G17',
    `G0 Z${fixed(clearance)}`
  ];
  for (const stroke of strokes) {
    if (stroke.length < 2) continue;
    const [[startX, startY], ...rest] = stroke;
    gcode.push(`G0 X${fixed(startX)} Y${fixed(startY)}`);
    gcode.push(`G1 Z-${fixed(cutDepth)} F${fixed(plunge)}`);
    for (const [x, y] of rest) gcode.push(`G1 X${fixed(x)} Y${fixed(y)} F${fixed(feed)}`);
    gcode.push(`G0 Z${fixed(clearance)}`);
  }
  gcode.push('G0 X0 Y0', 'M30');
  return { gcode: `${gcode.join('\n')}\n`, strokes, width: maxWidth, height: totalHeight, unsupported: [...unsupported] };
}
