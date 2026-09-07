// Measures how far a posted program actually travels on each axis.
//
// Issue #359: "program exceeds machine maximum on X" was reported repeatedly
// against the real UNC Router. Every single time, the program's own span
// turned out to be modest (well under 15in on any axis) and the real cause
// was the machine's G54 work offset sitting tens of inches from home, so the
// absolute machine coordinate blew past the travel limit even though the
// program itself was fine.
//
// Proving that took someone parsing the .ngc by hand each time, which is the
// first step of the troubleshooting doc that incident produced
// (autocam/fusion/runner/docs/machine-exceeds-maximum-troubleshooting.md).
// Computing it once, on completion, means the operator can rule the program
// in or out immediately and go look at G54 instead.
//
// Deliberately measures only what the program itself commands. It cannot know
// the machine's work offset - that lives on the control, not in the file -
// so this answers "is the program too big?", never "will it fit right now".

const AXES = ['X', 'Y', 'Z'];

// A word is a letter followed by a number: X-1.5, Y+2, Z.125, X 3 (some posts
// space them). Arc centre offsets (I/J/K) and every other word are ignored -
// only real axis coordinates contribute to a span.
const WORD_RE = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

/** Strip G-code comments so text inside them can't be read as coordinates. */
function stripComments(line) {
  // LinuxCNC/RS-274: "(...)" anywhere, and ";" to end of line.
  return line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, ' ');
}

/**
 * Per-axis travel of a posted program.
 *
 * @param {string} text raw .ngc/.nc program text
 * @returns {{units: 'in'|'mm'|'unknown', axes: Record<string, {min: number, max: number, span: number}>}}
 *   Axes with no commanded coordinate are omitted rather than reported as 0,
 *   so a 2D program doesn't claim a Z span it never had.
 */
export function measureProgramExtents(text) {
  if (typeof text !== 'string' || !text) return { units: 'unknown', axes: {} };

  let units = 'unknown';
  const bounds = new Map();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComments(rawLine);
    if (!line.trim()) continue;

    WORD_RE.lastIndex = 0;
    let match;
    while ((match = WORD_RE.exec(line)) !== null) {
      const letter = match[1].toUpperCase();
      const value = Number(match[2]);
      if (!Number.isFinite(value)) continue;

      // G20/G21 set inch/mm for everything that follows. Recorded rather
      // than converted: reporting the program's own declared units is what
      // makes a span comparable to the machine's own travel spec.
      if (letter === 'G') {
        if (value === 20) units = 'in';
        else if (value === 21) units = 'mm';
        continue;
      }
      if (!AXES.includes(letter)) continue;

      const current = bounds.get(letter);
      if (!current) bounds.set(letter, { min: value, max: value });
      else {
        if (value < current.min) current.min = value;
        if (value > current.max) current.max = value;
      }
    }
  }

  const axes = {};
  for (const axis of AXES) {
    const found = bounds.get(axis);
    if (!found) continue;
    axes[axis] = {
      min: round(found.min),
      max: round(found.max),
      span: round(found.max - found.min)
    };
  }
  return { units, axes };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Extents for every posted file in a completed job, plus the combined span.
 *
 * @param {Array<{name: string, contentBase64: string}>} ncFiles validated artifacts
 */
export function measureNcFileExtents(ncFiles) {
  if (!Array.isArray(ncFiles) || !ncFiles.length) return null;
  const perFile = [];
  const overall = new Map();
  let units = 'unknown';

  for (const file of ncFiles) {
    let text = '';
    try {
      text = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    } catch {
      continue; // already validated upstream; a decode failure here is not worth failing a job over
    }
    const measured = measureProgramExtents(text);
    if (measured.units !== 'unknown') units = measured.units;
    if (!Object.keys(measured.axes).length) continue;
    perFile.push({ name: file.name, axes: measured.axes });
    for (const [axis, value] of Object.entries(measured.axes)) {
      const current = overall.get(axis);
      if (!current) overall.set(axis, { min: value.min, max: value.max });
      else {
        if (value.min < current.min) current.min = value.min;
        if (value.max > current.max) current.max = value.max;
      }
    }
  }

  if (!perFile.length) return null;
  const combined = {};
  for (const [axis, value] of overall) {
    combined[axis] = { min: round(value.min), max: round(value.max), span: round(value.max - value.min) };
  }
  return { units, combined, files: perFile };
}
