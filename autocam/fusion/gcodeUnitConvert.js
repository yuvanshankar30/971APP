/**
 * Converts a metric Fusion-cammed G-code program to inches.
 *
 * Real problem this solves: every real Fusion AutoCAM job posted through
 * the New Router (shopsabre.cps/WinCNC) so far came out in millimeters
 * (G22) - confirmed by querying every completed `cam_jobs` row with a
 * `.tap` output directly against the live Supabase project. JProg (jprog/,
 * the shop's sheet-nesting/G-code tool)'s WinCNC parser has no G22 case at
 * all and aborts the whole file, so none of that real output can currently
 * be opened in JProg. This does NOT touch either .cps post-processor
 * (autocam/postprocessors/*.cps) - those only run inside Fusion 360 itself
 * and can't be exercised or verified from this repo; this module is a
 * plain, independently testable G-code text transform applied to already-
 * posted output instead.
 *
 * Handles both dialects this app's Fusion pipeline posts through (see
 * autocam/postprocessors/README.md for the confirmed real conventions):
 *   - LinuxCNC/EMC ("(...)" comments): G21 = millimeters.
 *   - WinCNC/ShopSabre ("[...]" comments): G21 = centimeters, G22 =
 *     millimeters - WinCNC never uses G21 for millimeters, confirmed
 *     against the real shopsabre.cps and a real Fusion-cammed output file.
 *
 * An already-inch (G20) program is returned byte-for-byte unchanged.
 */

const MM_PER_INCH = 25.4;
const CM_PER_INCH = 2.54;

/** Comment delimiter this dialect uses, matching jprog's own CommentsParser971/CommentsParserWinCNC. */
function detectDialect(gcode) {
  return /^\s*\[/.test(gcode) ? 'wincnc' : 'linuxcnc';
}

/**
 * Strips [..]/(..) comments (nested, matching jprog's own bracket-matching
 * comment parsers) from a line, returning { code, comments } - the
 * remaining G-code words and the stripped comment text, separately, so
 * comment-embedded dimensions (tool diameter, ZMIN) can still be converted
 * on their own below.
 */
function splitLineCommentsAndCode(line, open, close) {
  let code = '';
  let comments = '';
  let depth = 0;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close && depth > 0) {
      depth--;
      if (depth === 0) {
        comments += line.slice(start, i + 1) + ' ';
        start = -1;
      }
    } else if (depth === 0) {
      code += ch;
    }
  }
  // Unbalanced trailing opener (shouldn't happen in valid G-code) - treat
  // the rest of the line as comment, same as jprog's own orphan handling.
  if (depth > 0 && start !== -1) comments += line.slice(start) + ' ';
  return { code, comments };
}

// Named dimensional fields inside a tool-definition comment
// ("[T1 D=4.001 CR=0. - ZMIN=-3.683 - flat end mill]") - all three are
// lengths in the program's own unit, same as jprog's own tool-def regex
// (T(\d+).*?D=([\d.]+)) already assumes for D.
const COMMENT_DIMENSION_FIELDS = /(D|CR|ZMIN)=(-?[0-9]+(?:\.[0-9]*)?)/gi;

// G-code words that carry a length or feed-rate value in the program's
// current unit (X/Y/Z/I/J/K position/offset, F feed rate). Never S (RPM),
// T/H/D-as-a-word (tool/offset numbers), M, or a bare G number.
const LENGTH_WORD = /\b([XYZIJKF])(-?[0-9]+(?:\.[0-9]*)?)/g;

/**
 * @param {string} gcode raw program text
 * @returns {{ gcode: string, converted: boolean, dialect: 'linuxcnc'|'wincnc', factor: number|null }}
 */
export function convertGcodeToInches(gcode) {
  if (typeof gcode !== 'string' || gcode.length === 0) {
    return { gcode, converted: false, dialect: null, factor: null };
  }

  const dialect = detectDialect(gcode);
  const [open, close] = dialect === 'wincnc' ? ['[', ']'] : ['(', ')'];

  const hasG20 = /\bG20\b/.test(gcode.replace(new RegExp(`\\${open}[^${close}]*\\${close}`, 'g'), ''));
  if (hasG20) {
    // Already inches - jprog and every other consumer already understand
    // this file exactly as posted. Leave it completely untouched.
    return { gcode, converted: false, dialect, factor: null };
  }

  const hasG22 = /\bG22\b/.test(gcode);
  const hasG21 = /\bG21\b/.test(gcode);
  if (!hasG22 && !hasG21) {
    // No recognized unit selector at all - nothing this function knows how
    // to safely convert. Leave it untouched rather than guess.
    return { gcode, converted: false, dialect, factor: null };
  }

  // WinCNC: G21 = cm, G22 = mm (never both; G22 wins if somehow both appear,
  // since that's the far more common real case for this dialect).
  // LinuxCNC/EMC: G21 = mm (the only metric selector it uses).
  const factor = dialect === 'wincnc'
    ? (hasG22 ? MM_PER_INCH : CM_PER_INCH)
    : MM_PER_INCH;
  const unitGWord = hasG22 ? 'G22' : 'G21';

  const outLines = gcode.split(/\r\n|\r|\n/).map((line) => {
    const { code, comments } = splitLineCommentsAndCode(line, open, close);

    // Tool-definition comments carry their own dimensional fields
    // (diameter, corner radius, min Z) in the program's unit - convert
    // those too so a human (or JProg, which reads D= for its tool
    // registry) doesn't read a millimeter value as if it were inches.
    const convertedComments = comments.replace(COMMENT_DIMENSION_FIELDS, (_m, field, value) =>
      `${field}=${(Number(value) / factor).toFixed(4)}`);

    // WinCNC's G4 dwell uses X for the duration in SECONDS, not a length -
    // jprog's own GCodeParserWinCNC explicitly discards X on a G4 line for
    // exactly this reason (case 4 -> attributes.remove("X")). LinuxCNC's
    // dwell uses P instead, which LENGTH_WORD never matches, so it needs no
    // equivalent exception.
    const isDwellLine = /\bG0?4\b/.test(code);
    const convertedCode = code.replace(LENGTH_WORD, (match, letter, value) => {
      if (isDwellLine && letter === 'X') return match;
      return letter + (Number(value) / factor).toFixed(4);
    });

    // Reassemble: unit selector line itself becomes G20 in place (keeps
    // line position/ordering identical to the original for easy diffing).
    const withUnit = convertedCode.replace(new RegExp(`\\b${unitGWord}\\b`), 'G20');

    if (!withUnit && !convertedComments) return '';
    if (!convertedComments) return withUnit;
    if (!withUnit.trim()) return convertedComments.trim();
    return `${withUnit}${withUnit.endsWith(' ') ? '' : ' '}${convertedComments}`.trimEnd();
  });

  return { gcode: outLines.join('\n'), converted: true, dialect, factor };
}
