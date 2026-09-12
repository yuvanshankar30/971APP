// OnShape's own default names for a body/feature nobody bothered to rename -
// "SOLID"/"COMPOUND" for an unnamed body, or the literal feature-operation
// name ("Chamfer1", "Boss-Extrude1", "Fillet1", ...) for a body that
// inherited its feature's name. None of these are real part names, and both
// the live OnShape BOM import (onshape.js) and the manual CSV import
// (bom_csv_import.js) need to drop them the same way.
//
// Anchored to the WHOLE string (with only an optional trailing number) so a
// real part that happens to contain one of these words - "Chamfer Bracket",
// "Fillet Guide" - is never touched; only the exact bare placeholder is.
const PLACEHOLDER_PREFIXES = [
  'SOLID',
  'COMPOUND',
  'EXTRUDE',
  'BOSS-EXTRUDE',
  'CHAMFER',
  'FILLET',
  'LOFT',
  'REVOLVE',
  'SWEEP',
  'SHELL',
  'MIRROR',
  'PATTERN',
  'DRAFT',
  'RIB',
  'HOLE',
  'SPLIT',
  'THICKEN',
  'SCALE'
];

const PLACEHOLDER_NAME_RE = new RegExp(`^(${PLACEHOLDER_PREFIXES.join('|')})(_?\\d+)?$`, 'i');

export function isOnshapePlaceholderName(name) {
  return PLACEHOLDER_NAME_RE.test(String(name ?? '').trim());
}
