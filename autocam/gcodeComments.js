/**
 * Makes every comment in a generated program well-formed, and renders it in
 * the controller's own comment syntax.
 *
 * G-code comments cannot nest. A comment ends at the FIRST closing delimiter,
 * so any parenthesis inside the comment's own text closes it early and leaves
 * the remainder of the line as live code. These generators write plenty of
 * prose comments that naturally contain parentheses, and several were doing
 * exactly that:
 *
 *   (  SIMULATOR. Run this through a G-code simulator (e.g. ncviewer.com,)
 *   (  CAMotics) and do a supervised air-cut before running on material. )
 *
 * The second line's comment ends at "CAMotics)", leaving
 * "and do a supervised air-cut before running on material. )" as executable
 * text - in the header banner that every single program this app emits
 * starts with.
 *
 * The WinCNC path was worse. It converted dialects with a blanket
 * "(" -> "[", ")" -> "]" character swap, which turned those inner
 * parentheses into inner brackets and produced:
 *
 *   [G92] BEFORE running this file - WinCNC has no G54-style stored work offset]
 *
 * - a bare G54 left on the line, on a controller that this very comment
 * says has no G54 support.
 *
 * Fixing it at each call site would mean auditing every lines.push() in
 * three generators and hoping nobody writes another parenthesis. Instead
 * this normalizes the assembled program in one place: a comment runs from
 * the first "(" to the end of its line (the only shape these generators
 * emit), its text is stripped of delimiters so it cannot self-terminate,
 * and it is re-wrapped in the target dialect's own.
 */

const DIALECT_DELIMITERS = {
  linuxcnc: ['(', ')'],
  wincnc: ['[', ']']
};

/**
 * The longest line LinuxCNC will read, in characters, not counting the
 * newline.
 *
 * src/emc/linuxcnc.h sets LINELEN to 255, and the interpreter reads with
 * fgets(line, LINELEN, fp) then fails with NCE_COMMAND_TOO_LONG when
 * strlen(raw_line) == LINELEN - 1 (rs274ngc_pre.cc, interp_read.cc). The
 * stored string includes the newline, so a line of 253 characters already
 * measures 254 and is rejected. 252 is the last length that loads.
 *
 * This matters because comments are what make lines long: a group or part
 * name goes into a header comment verbatim, and those names are unbounded.
 * A 227-character group name produced a 253-character line - one over -
 * which makes LinuxCNC refuse the whole program, not just that line.
 */
export const MAX_GCODE_LINE_LENGTH = 252;

/**
 * @param {string} gcode the assembled program
 * @param {object} [options]
 * @param {'linuxcnc'|'wincnc'} [options.dialect='linuxcnc']
 * @returns {string} the same program with every comment balanced and in the
 *   dialect's own delimiters
 */
export function normalizeGcodeComments(gcode, { dialect = 'linuxcnc' } = {}) {
  // 'preserve' re-wraps each comment in whichever delimiter already opened
  // it, instead of converting the program to one dialect. That is what lets
  // this clean an ALREADY-GENERATED file - a stored WinCNC program is full
  // of "[...]" and must stay that way; only its nesting needs fixing.
  const preserve = dialect === 'preserve';
  const [openFor, closeFor] = preserve ? [null, null] : (DIALECT_DELIMITERS[dialect] || DIALECT_DELIMITERS.linuxcnc);

  return String(gcode ?? '')
    .split('\n')
    .map((line) => {
      // Either delimiter can open a comment, so both are searched. Looking
      // only for "(" meant a WinCNC program - which uses "[" throughout -
      // passed through completely untouched.
      const paren = line.indexOf('(');
      const bracket = line.indexOf('[');
      const start = paren === -1 ? bracket : (bracket === -1 ? paren : Math.min(paren, bracket));
      if (start === -1) return line;

      const opener = line[start];
      const [open, close] = preserve
        ? (opener === '[' ? DIALECT_DELIMITERS.wincnc : DIALECT_DELIMITERS.linuxcnc)
        : [openFor, closeFor];

      const code = line.slice(0, start);
      let text = line.slice(start + 1);
      if (text.endsWith(')') || text.endsWith(']')) text = text.slice(0, -1);

      // Nothing inside a comment may look like a delimiter in either
      // dialect - that is exactly what let the comment close early.
      const safe = text.replace(/[()[\]]/g, '').trimEnd();

      // A comment long enough to push the line past the interpreter's limit
      // is shortened rather than left to make the whole program unloadable.
      // Only the comment gives way; the code before it is never touched.
      const room = MAX_GCODE_LINE_LENGTH - code.length - open.length - close.length;
      if (safe.length > room) {
        return room > 0 ? `${code}${open}${safe.slice(0, room).trimEnd()}${close}` : code.trimEnd();
      }
      return `${code}${open}${safe}${close}`;
    })
    .join('\n');
}
