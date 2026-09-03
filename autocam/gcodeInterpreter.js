/**
 * A real, independent RS274NGC tokenizer - cncjs's gcode-parser, the same
 * library that drives real CNC controllers over serial in production - used
 * to check AutoCAM's own generated programs against actual interpreter
 * behavior instead of only trusting gcodeLint.js's reimplementation of
 * those rules.
 *
 * Why this exists rather than just trusting gcodeLint.js: gcodeLint.js was
 * calibrated against this exact library and against pygcode on a real
 * generated program (see its own file header), but that calibration was
 * done by hand, once, in an ad hoc script, not as a standing check. This
 * makes the real interpreter a committed dependency so that comparison can
 * run every time the test suite does, and catches gcodeLint.js and this
 * library drifting apart as either one changes.
 *
 * Real LinuxCNC's own rs274 interpreter cannot be built on macOS (it links
 * liblinuxcnc/libnml/liblinuxcnchal and pulls in Python via
 * interp_o_word.cc; there is no Homebrew formula and no Docker available on
 * this machine) - see gcode_validation_approach in project memory. This is
 * the practical substitute: a second, independently-implemented tokenizer
 * that already drives real machines, not a from-scratch reinterpretation of
 * the RS274NGC spec.
 */
// gcode-parser is a devDependency (package.json) - this module is test/dev
// tooling only. It must never be imported from production code (anything
// under src/routes or shipped to the built server), since a production
// install won't have it.
import { parseStringSync } from 'gcode-parser';

// Every letter A-Z is a legal RS274NGC word - same reasoning gcodeLint.js
// documents for its own LEGAL_SYMBOLS check. A word letter this library
// reads that isn't one of these means prose leaked out of a malformed
// comment and got tokenized as a live command - the exact failure mode
// that motivated writing gcodeLint.js in the first place.
const VALID_WORD_LETTERS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

/**
 * Tokenizes a program with the real interpreter and reports what it saw.
 *
 * @param {string} gcode
 * @returns {{
 *   blockCount: number,
 *   commandWordCount: number,
 *   invalidWords: string[],
 *   letters: string[]
 * }} invalidWords is empty on a clean program; letters is every distinct
 *   word letter actually used, for spot-checking what a program contains
 *   independent of what its generator claims to emit.
 */
export function interpreterCheck(gcode) {
  const blocks = parseStringSync(String(gcode ?? ''));
  const words = blocks.flatMap((block) => block.words || []);
  const invalidWords = words.filter((word) => !VALID_WORD_LETTERS.has(word[0]));
  const letters = [...new Set(words.map((word) => word[0]))].sort();
  return {
    blockCount: blocks.length,
    commandWordCount: words.length,
    invalidWords: invalidWords.map((word) => word.join('')),
    letters
  };
}
