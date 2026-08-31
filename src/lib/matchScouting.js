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

// The field map uses a 1000 by 487 viewBox scaled from the official 2026
// field dimensions. Keeping the footprint math here lets the drawing surface,
// saved-path validation, and later route analysis agree on what "clear" means.
export const AUTO_FIELD = Object.freeze({
  width: 1000,
  height: 487,
  wallInset: 8,
  robotSizeInches: 29,
  fieldWidthInches: 651.25,
  fieldHeightInches: 317.0
});

export const AUTO_ROBOT_SIZE = Object.freeze({
  width: AUTO_FIELD.robotSizeInches * (AUTO_FIELD.width / AUTO_FIELD.fieldWidthInches),
  height: AUTO_FIELD.robotSizeInches * (AUTO_FIELD.height / AUTO_FIELD.fieldHeightInches)
});

// These are the simplified map's solid hubs and protected trenches. They are
// deliberately rectangles because the robot footprint is also represented as
// an axis-aligned square in the scouting view.
export const AUTO_NO_GO_AREAS = Object.freeze([
  { id: 'own-hub', label: 'alliance hub', x: 246, y: 198, width: 92, height: 92 },
  { id: 'opponent-hub', label: 'opponent hub', x: 662, y: 198, width: 92, height: 92 },
  { id: 'own-top-trench', label: 'alliance top trench', x: 260, y: 14, width: 34, height: 55 },
  { id: 'own-bottom-trench', label: 'alliance bottom trench', x: 260, y: 418, width: 34, height: 55 },
  { id: 'opponent-top-trench', label: 'opponent top trench', x: 706, y: 14, width: 34, height: 55 },
  { id: 'opponent-bottom-trench', label: 'opponent bottom trench', x: 706, y: 418, width: 34, height: 55 }
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function autoPointToField(point) {
  const x = Number(point?.[0]);
  const y = Number(point?.[1]);
  return {
    x: clamp(Number.isFinite(x) ? x : 0, 0, 100) * (AUTO_FIELD.width / 100),
    y: clamp(Number.isFinite(y) ? y : 0, 0, 100) * (AUTO_FIELD.height / 100)
  };
}

export function robotBoundsAtAutoPoint(point) {
  const center = autoPointToField(point);
  return {
    x: center.x - AUTO_ROBOT_SIZE.width / 2,
    y: center.y - AUTO_ROBOT_SIZE.height / 2,
    width: AUTO_ROBOT_SIZE.width,
    height: AUTO_ROBOT_SIZE.height
  };
}

function rectanglesIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function autoRobotCollision(point) {
  const robot = robotBoundsAtAutoPoint(point);
  const minX = AUTO_FIELD.wallInset;
  const minY = AUTO_FIELD.wallInset;
  const maxX = AUTO_FIELD.width - AUTO_FIELD.wallInset;
  const maxY = AUTO_FIELD.height - AUTO_FIELD.wallInset;
  if (robot.x < minX || robot.y < minY || robot.x + robot.width > maxX || robot.y + robot.height > maxY) {
    return { id: 'field-wall', label: 'field boundary' };
  }
  return AUTO_NO_GO_AREAS.find((area) => rectanglesIntersect(robot, area)) || null;
}

// Sample an extension finely enough that a fast pointer movement cannot jump
// through a hub or trench between two otherwise clear recorded points.
export function canExtendAutoPath(path, point) {
  const existingPath = Array.isArray(path) ? path : [];
  const previous = existingPath.at(-1);
  if (!previous) {
    const collision = autoRobotCollision(point);
    return { allowed: !collision, collision };
  }

  const start = autoPointToField(previous);
  const end = autoPointToField(point);
  const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 3));
  let lastSafePoint = previous;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const candidate = [
      (start.x + (end.x - start.x) * t) / (AUTO_FIELD.width / 100),
      (start.y + (end.y - start.y) * t) / (AUTO_FIELD.height / 100)
    ];
    const collision = autoRobotCollision(candidate);
    if (collision) return { allowed: false, collision, lastSafePoint };
    lastSafePoint = candidate;
  }
  return { allowed: true, collision: null, lastSafePoint };
}

function intervalWithinBand(start, end, min, max) {
  const delta = end - start;
  if (Math.abs(delta) < 0.0001) return start >= min && start <= max ? [0, 1] : null;
  const first = (min - start) / delta;
  const second = (max - start) / delta;
  const low = Math.max(0, Math.min(first, second));
  const high = Math.min(1, Math.max(first, second));
  return low <= high ? [low, high] : null;
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const interval of intervals.filter(Boolean).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

// Returns just the portion(s) of a segment where the 29-inch footprint
// overlaps either centerline. Rendering only these intervals red leaves the
// rest of the hand-drawn route in its normal color.
export function autoCenterlineIntervals(startPoint, endPoint) {
  const start = autoPointToField(startPoint);
  const end = autoPointToField(endPoint);
  const halfWidth = AUTO_ROBOT_SIZE.width / 2;
  const halfHeight = AUTO_ROBOT_SIZE.height / 2;
  return mergeIntervals([
    intervalWithinBand(start.x, end.x, AUTO_FIELD.width / 2 - halfWidth, AUTO_FIELD.width / 2 + halfWidth),
    intervalWithinBand(start.y, end.y, AUTO_FIELD.height / 2 - halfHeight, AUTO_FIELD.height / 2 + halfHeight)
  ]);
}
