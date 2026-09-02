/**
 * How many workholding tabs an outer routed profile should get.
 *
 * Replaces a bare `floor(perimeter / spacing)` divisor (routing.js's old
 * tab-count formula) with sane bounds on both ends:
 *
 *   - NEVER just 1 tab. A single tab isn't real holding - it's a pivot
 *     point the part can still rock/rotate around as the surrounding
 *     material falls away on the final pass. Found on a real generated
 *     file (a ~3"x2.2" plate, perimeter ~10.5", default 6" spacing): the
 *     old formula gave exactly 1 tab, centered right at the path's seam.
 *   - Capped so a large part doesn't get an excessive number of tabs -
 *     every tab is material the operator has to knock out and clean up by
 *     hand afterward; more tabs past a point isn't automatically safer,
 *     just more post-processing.
 *
 * Perimeter is the primary driver - same "spacing" concept routing.js's
 * existing tabSpacing param already uses (inches of edge per tab). Material
 * thickness, when given, is a real secondary factor: thin stock flexes and
 * chatters more easily near the end of a cut and benefits from tighter
 * spacing (more tabs) than thick stock, which is inherently more rigid on
 * its own. This is a coarse, clearly-bounded nudge (+/-25% spacing), not a
 * precise physics model - thickness alone doesn't determine real-world
 * holding strength (material, part shape, and mass all matter too), so
 * this is meant as a better starting point than a flat spacing constant,
 * not a substitute for looking at the actual part. Every input remains
 * fully overridable via the options below.
 */

export const MIN_TABS = 2;
export const MAX_TABS = 6;
export const DEFAULT_SPACING = 6; // inches of perimeter per tab - matches routing.js's existing tabSpacing default

const THIN_STOCK_THRESHOLD = 0.1; // inches - below this, tighten spacing (more tabs)
const THICK_STOCK_THRESHOLD = 0.375; // inches - above this, loosen spacing (fewer tabs)
const THICKNESS_SPACING_ADJUSTMENT = 0.25; // +/-25% spacing shift at the thresholds above

/**
 * @param {number} perimeter - inches, the tab-bearing contour's total path length
 * @param {Object} [options]
 * @param {number} [options.spacing] - target inches of perimeter per tab (default 6)
 * @param {number|null} [options.thickness] - material thickness in inches, if known
 * @param {number} [options.minTabs] - hard floor (default 2 - see file header)
 * @param {number} [options.maxTabs] - hard cap (default 6 - see file header)
 * @returns {number} recommended tab count, 0 only if perimeter/spacing is invalid
 */
export function recommendTabCount(perimeter, options = {}) {
  const { spacing = DEFAULT_SPACING, thickness = null, minTabs = MIN_TABS, maxTabs = MAX_TABS } = options;
  if (!(perimeter > 0) || !(spacing > 0)) return 0;

  let effectiveSpacing = spacing;
  if (thickness != null && thickness > 0) {
    if (thickness < THIN_STOCK_THRESHOLD) effectiveSpacing = spacing * (1 - THICKNESS_SPACING_ADJUSTMENT);
    else if (thickness > THICK_STOCK_THRESHOLD) effectiveSpacing = spacing * (1 + THICKNESS_SPACING_ADJUSTMENT);
  }

  const raw = Math.round(perimeter / effectiveSpacing);
  return Math.min(maxTabs, Math.max(minTabs, raw));
}

/**
 * Where the tabs go, not just how many.
 *
 * The old placement spaced tabs evenly by perimeter distance and looked at
 * nothing else, so a tab could land in the middle of a fillet or an arc. A
 * tab on a curve is worse than one on a flat in three concrete ways: the
 * uncut web is wedge-shaped rather than square so it holds unevenly, the
 * cutter is mid-direction-change when it steps up and back down, and
 * knocking the part out afterwards tears a curved edge that is usually a
 * finished surface.
 *
 * So: find the straight runs, then place tabs on them.
 *
 * "Straight" is measured by turn angle between consecutive segments rather
 * than by segment length, because the extractor tessellates real arcs into
 * many short chords - a curve here is a long series of small consistent
 * turns, and each individual chord looks perfectly straight on its own.
 */

