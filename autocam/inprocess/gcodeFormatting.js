/** Shared formatting for generated G-code across every in-process workflow. */
export function formatGcodeNumber(value, decimals = 4) {
  return Number(value).toFixed(decimals);
}

/** Controller-aware operator pause used for manual tool/setup changes. */
export function gcodePauseLine(isWinCNC, promptText) {
  return isWinCNC ? `G4 (${promptText})` : `M00 (${promptText})`;
}

/** Controller-aware dwell; WinCNC uses X seconds while LinuxCNC uses P. */
export function gcodeDwellLine(isWinCNC, seconds, comment) {
  const word = isWinCNC ? 'X' : 'P';
  return `G04 ${word}${formatGcodeNumber(seconds, 1)} (${comment})`;
}
