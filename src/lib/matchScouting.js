export const MATCH_RATING_FIELDS = Object.freeze([
  'Shot accuracy',
  'Driver awareness',
  'Cycle speed',
  'Defense',
  'Reliability'
]);

export const TELEOP_ROLES = Object.freeze([
  'Scoring',
  'Shuttling',
  'Fuel collection',
  'Defense'
]);

const MAX_AUTO_POINTS = 1000;

function finitePoints(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= MAX_AUTO_POINTS ? value : null;
}

function cleanNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

// Scouts often know a useful range, not a fake exact count. Keep the original
// meaning and derive one numeric estimate for aggregation. Open-ended values
// such as "100+" use 100 as a conservative lower-bound estimate; there is no
// mathematically honest midpoint when the upper bound is unknown.
// Ball-count buckets a scout picks from when estimating how many balls a robot
// handled in a match. Deliberately a fixed vocabulary rather than the free-text
// box used for auto points: counting balls at a glance is a rough judgement, and
// offering exact entry would imply a precision nobody watching a match actually
// has.
//
// Generated rather than written out so the steps cannot drift or contain a
// typo. 0-25 through 475-500 in steps of 25, then an open-ended top bucket -
// the ranges parse with parseAutoPointsEstimate() below, so "500+" yields a
// conservative lower bound instead of a midpoint.
export const BALL_COUNT_STEP = 25;
export const BALL_COUNT_MAX = 500;
export const BALL_COUNT_RANGES = Object.freeze([
  ...Array.from(
    { length: BALL_COUNT_MAX / BALL_COUNT_STEP },
    (_, index) => `${index * BALL_COUNT_STEP}-${(index + 1) * BALL_COUNT_STEP}`
  ),
  `${BALL_COUNT_MAX}+`
]);

export function parseAutoPointsEstimate(raw) {
  const text = String(raw ?? '').trim().replaceAll(',', '');
  if (!text) return null;

  const lowerBound = text.match(/^~?\s*(\d+(?:\.\d+)?)\s*\+$/);
  if (lowerBound) {
    const min = finitePoints(lowerBound[1]);
    if (min == null) return null;
    return {
      input: `${cleanNumber(min)}+`,
      min,
      max: null,
      average: min,
      kind: 'lower-bound'
    };
  }

  const range = text.match(/^~?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)$/i);
  if (range) {
    const min = finitePoints(range[1]);
    const max = finitePoints(range[2]);
    if (min == null || max == null || min > max) return null;
    return {
      input: `${cleanNumber(min)}-${cleanNumber(max)}`,
      min,
      max,
      average: (min + max) / 2,
      kind: min === max ? 'exact' : 'range'
    };
  }

  const exact = text.match(/^~?\s*(\d+(?:\.\d+)?)$/);
  if (!exact) return null;
  const value = finitePoints(exact[1]);
  if (value == null) return null;
  return {
    input: cleanNumber(value),
    min: value,
    max: value,
    average: value,
    kind: 'exact'
  };
}

// Releasing the pointer ends one drawing gesture, not the robot's route.
// Preserve previously captured points when the scout resumes drawing.
export function continueAutoPath(path, point) {
  const existingPath = Array.isArray(path) ? path : [];
  return [...existingPath, point];
}