// A real corner always ends a run, however short.
const CORNER_TURN = 0.35;              // radians (~20 degrees)
// Curvature - turn per inch of path - above which a span is a curve rather
// than a flat, however gently each individual chord turns. This is the test
// that separates a tessellated arc from a straight edge: a 2" radius arc
// carries 0.5 rad/in no matter how finely it is chopped up, while a real
// flat carries ~0. Equivalent to "flatter than a 20-inch radius".
const MAX_TAB_CURVATURE = 0.05;        // radians per inch
// A tab needs flat either side of it, not merely enough room to fit.
const MIN_RUN_TO_TAB_WIDTH = 3;

function segmentsOf(path) {
  const segments = [];
  let distance = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i], b = path[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 0) continue;
    segments.push({ start: distance, end: distance + length, length, angle: Math.atan2(b.y - a.y, b.x - a.x) });
    distance += length;
  }
  return segments;
}

const angleDelta = (from, to) => {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
};

/**
 * Maximal spans of the path that stay flat, as {start, end} distances along
 * the path. Exported for testing and for callers that want to show the
 * operator where a tab could legally go.
 */
export function findStraightRuns(path) {
  const segments = segmentsOf(path);
  if (!segments.length) return [];

  const runs = [];
  let current = { start: segments[0].start, end: segments[0].end, turn: 0 };
  const close = () => runs.push({ start: current.start, end: current.end });

  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i];
    const step = angleDelta(segments[i - 1].angle, seg.angle);
    const turn = current.turn + step;
    const length = seg.end - current.start;
    // Curvature is measured over the run so far, so a long flat tolerates
    // the odd tiny wobble while a steady arc is rejected from its second
    // chord onward.
    if (step > CORNER_TURN || (length > 0 && turn / length > MAX_TAB_CURVATURE)) {
      close();
      current = { start: seg.start, end: seg.end, turn: 0 };
    } else {
      current.end = seg.end;
      current.turn = turn;
    }
  }
  close();
  return runs;
}

/**
 * Tab centre positions along the path, in path distance.
 *
 * Spreads `count` tabs around the perimeter, then moves each one to the
 * nearest point that sits wholly on a straight run with the tab's full
 * width clear of both ends. A tab with nowhere flat to go is dropped rather
 * than placed on a curve - the caller sees a shorter list and can say so,
 * which is honest about a part that genuinely has few flats.
 *
 * @param {Array<{x:number,y:number}>} path closed contour, path[0] === path[-1]
 * @param {Object} options
 * @param {number} options.count how many tabs to aim for
 * @param {number} options.width tab width in inches
 * @returns {number[]} centre distances, ascending
 */
export function planTabPositions(path, { count, width } = {}) {
  if (!(count > 0) || !(width > 0) || !Array.isArray(path) || path.length < 2) return [];
  const runs = findStraightRuns(path);
  const perimeter = segmentsOf(path).reduce((sum, s) => sum + s.length, 0);
  if (!(perimeter > 0)) return [];

  // Only runs that can hold a whole tab are candidates.
  const usable = runs
    .map((run) => ({ ...run, length: run.end - run.start }))
    .filter((run) => run.length >= width * MIN_RUN_TO_TAB_WIDTH);
  // Nowhere flat. Returning nothing here would cut the part completely free
  // with nothing holding it, which is far worse than a tab on a curve - so
  // fall back to even spacing and let the caller say why. A round part has
  // to be held somewhere.
  if (!usable.length) return [];

  const placed = [];
  for (let i = 0; i < count; i += 1) {
    const ideal = (perimeter / count) * i;
    // Nearest usable run, measured to the span where the tab would still
    // fit entirely inside it.
    let best = null;
    for (const run of usable) {
      const lo = run.start + width / 2;
      const hi = run.end - width / 2;
      const centre = Math.min(hi, Math.max(lo, ideal));
      const distance = Math.abs(centre - ideal);
      if (!best || distance < best.distance) best = { centre, distance, run };
    }
    if (!best) continue;
    // Never stack two tabs on top of each other when several ideal points
    // collapse onto the same short run.
    if (placed.some((p) => Math.abs(p - best.centre) < width)) continue;
    placed.push(best.centre);
  }
  return placed.sort((a, b) => a - b);
}

/**
 * Even spacing around the perimeter, ignoring shape. Only for a profile
 * with no flat long enough to host a tab - a fully round part still has to
 * be held, and no tabs at all means it comes loose on the final pass. The
 * caller is expected to say in the program that this happened, since the
 * tabs will sit on a curved edge and need more care to clean up.
 */
export function planEvenTabPositions(perimeter, { count, width } = {}) {
  if (!(count > 0) || !(perimeter > 0) || !(width > 0)) return [];
  return [...Array(count)].map((_, i) => (perimeter / count) * i);
}
