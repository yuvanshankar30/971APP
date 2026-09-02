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
 * @param {string} gcode the assembled program
 * @param {object} [options]
 * @param {'linuxcnc'|'wincnc'} [options.dialect='linuxcnc']
 * @returns {string} the same program with every comment balanced and in the
 *   dialect's own delimiters
 */
export function normalizeGcodeComments(gcode, { dialect = 'linuxcnc' } = {}) {
  const [open, close] = DIALECT_DELIMITERS[dialect] || DIALECT_DELIMITERS.linuxcnc;

  return String(gcode ?? '')
    .split('\n')
    .map((line) => {
      const start = line.indexOf('(');
      if (start === -1) return line;

      const code = line.slice(0, start);
      let text = line.slice(start + 1);
      if (text.endsWith(')')) text = text.slice(0, -1);

      // Nothing inside a comment may look like a delimiter in either
      // dialect - that is exactly what let the comment close early.
      const safe = text.replace(/[()[\]]/g, '').trimEnd();
      return `${code}${open}${safe}${close}`;
    })
    .join('\n');
}
