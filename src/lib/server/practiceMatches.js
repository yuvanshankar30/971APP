// A practice match needs no form - "Add practice match" just claims the
// next number for the event, so the label/key derivation is the one thing
// here worth testing on its own (numbering, event scoping, bad input).
export function buildPracticeMatch(eventKey, existingCount) {
  const trimmedKey = String(eventKey || '').trim();
  const count = Number.isFinite(existingCount) && existingCount > 0 ? Math.floor(existingCount) : 0;
  const number = count + 1;
  return { match_key: `${trimmedKey}_practice_${number}`, label: `Practice ${number}`, number };
}
