/**
 * Checks and repairs hand-written or pasted G-code for the things that stop
 * LinuxCNC loading a file at all, so an operator finds out here rather than
 * at the machine.
 *
 * The checks are deliberately limited to conditions that are unambiguously
 * wrong in RS274NGC. Anything that merely looks unusual is left alone -
 * this is not a style checker, and a false alarm on a legal program is
 * worse than no check, because it teaches people to ignore the panel.
 *
 * The errors map to real LinuxCNC interpreter messages: "nested comment
 * found", "unclosed comment found", "bad character used", and "bad number
 * format". The nested-comment one is what this app itself emitted for
 * months - see gcodeComments.js.
 *
 * This does NOT reuse normalizeGcodeComments. That function treats "[" as a
 * comment opener, which is right for the WinCNC programs this app
 * generates but wrong for arbitrary input: in LinuxCNC "[" opens an
 * arithmetic expression, so it would rewrite "G1 X[#1+2] Y3" as
 * "G1 X[#1+2 Y3]" and silently delete the rest of the line. Here a comment
 * is only ever "(" or ";", which is what the .ngc these produce will be
 * read as.
 */

// Every letter A-Z is a legal word in RS274NGC, so there is no "unknown
// letter" check worth making. These are the non-letter, non-digit
// characters that may legally appear outside a comment: expression
// brackets and operators, parameter "#", o-word name angle brackets,
// decimal points and signs, and the "%" program delimiter.
const LEGAL_SYMBOLS = new Set(['.', '+', '-', '#', '[', ']', '<', '>', '=', '*', '/', '%', '@', '^']);

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isLetter(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/** Strip comments from one line, recording any that are malformed. */
function scanComments(line, lineNumber, errors) {
  let code = '';
  let open = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (open) {
      if (ch === '(') {
        errors.push({ line: lineNumber, message: 'Nested comment: a "(" inside a comment. The comment ends at the first ")", so the rest of the line runs as code.' });
      } else if (ch === ')') {
        open = false;
      }
      continue;
    }
    if (ch === '(') {
      open = true;
    } else if (ch === ';') {
      break;
    } else if (ch === ')') {
      errors.push({ line: lineNumber, message: 'A ")" with no comment open.' });
    } else {
      code += ch;
    }
  }
  if (open) {
    errors.push({ line: lineNumber, message: 'Unclosed comment: "(" with no matching ")" before the end of the line.' });
  }
  return code;
}

/** Flag characters that cannot appear in executable G-code. Catches the
 * common real case of text pasted out of a document, where quotes and
 * hyphens have been replaced by their typographic lookalikes. */
function checkCharacters(code, lineNumber, errors) {
  const seen = new Set();
  for (const ch of code) {
    if (ch === ' ' || ch === '\t' || ch === '\r') continue;
    if (isLetter(ch) || isDigit(ch) || LEGAL_SYMBOLS.has(ch)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    const point = ch.codePointAt(0);
    const label = point > 126 ? `"${ch}" (U+${point.toString(16).toUpperCase().padStart(4, '0')})` : `"${ch}"`;
    errors.push({ line: lineNumber, message: `Bad character ${label} outside a comment.` });
  }
}

/** A word letter must be followed by a number, a parameter, or an
 * expression. "X" on its own is "bad number format" at load time. */
function checkWordValues(code, lineNumber, errors) {
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '[') { depth += 1; continue; }
    if (ch === ']') { depth = Math.max(0, depth - 1); continue; }
    // Inside an expression, letters are operators (AND, MOD, SIN) rather
    // than words, so the rule below does not apply to them.
    if (depth > 0 || !isLetter(ch)) continue;

    let j = i + 1;
    while (j < code.length && (code[j] === ' ' || code[j] === '\t')) j += 1;
    const next = code[j];

    // An o-word may be named rather than numbered: o<peck> call.
    if (!((ch === 'o' || ch === 'O') && next === '<')) {
      if (next === undefined || !(isDigit(next) || next === '.' || next === '-' || next === '+' || next === '#' || next === '[')) {
        errors.push({ line: lineNumber, message: `"${ch.toUpperCase()}" has no value after it.` });
      }
    }
    // Skip over the value so its digits are not re-read as word letters.
    // Bracket depth has to keep being counted while skipping, or the "["
    // that opens an expression is stepped over and the operators inside it
    // ("2 MOD 3") are then read as valueless words.
    while (j < code.length && !isLetter(code[j])) {
      if (code[j] === '[') depth += 1;
      else if (code[j] === ']') depth = Math.max(0, depth - 1);
      j += 1;
    }
    i = j - 1;
  }
}

/**
 * Rewrites every comment so it cannot close early, and closes any comment
 * left open. Code outside comments is copied through untouched.
 *
 * @param {string} text
 * @returns {string}
 */
export function repairGcodeComments(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      let out = '';
      let open = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (open) {
          // A "(" here is what makes the comment nest; dropping it leaves
          // the operator's words readable and the comment well-formed.
          if (ch === '(') continue;
          if (ch === ')') open = false;
          out += ch;
          continue;
        }
        if (ch === ';') return out + line.slice(i);
        if (ch === ')') continue;
        if (ch === '(') open = true;
        out += ch;
      }
      return open ? `${out})` : out;
    })
    .join('\n');
}

/**
 * @param {string} text the program to check
 * @returns {{lines: number, commandLines: number, errors: Array<{line: number, message: string}>, warnings: Array<{line: number, message: string}>, repairedLines: number}}
 */
export function lintGcode(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const errors = [];
  const warnings = [];
  let commandLines = 0;
  let sawUnits = false;
  let sawProgramEnd = false;
  let sawOWord = false;
  const codeByLine = [];

  lines.forEach((line, index) => {
    const code = scanComments(line, index + 1, errors);
    codeByLine.push(code);
    const trimmed = code.trim();
    if (!trimmed || trimmed === '%') return;
    commandLines += 1;
    checkCharacters(code, index + 1, errors);
    if (/(^|[^a-z])o\s*[<0-9]/i.test(trimmed)) sawOWord = true;
    if (/g\s*0*2[01](\D|$)/i.test(trimmed)) sawUnits = true;
    if (/m\s*0*(2|30)(\D|$)/i.test(trimmed)) sawProgramEnd = true;
  });

  // An o-word program's control flow puts bare keywords (sub, endsub,
  // while, if) on the line, which the word-value rule would misread as
  // valueless words, so it is skipped for those programs.
  if (!sawOWord) {
    codeByLine.forEach((code, index) => {
      const trimmed = code.trim();
      if (!trimmed || trimmed === '%') return;
      checkWordValues(code, index + 1, errors);
    });
  }

  if (commandLines > 0 && !sawUnits) {
    warnings.push({ line: 0, message: 'No G20 or G21, so the program runs in whichever units the machine was left in. Inches and millimetres differ by 25x.' });
  }
  if (commandLines > 0 && !sawProgramEnd) {
    warnings.push({ line: 0, message: 'No M2 or M30, so the program never ends and the interpreter runs past the last line.' });
  }

  const repaired = repairGcodeComments(source).split('\n');
  let repairedLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== repaired[i]) repairedLines += 1;
  }

  // The word-value pass runs after the comment pass, so without this the
  // findings jump around the file (line 5's comment error above line 3's
  // missing value) and read as unrelated to each other.
  errors.sort((a, b) => a.line - b.line);

  return { lines: lines.length, commandLines, errors, warnings, repairedLines };
}
