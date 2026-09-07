/**
 * Routing G-code generator - 2D profile/pocket cutting from closed contours
 * (extracted from a STEP file's flat face - see stepProfile.js).
 *
 * TWO CONTROLLER DIALECTS (params.controller, default 'linuxcnc' - this
 * default is completely unchanged from before this option existed):
 *
 *   'linuxcnc' (default) - matches this app's app-wide .ngc convention:
 *     G20/G21, G17 (XY plane), G94 (feed/min), G54 work offset, M00 tool
 *     change pause, M03/M05 spindle, M30 program end, "(...)" comments.
 *
 *   'wincnc' - for a real ShopSabre-brand router (e.g. the shop's
 *     ShopSabre Pro 408), which runs WinCNC, not LinuxCNC - a genuinely
 *     different G-code dialect. Originally based on WinCNC's own command
 *     reference manual (wincnc.com); as of 2026-09-03 cross-checked against
 *     the shop's actual post-processor configs and a real Fusion-cammed
 *     output file (see autocam/postprocessors/README.md), which is more
 *     authoritative for this exact machine - one assumption below (G54-G59)
 *     turned out to be wrong and was corrected against that real source:
 *       - Comments are "[...]", not "(...)" - confirmed in shopsabre.cps
 *         (settings.comments.prefix/suffix).
 *       - G21 means CENTIMETERS on WinCNC, not millimeters - G22 is
 *         millimeters. Emitting standard G21 for a metric job here would
 *         be a silent 10x scale error. (units='mm' has no UI path today,
 *         but this generator gets it right either way.) Confirmed:
 *         shopsabre.cps's onOpen never emits G21, only G20 or G22.
 *       - G17 (plane select) is not a documented WinCNC code - omitted
 *         rather than emitting something that might abort parsing.
 *       - G54-G59 ARE standard stored work offsets on the real machine,
 *         selected by section work offset exactly like LinuxCNC/Fanuc
 *         (shopsabre.cps onSection: workOffset > 1 -> G(53 + workOffset)).
 *         Emitted the same as 'linuxcnc' below - not head-selection codes,
 *         and not something requiring an interactive G92 jog-and-zero
 *         every run, as previously assumed here.
 *       - M00 is not a documented WinCNC code; the real "pause until the
 *         operator presses ENTER" mechanism is a bare G4 (dwell with no
 *         time value), which also supports a bracketed prompt - exactly
 *         what WinCNC's own manual shows as an example. Used here for
 *         every tool-change pause instead of M00.
 *       - M30 is not a documented WinCNC code either - omitted (replaced
 *         with a plain end-of-program comment) rather than guessed.
 *       - M03/M05 (spindle on/off) ARE kept for 'wincnc' - not because
 *         they're in WinCNC's base command set (they aren't), but because
 *         ShopSabre routers ship with them pre-defined as CNC.MAC macros
 *         (M3 -> spin.mac -> M11 on the spindle relay channel, M5 ->
 *         spinoff.mac -> M12), a documented ShopSabre-specific convention.
 *         This is the one dialect choice resting on "ShopSabre sets this
 *         up by default" rather than the base WinCNC manual - worth a
 *         real air-cut check the first time this runs on the actual
 *         machine, same as everything else this generator produces.
 *
 * Every generated file opens with HEADER_WARNING from turning.js (same
 * text, reused here for consistency), which asks the operator to confirm
 * work zero, stock and clamps and to dry-run clear of the stock.
 *
 * KNOWN LIMITATION: tool-radius compensation is done with a hand-rolled
 * polygon offset (edge-normal offset + miter join at vertices), not a
 * robust general polygon-clipping library. It handles typical convex/mildly
 * concave profiles fine; on very tight concave features the offset can
 * self-intersect without being cleaned up. Inspect the toolpath (or run it
 * through a simulator) before cutting anything with sharp internal corners
 * smaller than the tool diameter.
 *
 * CUT ORDER - internal features before the outer profile: every hole/pocket
 * contour is fully machined before the outer contour is cut, regardless of
 * which array position or tool it came from (see the ordering in
 * generateRoutingGcode). Once the outer profile is cut through material,
 * the part is only still attached to the surrounding stock via tabs (if
 * any) or clamping - continuing to machine anything else after that risks
 * the part shifting, vibrating, or coming loose mid-operation. This can
 * mean an extra tool change if the outer needs a tool already used for an
 * earlier hole; that's an acceptable, minor tradeoff for not cutting a
 * loose part.
 *
 * ENTRY SAFETY - no straight plunges into solid material: every pass ramps
 * into depth instead of dropping straight down at a fixed point before
 * cutting - see cutContour/emitContourPass. A vertical plunge with a
 * milling cutter (not a drill) at full stepdown depth, with no ramp/helix
 * and no pre-drilled clearance hole, is a well-known way to break a small
 * tool or load it heavily - real risk for interior cuts (holes/pockets),
 * which have no open edge to enter from in fresh air the way an outer
 * profile sometimes does.
 *
 * TRUE ARCS FOR CIRCULAR FEATURES: a hole or boss traced from a STEP file's
 * triangulated mesh comes out of stepProfile.js as a many-sided polygon
 * approximating a circle, not an actual circle - see fitCircle. When a
 * contour's offset toolpath fits a circle within CIRCLE_FIT_TOLERANCE, this
 * generator cuts it with real G02/G03 helical entry + circular
 * interpolation (emitHelicalCircularContour) instead of walking the
 * polygon with hundreds of short G01 segments - fixes faceted surface
 * finish and needless file size, and doubles as the entry-safety fix for
 * that contour (a helical ramp is the standard way to plunge a circular
 * feature). Non-circular contours still get the polygon-following G01 path,
 * just with a linear Z-ramp over the first part of each pass instead of a
 * vertical plunge before it. Tabs (see below) only ever apply to a
 * non-circular OR tab-free outer contour - a circular outer contour that
 * also wants tabs falls back to the polygon path, since interrupting a
 * helical arc cut to leave tab webs isn't implemented.
 *
 * CORNER FEED SLOWDOWN: every G01 cutting move on the polygon-following path
 * (not the true-arc path above - a circle has no corners) is fed at a
 * reduced rate when it arrives at a sharp vertex, easing back to full feed
 * on gentle bends and dead-straight runs - see cornerFeedScale. Protects
 * against the force/deflection spike a round tool sees wrapping a sharp
 * corner at full feed. Cross-checked against PenguinCAM (github.com/6238/
 * PenguinCAM), an independent open-source FRC router CAM tool that does the
 * same thing - not an invented-from-scratch technique.
 *
 * MULTI-TOOL SUPPORT: pass params.toolSequence (ordered array of tool specs,
 * primary/largest tool first) to cut different contours with different
 * tools - each contour is assigned to the *first* tool in the sequence that
 * geometrically fits it (reusing the same throat-distance check offsetPolygon
 * already does), falling through to smaller tools only where the primary
 * tool physically can't reach (e.g. a hole narrower than its diameter).
 * This is deliberately NOT true rest-machining (recutting the leftover
 * material a larger tool couldn't clear on the same contour) - that needs
 * robust polygon-boolean geometry this file doesn't have. What it does do:
 * let a job use a strong/fast primary bit for everything that fits it, and
 * automatically fall back to a smaller detail bit only for the features
 * that need one, in a single program. See implementations/toolchange-gcode-plan.md.
 *
 * Every tool change assumes NO automatic tool-length compensation (no
 * confirmed tool setter on the router this targets) - each change is a
 * genuine program pause (M00, or G4 on 'wincnc' - see above) instructing
 * the operator to load the new bit and RE-TOUCH OFF Z0 before resuming.
 * If this router does get a tool setter later, that assumption (and the
 * block below) needs revisiting.
 */

import { normalizeGcodeComments } from './gcodeComments.js';
import { HEADER_WARNING } from './turning.js';
import { recommendTabCount, planTabPositions, planEvenTabPositions } from './tabPlanner.js';
import { formatGcodeNumber as fmt, gcodePauseLine as pauseLine, gcodeDwellLine as dwellLine } from './gcodeFormatting.js';
import { signedArea2d as signedArea } from './geometry2d.js';

// Ensures a closed polygon (last point == first) winds counter-clockwise.
// Epsilon, not exact equality, for "is this already closed" - a contour
// whose first/last point was derived from trig (sin/cos of a full turn) or
// any other floating-point computation is extremely unlikely to be
// bit-identical even when it's geometrically the same point (e.g.
// Math.sin(2*Math.PI) is ~1.2e-16, not exactly 0). Exact equality here used
// to let a near-but-not-exactly-closed contour slip through as "not
// closed", appending a fresh duplicate point and creating a genuine
// near-zero-length phantom edge at the seam - normalize()'s zero-length
// fallback then produced a garbage edge normal there, corrupting the
// offset specifically at that one vertex. Caught via fitCircle's tests on
// a synthetic circle, not a hypothetical.
const CLOSE_POINT_EPSILON = 1e-9;
// Below this, a convex vertex (a "point" of void poking into material) is
// considered sharp enough that fillet advice belongs in the error message -
// see sharpestConvexAngleDegrees. Calibrated against real shapes: a plain
// square/rectangle corner (90°, never a problem) vs a 24-tooth spline/gear
// hole's tooth tips (~15°, a real "too small for this tool" case) - 60°
// sits with wide margin below the former and above the latter.
const SHARP_CORNER_ANGLE_DEGREES = 60;
function ensureCCW(points) {
  const first = points[0], last = points[points.length - 1];
  const alreadyClosed = Math.abs(first.x - last.x) < CLOSE_POINT_EPSILON && Math.abs(first.y - last.y) < CLOSE_POINT_EPSILON;
  const pts = alreadyClosed ? points : points.concat([points[0]]);
  return signedArea(pts) < 0 ? pts.slice().reverse() : pts;
}

function normalize(vx, vy) {
  const len = Math.hypot(vx, vy) || 1;
  return [vx / len, vy / len];
}

// Line-line intersection of two infinite lines, each defined by a point + direction.
function intersectLines(p1, d1, p2, d2) {
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const t = ((p2.x - p1.x) * d2[1] - (p2.y - p1.y) * d2[0]) / denom;
  return { x: p1.x + d1[0] * t, y: p1.y + d1[1] * t };
}

function cross2(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

// Distance from ray (origin + t*dir, t>0) to where it crosses segment [a,b],
// or null if it doesn't hit (behind the origin, parallel, or off the
// segment's own extent). Standard ray/segment intersection via cross
// products; dir is assumed to already be a unit vector, so the returned t
// is a true distance.
function rayHitDistance(origin, dir, a, b) {
  const sx = b.x - a.x, sy = b.y - a.y;
  const denom = cross2(dir[0], dir[1], sx, sy);
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = a.x - origin.x, qpy = a.y - origin.y;
  const t = cross2(qpx, qpy, sx, sy) / denom;
  const u = cross2(qpx, qpy, dir[0], dir[1]) / denom;
  if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) return t;
  return null;
}

// Smallest interior angle among the polygon's CONVEX vertices only (a
// "point" of the enclosed void poking into the surrounding material - the
// tip of a dart/star/spline-tooth shape, or a V cut into a pocket wall).
// Reflex (concave) vertices are skipped: those are corners where the void
// itself is roomy and the MATERIAL comes to a point instead, which a round
// tool navigates around freely, not into - not the "can a tool ever reach
// this" problem this function is checking for. Standard signed turn-angle
// per vertex: positive (left) turn = convex for a CCW polygon.
function sharpestConvexAngleDegrees(pts) {
  const n = pts.length;
  let sharpest = Infinity;
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const d1x = cur.x - prev.x, d1y = cur.y - prev.y;
    const d2x = next.x - cur.x, d2y = next.y - cur.y;
    const turn = Math.atan2(cross2(d1x, d1y, d2x, d2y), d1x * d2x + d1y * d2y);
    if (turn <= 0) continue; // reflex/straight - not a convex "point"
    const interiorDegrees = (Math.PI - turn) * (180 / Math.PI);
    if (interiorDegrees < sharpest) sharpest = interiorDegrees;
  }
  return sharpest;
}

// For each edge midpoint, casts a ray straight across the polygon's own
// enclosed area (the (-dy,dx) direction - the same direction a negative/
// inward offset moves points in offsetPolygon below, i.e. "into the void
// this loop encloses," not out into the surrounding material) and finds
// the nearest OTHER edge it crosses - i.e. "how far to the opposite wall
// of this same pocket/hole from here." The global minimum across all edges
// is the true narrowest local constriction. Used ONLY for the human-
// readable size estimate in the "too small for this tool" error message,
// not as the actual pass/fail gate (see offsetPolygon's real check).
//
// Replaced an earlier centroid-to-edge version that was a fine estimate for
// a roughly-convex, roughly-circular hole but badly wrong for a non-convex/
// many-featured one in EITHER direction: it could read falsely small (a
// concave cutout's centroid sitting close to its own edge, an artifact of
// concavity, not a real constriction) or - the case that caught this
// specific version - falsely LARGE for a real splined bore (REV-21-2360, a
// "MAXSpline" internal spline pattern): the centroid sits in the open hub
// space at the bore's center, far from any edge, so it reported "~0.55" at
// its tightest" for a hole whose actual narrowest tooth-to-tooth gap
// (verified by bisecting the real pass/fail radius against offsetPolygon
// itself) was 0.083" - nearly 7x off, and confusing for anyone reading the
// error trying to understand why a 0.125" tool didn't fit a "0.55" wide"
// feature. Ray-casting across the shape from each edge directly measures
// local width instead of relying on a single global reference point, so it
// isn't fooled by either failure mode.
function minThroatDistance(pts) {
  const n = pts.length;
  // Skipping only the origin edge itself isn't enough on a fine, zigzagging
  // boundary (e.g. gear/spline teeth): a ray from one tooth's edge can graze
  // a NEIGHBORING edge that merely happens to share a nearby vertex, at a
  // shallow near-t=0 angle - a self-geometry artifact, not a real opposite
  // wall. Excluding a small local window of edges around the origin (scaled
  // to point density) filters that out while still finding genuinely
  // distant/opposite constrictions.
  //
  // Capped at floor(n/2)-1: for a coarse polygon (a plain rectangle, n=4,
  // is the simplest real case: every hole/pocket contour is at LEAST this
  // shape) the uncapped window can reach or exceed the largest index
  // distance any two edges can have at all - excluding every possible pair,
  // including genuinely opposite ones (the two long sides of a rectangle).
  // With nothing left to compare, `min` stayed Infinity and fell back to a
  // bogus "0.0000" reading - a real regression found testing a plain
  // 4-point rectangular slot, the simplest possible hole shape, right after
  // this ray-cast version was written for a complex 175-point case.
  const window = Math.min(Math.max(2, Math.round(n / 20)), Math.floor(n / 2) - 1);
  let min = Infinity;
  for (let i = 0; i < n; i += 1) {
    const a = pts[i], b = pts[(i + 1) % n];
    const [dx, dy] = normalize(b.x - a.x, b.y - a.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dir = [-dy, dx];
    for (let j = 0; j < n; j += 1) {
      const indexDist = Math.min((j - i + n) % n, (i - j + n) % n);
      if (indexDist <= window) continue;
      const t = rayHitDistance(mid, dir, pts[j], pts[(j + 1) % n]);
      if (t !== null && t < min) min = t;
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * Offsets a closed CCW polygon by `distance` (positive = outward/grows the
 * loop, negative = inward/shrinks it). Simple edge-normal + miter-join
 * offset - see file-level KNOWN LIMITATION.
 */
export function offsetPolygon(points, distance) {
  const ccw = ensureCCW(points);
  const pts = ccw.slice(0, -1); // drop duplicate closing point for the math, re-close at the end
  const n = pts.length;
  if (n < 3) throw new Error('Polygon needs at least 3 vertices to offset');
  if (distance === 0) return ccw;

  const edges = [];
  for (let i = 0; i < n; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const [dx, dy] = normalize(b.x - a.x, b.y - a.y);
    // Outward normal for a CCW polygon is (dy, -dx).
    const nx = dy;
    const ny = -dx;
    edges.push({
      a: { x: a.x + nx * distance, y: a.y + ny * distance },
      dir: [dx, dy],
      nx, ny
    });
  }

  const MAX_MITER = Math.abs(distance) * 8; // clamp runaway spikes on sharp concave corners
  const offset = [];
  for (let i = 0; i < n; i += 1) {
    const prev = edges[(i - 1 + n) % n];
    const cur = edges[i];
    const hit = intersectLines(prev.a, prev.dir, cur.a, cur.dir);
    const fallback = { x: (prev.a.x + cur.a.x) / 2, y: (prev.a.y + cur.a.y) / 2 };
    const candidate = hit || fallback;
    const dFromOriginal = Math.hypot(candidate.x - pts[i].x, candidate.y - pts[i].y);
    offset.push(dFromOriginal > MAX_MITER ? fallback : candidate);
  }
  offset.push(offset[0]);

  // Real bug this catches: naive edge-offset-and-intersect doesn't fail
  // gracefully when `distance` exceeds what the local geometry can support
  // - it doesn't "collapse toward nothing," a miter intersection can
  // overshoot far enough that a corner ends up diagonally opposite from
  // where it should be, producing a same-size-ish but topologically
  // inverted shape that can have valid CCW/positive area AND have every
  // point still technically within the original polygon's bounds (tried
  // and rejected two weaker checks before this one: area/winding alone
  // misses it because a whole-polygon flip-through can cancel out and
  // still look valid; "is each point outside any original edge" also
  // misses it, because an overshot-but-still-inverted point can land
  // genuinely inside the original bounds, just at the wrong corner).
  //
  // The one invariant that actually holds for every case: a valid inward
  // offset can only ever shrink an edge, never reverse its direction. If
  // offset edge i points opposite to where original edge i pointed, that
  // edge - and the shape - inverted.
  let reversed = false;
  if (distance < 0) {
    for (let i = 0; i < n; i += 1) {
      const a = offset[i], b = offset[(i + 1) % n];
      const dot = (b.x - a.x) * edges[i].dir[0] + (b.y - a.y) * edges[i].dir[1];
      if (dot <= 0) { reversed = true; break; }
    }
  }

  // "Does the tool actually fit" is checked on the REAL computed offset, not
  // guessed beforehand - the reversed-edge check above is the actual bug this
  // catches, backed by a coarse area/winding check for the ordinary
  // "shrinks to nothing" collapse case. See minThroatDistance's doc comment
  // for why a pre-emptive centroid-distance guess isn't reliable here.
  if (distance < 0) {
    const offsetArea = signedArea(offset);
    const originalArea = Math.abs(signedArea(ccw));
    if (reversed || offsetArea <= 0 || offsetArea < originalArea * 0.001) {
      const throat = minThroatDistance(pts);
      // A sharp convex vertex (a "point" of void poking into material - a
      // dart/star tooth tip, a V-notch) is a DIFFERENT problem than a
      // uniformly small feature: no tool, however small, can ever perfectly
      // reach a mathematically sharp interior point - a round cutter always
      // leaves at least its own radius of material there. Swapping to a
      // smaller tool only shrinks how much gets left behind, it never fixes
      // this the way it fixes a genuinely-too-small hole. Detected directly
      // from geometry (the sharpest convex interior angle in the contour,
      // not inferred from whether this specific offset attempt happened to
      // fail) so the advice is right regardless of which tool was tried.
      const sharpestAngle = sharpestConvexAngleDegrees(pts);
      const advice = sharpestAngle < SHARP_CORNER_ANGLE_DEGREES
        ? `this contour has a sharp internal corner (~${sharpestAngle.toFixed(0)}°) - a round tool can never fully reach a ` +
          `mathematically sharp interior point no matter how small it is; add a fillet there in your CAD (radius >= the ` +
          `tool radius) and regenerate`
        : 'use a smaller tool or drop this hole/pocket';
      throw new Error(
        `Feature is too small for this tool: tool radius ${Math.abs(distance).toFixed(4)}" collapses this contour ` +
        `(roughly ~${throat.toFixed(4)}" at its tightest point) - ${advice}`
      );
    }
  }

  return offset;
}

// Feed-rate scaling at sharp corners - a real technique independently found
// in PenguinCAM (github.com/6238/PenguinCAM, an open-source FRC router CAM
// tool used by other teams), cross-checked here against it rather than
// invented blind. A round tool cutting a polygon at a constant feed wraps
// both adjacent edges at once as it goes around a sharp corner - the
// effective engagement (and cutting force) spikes right at the vertex,
// which is exactly the kind of load spike that deflects a small router bit
// or leaves visible burning/chatter marks on the inside of a tight corner.
// Slowing the feed specifically through that vertex tames the spike without
// changing the toolpath geometry at all - same path, just paced differently.
//
// Adapted, not copied 1:1: PenguinCAM inserts extra waypoints to ease feed
// in/out over a tool-diameter-sized zone approaching each corner; this
// applies the scale directly to the G01 move that ARRIVES at the corner
// vertex instead, since routing.js's existing per-segment loop already
// walks vertex-by-vertex (see emitContourPass) - simpler, and the moment
// that actually matters (the tool physically engaging the corner) is still
// slowed, without threading corner-aware sub-segment splitting through the
// ramp-Z and tab-zone interpolation that segment loop already has to get
// right. Thresholds and the feed floor match PenguinCAM's own values
// (150deg/60deg/0.4x) as a real-world-calibrated starting point, not a guess.
const CORNER_GENTLE_DEGREES = 150; // included angle >= this: straight-through enough that no slowdown is needed
const CORNER_SHARP_DEGREES = 60; // included angle <= this: full slowdown (CORNER_MIN_FEED_SCALE)
const CORNER_MIN_FEED_SCALE = 0.4; // feed multiplier floor at the sharpest corners

export function cornerFeedScale(prev, cur, next) {
  const ax = prev.x - cur.x, ay = prev.y - cur.y;
  const bx = next.x - cur.x, by = next.y - cur.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 1; // degenerate (coincident points) - nothing meaningful to slow down for
  const cosIncluded = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  const includedDegrees = Math.acos(cosIncluded) * (180 / Math.PI); // 0 = spike back on itself, 180 = dead straight
  if (includedDegrees >= CORNER_GENTLE_DEGREES) return 1;
  if (includedDegrees <= CORNER_SHARP_DEGREES) return CORNER_MIN_FEED_SCALE;
  const t = (includedDegrees - CORNER_SHARP_DEGREES) / (CORNER_GENTLE_DEGREES - CORNER_SHARP_DEGREES);
  return CORNER_MIN_FEED_SCALE + t * (1 - CORNER_MIN_FEED_SCALE);
}

function pathLength(path) {
  let len = 0;
  for (let i = 0; i < path.length - 1; i += 1) len += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
  return len;
}

// Evenly spaces tab zones (as [startDist, endDist] along the path) every
// `spacing` inches of perimeter, each `width` inches wide - count comes from
// recommendTabCount (tabPlanner.js), not a bare floor(perimeter/spacing):
// that alone can degenerate to a single tab for a perfectly normal-sized
// part (found on a real ~3"x2.2" plate, perimeter ~10.5", default 6"
// spacing - floor gives exactly 1), and a single tab is a pivot point, not
// real holding - see tabPlanner.js's file header for the full reasoning and
// the matching upper bound (not too many tabs either).
//
// The path is a closed loop, so distance 0 and distance `perimeter` are the
// SAME physical point (the seam). `i === 0` always puts a zone's center
// exactly there (center = (perimeter/count)*0 = 0) - every time tabs are on,
// not a rare edge case. A zone centered at the seam needs half its width on
// each side of it - i.e. split across the [0, w] start of the path AND the
// [perimeter-w, perimeter] end of it. Previously this just clamped the
// low side away (`Math.max(0, center - width/2)`) with no compensating
// piece at the other end, so that first tab was silently cut at HALF its
// configured width, every single job, with no error or warning - a real
// workholding weak point, not cosmetic. Same wraparound applies (in theory)
// if a zone's high end overshoots `perimeter`, though centers are spaced
// starting from 0 so in practice only the first zone ever needs it.
function buildTabZones(path, perimeter, width, spacing, thickness, requestedCount) {
  if (perimeter <= 0) return [];
  // A zero-width tab holds nothing. Without this, tabWidth: 0 still produced
  // one [center, center] zone per tab and stats.tabZones reported them, so a
  // part cut completely free was described as held by four tabs - and that
  // count is exactly what a consumer would trust to say the part is secure.
  if (!(width > 0)) return [];
  // An explicit per-job count wins over the perimeter/spacing recommendation.
  const count = requestedCount > 0 ? Math.floor(requestedCount) : recommendTabCount(perimeter, { spacing, thickness });
  // Placed on the flats. planTabPositions keeps a tab off arcs and fillets -
  // a tab on a curve leaves a wedge-shaped web that holds unevenly, makes
  // the cutter step up mid-direction-change, and tears a finished edge when
  // it is knocked out. It returns fewer positions than asked for rather than
  // putting one on a curve, so a part with few flats is reported honestly.
  let centers = planTabPositions(path, { count, width });
  let onCurves = false;
  if (!centers.length && count > 0) {
    // No flat long enough anywhere - a fully round profile, say. Holding it
    // badly beats not holding it at all: a part with no tabs comes loose on
    // the final pass. Flagged so the program can tell the operator the tabs
    // sit on a curved edge and will need more care to clean up.
    centers = planEvenTabPositions(perimeter, { count, width });
    onCurves = true;
  }
  const zones = [];
  zones.onCurves = onCurves;
  for (const center of centers) {
    const start = center - width / 2;
    const end = center + width / 2;
    if (start < 0) {
      zones.push([0, Math.min(perimeter, end)]);
      zones.push([Math.max(0, perimeter + start), perimeter]);
    } else if (end > perimeter) {
      zones.push([start, perimeter]);
      zones.push([0, Math.min(perimeter, end - perimeter)]);
    } else {
      zones.push([start, end]);
    }
  }
  return zones;
}

// Best-effort circle fit (center = centroid, radius = mean distance to it) +
// how far the path actually deviates from that circle - see file header
// "TRUE ARCS FOR CIRCULAR FEATURES". `path` is closed (last point repeats
// the first); dropping the repeat before averaging avoids double-weighting it.
//
// Samples both vertices AND edge midpoints, not just vertices - a regular
// polygon's vertices alone are ALWAYS equidistant from its centroid (a
// square's 4 corners are exactly as "circular" as any circle's sample
// points, by symmetry), which would otherwise let a plain square, hexagon,
// or any other regular polygon false-positive as a circle. Edge midpoints
// correctly expose that: a genuine many-segment circle approximation has
// edge midpoints almost exactly as far from center as its vertices (each
// segment subtends a tiny angle), while a square's edge midpoints sit
// dramatically closer to center than its corners do. Caught by this file's
// own tests, not shipped blind - see routing.test.js.
function fitCircle(path) {
  const pts = path.slice(0, -1);
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;

  const samples = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    samples.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }

  const radii = samples.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const radius = radii.reduce((a, b) => a + b, 0) / radii.length;
  const maxDeviation = Math.max(...radii.map((r) => Math.abs(r - radius)));
  return { cx, cy, radius, maxDeviation };
}
const CIRCLE_FIT_TOLERANCE = 0.003; // inches - tight enough to reject genuinely non-circular shapes, loose enough to absorb STEP mesh tessellation facets

// Minimum helical-toolpath radius, as a fraction of the tool's own radius,
// for a circular hole's entry to still be a genuine helix rather than a
// disguised plunge wearing an arc-command costume. Real bug this guards
// against: emitHelicalCircularContour's turn count (turns = ceil(zDrop /
// (radius * MAX_RAMP_SLOPE))) blows up without bound as radius shrinks - a
// real hole only marginally bigger than its assigned tool (found on a real
// fixture: a ~0.264" hole cut with a 0.25" tool, leaving a 0.007" toolpath
// radius) produces 100+ turns per step-down pass while the tool barely
// moves in XY at all - functionally full-width radial engagement spinning
// straight down, exactly the loaded-plunge risk ENTRY SAFETY exists to
// prevent, just relabeled as G02/G03 instead of G01. Below this threshold
// there isn't enough real clearance for helixing to mean anything - reject
// with the same actionable-error pattern offsetPolygon already uses for
// "tool doesn't fit at all," pointing at the same fix (a smaller tool, via
// a multi-tool sequence) rather than silently emitting something unsafe.
const MIN_HELIX_RADIUS_FRACTION = 0.15;

// Max Z drop per unit of XY travel during a ramped/helical entry (rise/run,
// not degrees) - conservative on purpose. Too steep and a "ramp" is just a
// disguised plunge again; this caps it well short of that regardless of
// stepDown/tool size. MIN_HELIX_TURNS keeps a helical entry gentle even
// when MAX_RAMP_SLOPE alone would allow a single fast turn for a shallow pass.
const MAX_RAMP_SLOPE = 0.15;
const MIN_HELIX_TURNS = 2;

// The last bit of the approach to Z0 (the programmed top-of-stock surface)
// is a FEED-rate move, not a rapid - standard defense-in-depth practice,
// not a response to a specific known problem here: Z0 is only ever as
// accurate as the operator's real-world touch-off and the actual stock's
// true thickness/flatness, neither of which this generator has any way to
// verify. Rapiding all the way to the programmed surface trusts both of
// those completely; stopping short and feeding the rest of the way means
// first contact happens at a controlled, slow speed instead of full rapid
// if either is off by a little. Doesn't fix a bug - Z0.0000 was already
// AT the surface, not into material, under a correctly-zeroed setup - it's
// a cheap way to reduce how bad it is if that assumption turns out wrong.
const APPROACH_CLEARANCE = 0.02;

// EDGE MARGIN - real shop constraint, not a geometry nicety: work zero
// (X0 Y0) is set at a corner/edge of the raw stock, and the stock itself is
// held down with nails/fasteners near that same edge. STEP-extracted part
// geometry has no idea any of that exists - a part modeled right up against
// its own local origin, once cut, can put the tool within a hair of X0/Y0 -
// exactly where the hold-down hardware physically is. Real event: a
// generated file's outer contour reached X-0.0788", a fraction of an inch
// past zero, on a machine that zeros (and nails down) at the stock edge.
// 0.5" is a conservative starting clearance, not a measured/calibrated
// value for any specific hold-down pattern - real enough to clear a
// typical nail/screw head with margin, adjustable per job via
// params.edgeMargin (0 restores the old zero-offset behavior).
// How far past the underside of the stock a through-cut is allowed to
// reach. Enough to guarantee the part actually separates (and to absorb a
// slightly out-of-flat sheet) without burying the cutter in the spoilboard.
// Exported (not just used here) so the UI can derive the same "through this
// stock" depth the generator itself will accept, instead of a duplicated
// copy of this number drifting out of sync in two other places.
export const THROUGH_CUT_ALLOWANCE = 0.02;

// How far the CAD model's measured thickness may differ from the selected
// stock before the header calls it out. Generous on purpose: nominal sheet
// sizes are routinely off (1/4" birch ply often measures ~0.22").
const STOCK_THICKNESS_TOLERANCE = 0.03;

const DEFAULT_EDGE_MARGIN = 0.5;

// Real bug, found from an actual generated file: a roughing loop written as
// `while (depth < targetDepth) { depth = Math.min(depth + stepDown,
// targetDepth); ... }` looks like it always lands exactly on targetDepth
// once it gets there, and normally does - EXCEPT when stepDown doesn't
// divide evenly into targetDepth (the overwhelmingly common case for real,
// user-entered values, not a corner case), accumulated floating-point error
// can leave `depth` a hair below targetDepth even after the "last" step
// (e.g. 0.09999999999999999 instead of 0.1) - `depth < targetDepth` is then
// still true, so the loop runs one MORE time, clamps to targetDepth for
// real this time, and emits a second pass at what prints as the identical
// depth (fmt() rounds both to the same 4 decimals) - a fully redundant
// extra pass on every single contour. Same fix pattern already used by
// emitContourPass's own isFinalPass check: compare with a small epsilon
// instead of exact floating-point equality.
const DEPTH_EPSILON = 1e-6;

// Walks the path emitting G01 moves, ramping Z linearly from `prevDepth` to
// `passDepth` over the first `rampDistance` of travel instead of arriving at
// this pass already at full depth (see file header "ENTRY SAFETY") - except
// inside a tab zone (outer contour, final pass only), where depth is
// clamped so tabHeight of material is left uncut regardless of ramp state.
// The ramped portion runs at `plungeRate` (a deliberately cautious rate for
// axial engagement), the rest at the normal cutting `feedRate`.
//
// SEGMENTS ARE SPLIT AT TAB-ZONE BOUNDARIES - real bug this fixes: an
// earlier version tested "does this SEGMENT's midpoint fall in a zone,"
// which silently drops a zone whenever it falls inside a segment much
// longer than the zone itself (the zone's own span doesn't reach the
// segment's midpoint) - found on a real 20"-perimeter motor mounting plate
// with long straight edges, where 2 of 3 intended tabs vanished entirely
// with no error. Splitting each segment at every overlapping zone's start/
// end means a sub-move's own midpoint is always either fully inside or
// fully outside a zone (never straddling one), so the same midpoint check
// is correct again - and only the zone's actual width ends up at tab
// depth, not the whole original segment.
function emitContourPass(lines, path, prevDepth, passDepth, targetDepth, tabZones, tabHeight, feedRate, plungeRate, rampDistance) {
  const isFinalPass = passDepth >= targetDepth - 1e-9;
  // Tracks tab entry so the note above is emitted once per tab rather than
  // once per sub-move inside it.
  let wasInTab = false;
  const n = path.length; // path is closed: path[0] === path[n-1]
  const tabCutDepth = Math.max(0, targetDepth - tabHeight);

  // Depth at absolute path-distance `d`, ramped from prevDepth to passDepth
  // - same formula as before, just pulled out so it can be evaluated at an
  // arbitrary split point, not only a segment's endpoint.
  function rampedDepthAt(d) {
    const rampT = rampDistance > 0 ? Math.min(1, d / rampDistance) : 1;
    return prevDepth + (passDepth - prevDepth) * rampT;
  }

  let dist = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const segStart = dist;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const segEnd = segStart + segLen;
    // Corner slowdown - see cornerFeedScale's doc comment. `b`'s neighbors
    // are `a` (already have it) and whatever comes after `b`, wrapping to
    // path[1] (not path[0], which duplicates path[n-1]) at the seam. Only
    // ever applies to the sub-move that actually lands ON `b` below - a
    // synthetic zone-boundary point partway along this segment isn't a real
    // corner.
    const nextIdx = i === n - 1 ? 1 : i + 1;
    const cornerScale = cornerFeedScale(a, b, path[nextIdx]);

    const overlappingZones = isFinalPass
      ? tabZones.filter(([s, e]) => e > segStart + 1e-9 && s < segEnd - 1e-9)
      : [];
    // Every point within this segment where the cut depth could change:
    // each overlapping zone's start/end (clamped to the segment's own
    // span), plus the segment's own end. De-duped and sorted so a segment
    // with no zone touching it - the overwhelming common case - collapses
    // back to exactly one G01 move, identical to the pre-fix output.
    const cutpoints = [...new Set([...overlappingZones.flatMap(([s, e]) => [Math.max(s, segStart), Math.min(e, segEnd)]), segEnd])]
      .filter((d) => d > dist + 1e-9)
      .sort((p, q) => p - q);

    for (const cutDist of cutpoints) {
      const atVertexB = cutDist >= segEnd - 1e-9;
      const point = atVertexB ? b : { x: a.x + (b.x - a.x) * ((cutDist - segStart) / segLen), y: a.y + (b.y - a.y) * ((cutDist - segStart) / segLen) };
      const midOfSubMove = (dist + cutDist) / 2;
      const inTab = overlappingZones.some(([s, e]) => midOfSubMove >= s - 1e-9 && midOfSubMove <= e + 1e-9);
      const cutDepth = inTab ? tabCutDepth : rampedDepthAt(cutDist);
      const inRamp = rampDistance > 0 && dist < rampDistance;
      const feed = (inRamp ? plungeRate : feedRate) * (atVertexB ? cornerScale : 1);
      // Say where the part is held. Everything else in this program is
      // commented for whoever is at the machine; the tabs - the only thing
      // stopping the part lifting mid-cut - were not, so they could not be
      // located by reading the file or checked against the material.
      if (inTab && !wasInTab) {
        lines.push(tabZones.onCurves
          ? `(-- tab: holding ${fmt(tabHeight, 3)}" here - ON A CURVED EDGE, this profile has no flat long enough for a tab; expect a rougher break-out --)`
          : `(-- tab: holding ${fmt(tabHeight, 3)}" of material here --)`);
      }
      // Closing marker so a reader - the 3D sim included - can tell where
      // the tab ends, not just where it starts.
      if (!inTab && wasInTab) lines.push('(-- end tab --)');
      wasInTab = inTab;
      lines.push(`G01 X${fmt(point.x)} Y${fmt(point.y)} Z${fmt(-cutDepth)} F${fmt(feed, 5)}`);
      dist = cutDist;
    }
  }
  if (wasInTab) lines.push('(-- end tab --)');
}

// Cuts a genuinely circular contour (see fitCircle) with true G02/G03
// helical entry + circular interpolation instead of a many-sided polygon -
// see file header. Arc direction (G02 vs G03) matches whichever way `path`
// already winds (via signedArea, the same helper ensureCCW uses), so this
// is never a new, separately-invented direction choice - just an arc
// replacing the equivalent G01 segments that would have gone the same way.
function emitHelicalCircularContour(lines, contour, path, circle, toolParams, safeZ) {
  const { stepDown, targetDepth, feedRate, plungeRate } = toolParams;
  const { cx, cy, radius } = circle;
  const arcCmd = signedArea(path) > 0 ? 'G03' : 'G02';
  const startX = cx + radius, startY = cy; // angle-0 start point - arbitrary but fixed, so every pass/turn returns to the same X/Y for a true full-circle move
  const i = fmt(cx - startX), j = fmt(cy - startY); // I/J are relative to the arc's start point, per standard G02/G03 convention

  lines.push(`(--- ${contour.isHole ? 'HOLE' : 'CIRCULAR BOSS'} - true circle (center ${fmt(cx, 3)},${fmt(cy, 3)} radius ${fmt(radius, 3)}") - helical entry + arc cut ---)`);
  lines.push(`G00 X${fmt(startX)} Y${fmt(startY)} (rapid to start)`);
  lines.push(`G00 Z${fmt(APPROACH_CLEARANCE)} (rapid to just above material surface)`);
  lines.push(`G01 Z0.0000 F${fmt(plungeRate, 5)} (feed down to material surface - not a rapid, in case Z0/stock height is slightly off)`);

  let depth = 0;
  while (depth < targetDepth - DEPTH_EPSILON) {
    const prevDepth = depth;
    depth = Math.min(depth + stepDown, targetDepth);
    const zDrop = depth - prevDepth;
    const turns = Math.max(MIN_HELIX_TURNS, Math.ceil(zDrop / Math.max(1e-6, radius * MAX_RAMP_SLOPE)));
    const dropPerTurn = zDrop / turns;
    lines.push(`(-- pass at Z-${fmt(depth)}, helical entry over ${turns} turn${turns === 1 ? '' : 's'} --)`);
    let z = prevDepth;
    for (let t = 0; t < turns; t += 1) {
      z += dropPerTurn;
      lines.push(`${arcCmd} X${fmt(startX)} Y${fmt(startY)} I${i} J${j} Z${fmt(-z)} F${fmt(plungeRate, 5)}`);
    }
    // One more full circle at final depth to clean up the helical seam -
    // uniform depth all the way around instead of a slight step where the
    // helix met itself.
    lines.push(`${arcCmd} X${fmt(startX)} Y${fmt(startY)} I${i} J${j} Z${fmt(-depth)} F${fmt(feedRate, 5)}`);
  }
  lines.push(`G00 Z${fmt(safeZ)} (retract)`);
  return { perimeter: 2 * Math.PI * radius, tabZoneCount: 0 };
}

// Offsets a HOLE contour inward by toolRadius and validates the result is
// actually safe to cut, not just non-collapsed: offsetPolygon alone only
// catches "this tool doesn't fit at all" (the offset collapses/inverts). A
// circular hole can still pass that check while leaving only a sliver of
// helical-entry clearance - see MIN_HELIX_RADIUS_FRACTION's doc comment for
// the real bug this catches. Shared by cutContour (the real cut) and
// assignContoursToTools (multi-tool "does this tool fit" probing) so a tool
// multi-tool mode accepts is always one cutContour can actually cut safely,
// not just one that produces some offset.
function checkHoleFits(points, toolRadius) {
  const path = offsetPolygon(points, -toolRadius);
  const circle = fitCircle(path);
  if (circle.maxDeviation <= CIRCLE_FIT_TOLERANCE && circle.radius < toolRadius * MIN_HELIX_RADIUS_FRACTION) {
    throw new Error(
      `Hole too close to this tool's diameter for a safe helical entry: only ${circle.radius.toFixed(4)}" of ` +
      `toolpath clearance for a ${(toolRadius * 2).toFixed(3)}" tool (needs at least ${(toolRadius * MIN_HELIX_RADIUS_FRACTION).toFixed(4)}") - ` +
      `use a smaller tool for this hole (a multi-tool sequence falls through to one automatically) or drop this hole`
    );
  }
  return path;
}

// Cuts one contour (all step-down passes + tabs) with one tool's params.
// Shared by both the single-tool and multi-tool code paths.
function cutContour(lines, contour, toolRadius, toolParams, safeZ) {
  const { stepDown, targetDepth, tabWidth, tabHeight, tabSpacing, tabCount, feedRate, plungeRate } = toolParams;
  const path = contour.isHole ? checkHoleFits(contour.points, toolRadius) : offsetPolygon(contour.points, toolRadius);
  const perimeter = pathLength(path);
  // Tabs only ever apply to the OUTER contour - a hole isn't a piece that
  // needs holding in place, it's material being removed, and leaving
  // tab-height webs inside a hole means it never actually cuts through.
  // (This is the real bug fixed here: the old unconditional tabZones
  // computation applied to every contour including holes, and
  // buildTabZones always emits at least one zone no matter how small the
  // contour is relative to tabWidth/tabSpacing - so a small hole's final
  // pass could spend most of its perimeter clamped to targetDepth-tabHeight
  // instead of cutting a clean through-hole.)
  // targetDepth doubles as the thickness hint here - for a single-tool
  // through-cut routing job (the only kind that gets tabs at all - see
  // above), the outer profile's cut depth IS the material thickness.
  const tabZones = (!contour.isHole && (tabSpacing > 0 || tabCount > 0)) ? buildTabZones(path, perimeter, tabWidth, tabSpacing, targetDepth, tabCount) : [];

  const circle = fitCircle(path);
  const isCircular = circle.maxDeviation <= CIRCLE_FIT_TOLERANCE;
  if (isCircular && (contour.isHole || tabZones.length === 0)) {
    return emitHelicalCircularContour(lines, contour, path, circle, toolParams, safeZ);
  }

  lines.push(`(--- ${contour.isHole ? 'HOLE' : 'OUTER'} CONTOUR, perimeter ~${fmt(perimeter, 2)}" ---)`);
  lines.push(`G00 X${fmt(path[0].x)} Y${fmt(path[0].y)} (rapid to start)`);
  lines.push(`G00 Z${fmt(APPROACH_CLEARANCE)} (rapid to just above material surface)`);
  lines.push(`G01 Z0.0000 F${fmt(plungeRate, 5)} (feed down to material surface - not a rapid, in case Z0/stock height is slightly off)`);

  let depth = 0;
  while (depth < targetDepth - DEPTH_EPSILON) {
    const prevDepth = depth;
    depth = Math.min(depth + stepDown, targetDepth);
    const rampDistance = Math.min(perimeter * 0.5, (depth - prevDepth) / MAX_RAMP_SLOPE);
    lines.push(`(-- pass at Z-${fmt(depth)}, ramped entry over ${fmt(rampDistance, 2)}" --)`);
    emitContourPass(lines, path, prevDepth, depth, targetDepth, tabZones, tabHeight, feedRate, plungeRate, rampDistance);
  }
  lines.push(`G00 Z${fmt(safeZ)} (retract)`);
  return { perimeter, tabZoneCount: tabZones.length };
}

// 50% of tool diameter - a conservative, common roughing stepover for
// pocket clearing. A real per-material/per-tool tuning value belongs in
// job params eventually (same as feedRate/plungeRate today); hardcoded for
// this first pocket-clearing pass rather than adding an unused knob no UI
// sets yet.
const POCKET_STEPOVER_FRACTION = 0.5;

// Concentric inward offsets of `wallPath` (itself already the tool-center
// path around the pocket's true floor boundary - see clearPocket), each
// `stepover` closer to the center, until offsetPolygon collapses (throws -
// same collapse detection checkHoleFits/assignContoursToTools already rely
// on). rings[0] is the outermost (the wall itself); the last entry is
// whatever's left nearest the center.
function buildOffsetRings(wallPath, stepover) {
  const rings = [wallPath];
  let current = wallPath;
  for (;;) {
    let next;
    try {
      next = offsetPolygon(current, -stepover);
    } catch {
      break; // no more room for another ring - the rest is cleared by the innermost ring's own tool diameter
    }
    rings.push(next);
    current = next;
  }
  return rings;
}

// Clears the interior of a pocket floor down to `pocket.depth`, leaving the
// true wall boundary for last. Real 2.5D pocket clearing (FRC AutoCAM
// milling "Option A" - see implementations/millimplementations.md): the
// pocket boundary offset inward by tool radius (offsetPolygon, same
// convention as a HOLE - the tool stays inside the true wall so its edge
// touches it) is repeatedly re-offset inward by a stepover to build a set
// of concentric rings (buildOffsetRings). Cut order per Z level is
// INNERMOST ring first, wall ring LAST - by the time the tool reaches the
// full-size wall ring, everything inside it is already open air, so that
// pass is a normal single-stepover-width cut instead of one still carrying
// the whole pocket's interior load.
//
// Reuses emitContourPass for each ring's actual cut - the same linear
// Z-ramp used for the outer/hole contours in cutContour, which is what
// keeps this ENTRY-SAFE (see file header): a pocket has no existing open
// edge to enter from the way an outer profile's perimeter sometimes does,
// so every single ring, at every Z level, ramps into depth while traveling
// its own path instead of plunging straight down at a fixed XY point.
// tabZones is always [] here - tabs are a final-outer-profile workholding
// concept (see buildTabZones), not applicable to an interior pocket floor.
//
// KNOWN LIMITATION: no islands (a boss standing up inside a pocket) - each
// pocket is treated as one simply-connected floor. Matches
// millimplementations.md's "Option A: simplest, buildable" scope; revisit
// if a real part needs one.
function clearPocket(lines, pocket, toolRadius, params, safeZ) {
  const { stepDown, feedRate, plungeRate } = params;
  const wallPath = offsetPolygon(pocket.points, -toolRadius);
  const rings = buildOffsetRings(wallPath, toolRadius * 2 * POCKET_STEPOVER_FRACTION);

  lines.push(`(--- POCKET, floor depth ${fmt(pocket.depth)}", ${rings.length} clearing ring${rings.length === 1 ? '' : 's'} ---)`);

  let depth = 0;
  while (depth < pocket.depth - DEPTH_EPSILON) {
    const prevDepth = depth;
    depth = Math.min(depth + stepDown, pocket.depth);
    lines.push(`(-- pocket pass at Z-${fmt(depth)} --)`);
    for (let i = rings.length - 1; i >= 0; i -= 1) {
      const ring = rings[i];
      const ringNumber = rings.length - i; // 1 = innermost (cut first), rings.length = the wall (cut last)
      lines.push(`G00 X${fmt(ring[0].x)} Y${fmt(ring[0].y)} (rapid to ring ${ringNumber}/${rings.length} start)`);
      lines.push(`G00 Z${fmt(APPROACH_CLEARANCE)} (rapid to just above material surface)`);
      lines.push(`G01 Z${fmt(-prevDepth)} F${fmt(plungeRate, 5)} (feed down to this level's starting depth - already-cleared air below the first Z level)`);
      const rampDistance = Math.min(pathLength(ring) * 0.5, (depth - prevDepth) / MAX_RAMP_SLOPE);
      emitContourPass(lines, ring, prevDepth, depth, pocket.depth, [], 0, feedRate, plungeRate, rampDistance);
      lines.push(`G00 Z${fmt(safeZ)} (retract clear before next ring)`);
    }
  }
  return { ringCount: rings.length };
}

// Conservative fallback for unknown stock. A selected cam_material supplies
// stock-specific values; these Aluminum-like numbers mirror the shop's real
// 0.1575" carbide 971 Main Bit Fusion preset, rather than a generic chart.
const TOOL_STEP_DEFAULTS = { stepDown: 0.03, tabWidth: 0.25, tabHeight: 0.06, tabSpacing: 6, feedRate: 80, plungeRate: 13.333, spindleSpeed: 22000 };

// Neither params.feedRate nor params.plungeRate had any validation before
// this - a typo'd 0, a negative sign, or a stray extra digit (8 -> 800)
// went straight into an F-word on a full-engagement axial move with no
// error. Checked against the shop's real Fusion-cammed output
// (autocam/postprocessors/__fixtures__/1001-fusion-example.ngc, run
// through 971_emc.cps): every ramped/helical-entry move there uses a
// slower feed (13.333-60 in/min) than its own full-speed XY passes (80
// in/min) - plunge/ramp is never commanded faster than the cutting feed
// on a real program from this shop, which is the one constraint enforced
// here rather than picking an arbitrary ceiling.
function requireSafePlungeAndFeed(feedRate, plungeRate, label = '') {
  const prefix = label ? `${label}: ` : '';
  if (!Number.isFinite(feedRate) || feedRate <= 0) throw new Error(`${prefix}feedRate must be a positive number`);
  if (!Number.isFinite(plungeRate) || plungeRate <= 0) throw new Error(`${prefix}plungeRate must be a positive number`);
  if (plungeRate > feedRate) {
    throw new Error(`${prefix}plungeRate (${plungeRate} in/min) cannot exceed feedRate (${feedRate} in/min) - a plunge/ramp move has full axial engagement and should never be commanded faster than the cutting pass`);
  }
}

/**
 * For each contour, finds the first (in given order) tool whose radius
 * actually fits - i.e. offsetPolygon doesn't throw the "too small" error.
 * Sequence should be ordered primary/largest tool first, detail/smallest
 * tools after, so a contour only falls through to a smaller tool when the
 * bigger one genuinely can't reach it (e.g. a hole narrower than its bit).
 * Throws if no tool in the sequence fits a given contour.
 */
function assignContoursToTools(contours, toolSequence) {
  const assignments = []; // [{ contour, toolIndex }]
  for (const contour of contours) {
    let assigned = -1;
    for (let i = 0; i < toolSequence.length; i += 1) {
      const radius = toolSequence[i].toolDiameter / 2;
      if (!contour.isHole) { assigned = i; break; } // outer contour always fits the first tool that reaches it geometrically; only holes can be "too small"
      try {
        checkHoleFits(contour.points, radius);
        assigned = i;
        break;
      } catch {
        continue; // this tool doesn't fit (or doesn't leave safe helical clearance) - try the next (smaller) one
      }
    }
    if (assigned === -1) {
      const diameters = toolSequence.map((t) => `${t.toolDiameter}"`).join(', ');
      throw new Error(`No tool in the sequence (${diameters}) fits one of this part's holes - add a smaller tool or drop that hole`);
    }
    assignments.push({ contour, toolIndex: assigned });
  }
  return assignments;
}

// TOOL CHANGE / program-pause line, dialect-aware: LinuxCNC gets the
// standard M00; WinCNC gets a bare G4 (dwell-until-ENTER), which is the
// documented WinCNC mechanism and supports the same bracketed prompt - see
// file header comment for why M00 isn't used for 'wincnc'.
// SPINDLE SPIN-UP DWELL - real bug this fixes: every M03 (spindle on) was
// immediately followed by cutting/positioning moves with no wait at all,
// trusting the spindle to already be at speed. A real spindle/VFD takes a
// real, non-zero time to accelerate from stopped to its commanded RPM
// (commonly a couple of seconds for router-class spindles) - engaging the
// cut before that finishes is a genuine stall/broken-tool risk, not a
// theoretical one. G04 is a real dwell command, universally supported, but
// which WORD carries the duration is dialect-specific and NOT the same
// letter as LinuxCNC's - confirmed against WinCNC's own manual (not
// assumed, same standard as every other WinCNC quirk in this file):
// LinuxCNC/Fanuc-style uses G04 P<seconds>; WinCNC uses G04 X<seconds> (P
// isn't the duration argument there at all - see WinCNC's HD Series manual,
// "Dwell - G4 X# ... stops movement for the time specified by the X value
// in seconds"). Getting this backwards on a WinCNC machine wouldn't dwell
// at all - it would likely be parsed as an unrecognized/no-op argument.
/**
 * @param {Array<{points: Array<{x,y}>, isHole: boolean}>} contours
 * @param {Object} params
 *   Single-tool mode (unchanged, backward compatible):
 *     toolDiameter (required, inches), stepDown (default 0.03), targetDepth (required)
 *     tabWidth (default 0.25), tabHeight (default 0.06), tabSpacing (default 6, inches; 0 = no tabs)
 *     feedRate (in/min, default 80), plungeRate (in/min, default 13.333), spindleSpeed (rpm, default 22000)
 *   Multi-tool mode: params.toolSequence = [{ toolDiameter, toolNumber, label,
 *     stepDown, tabWidth, tabHeight, tabSpacing, feedRate, plungeRate, spindleSpeed }, ...],
 *     primary/largest tool first. targetDepth still comes from the top-level
 *     params (shared - it's the material thickness, not a per-tool choice).
 *   Both modes: targetDepth (required), safeZ (default 0.25), units: 'in' | 'mm' (default 'in')
 *     controller: 'linuxcnc' (default) | 'wincnc' - see file header comment
 *     for the real dialect differences this switches between.
 *     spindleDwellSeconds (default 2) - pause after every M03 (initial
 *     spindle start and every mid-program tool-change restart) to let the
 *     spindle actually reach commanded RPM before the first cutting move -
 *     see dwellLine's doc comment.
 *   Single-tool mode only: params.pockets = [{ points: Array<{x,y}>, depth }, ...]
 *     - interior floor features (see clearPocket) cleared with the same
 *     tool, same coordinate space as `contours`, BEFORE any contour is cut
 *     (same "internal features before the outer profile" safety rule this
 *     file already applies to holes - see CUT ORDER in the file header).
 *     Real 2.5D milling ("Option A" - implementations/millimplementations.md):
 *     the outer profile still comes from `contours` exactly as today: this
 *     only adds pocket floors at a shallower depth than the through-cut.
 *   edgeMargin (default 0.5") - shifts the entire toolpath (every contour
 *     and pocket) so the closest any cutting move gets to X0/Y0 is this
 *     far - see DEFAULT_EDGE_MARGIN's doc comment: work zero is set, and
 *     stock is nailed down, right at that same X0/Y0 corner on a real
 *     machine. Set to 0 to cut the geometry exactly as extracted, with no
 *     shift (the old, pre-this-option behavior). The actual shift applied
 *     is returned as stats.edgeShiftX/edgeShiftY (0 if edgeMargin is 0, or
 *     if the geometry already cleared the margin on its own) - any
 *     consumer working from the original extracted contour/mesh
 *     coordinates (the 3D sim's ghost-part overlay) needs this to land in
 *     the same place as the actual toolpath.
 */
export function generateRoutingGcode(contours, params = {}) {
  if (!Array.isArray(contours) || contours.length === 0) {
    throw new Error('Routing needs at least one closed contour');
  }
  const { targetDepth, safeZ = 0.25, units = 'in', controller = 'linuxcnc', spindleDwellSeconds = 2, edgeMargin = DEFAULT_EDGE_MARGIN } = params;
  if (!targetDepth || targetDepth <= 0) throw new Error('targetDepth is required and must be > 0');
  if (edgeMargin < 0) throw new Error('edgeMargin cannot be negative');

  // Real-stock depth check. stockThickness is the operator's pick from this
  // team's stock catalog (CamParamFields' routing "Stock" select, resolved
  // to a thickness by the caller); measuredThickness is what the STEP model
  // itself measures.
  //
  // Cutting deeper than the material that is actually on the table does not
  // produce a worse part - it drives the cutter through the workpiece and
  // into the spoilboard or the machine bed at full depth. That is a hard
  // refusal, not a warning: there is no reading of it that is correct.
  //
  // A model/stock thickness DISAGREEMENT is different - nominal sheet sizes
  // legitimately differ from actual (1/4" birch ply routinely measures
  // ~0.22"), and a pocket is meant to be shallower than its stock - so that
  // one is called out in the header for the operator to judge, not blocked.
  const { stockThickness, measuredThickness } = params;
  if (stockThickness > 0 && targetDepth > stockThickness + THROUGH_CUT_ALLOWANCE + DEPTH_EPSILON) {
    throw new Error(
      `Cut depth ${fmt(targetDepth, 3)}" is deeper than the selected stock (${fmt(stockThickness, 3)}" ` +
      `plus a ${fmt(THROUGH_CUT_ALLOWANCE, 3)}" break-through allowance) - this would cut into the spoilboard. ` +
      'Re-check the stock selection or the target depth before running this on material.'
    );
  }
  const isWinCNC = controller === 'wincnc';
  const hasSequence = Array.isArray(params.toolSequence) && params.toolSequence.length > 0;
  let pockets = Array.isArray(params.pockets) ? params.pockets : [];

  // Recorded (in stats, below) so a consumer working from the *original*
  // extracted contour coordinates - the 3D sim's ghost-part overlay
  // (ToolpathSimulator.svelte/stepProfile.js's transformMeshesForRouting
  // Scene, which has no reason to know this generator silently repositions
  // everything) - can apply the identical shift and actually land on top
  // of the real toolpath instead of sitting off to the side. Real bug this
  // fixes: the ghost part rendered in the pre-shift coordinate frame while
  // the simulated stock (built from the parsed G-code, which IS shifted)
  // did not - visibly misaligned for any part not already touching X0/Y0.
  let edgeShiftX = 0;
  let edgeShiftY = 0;

  // Shift every contour and pocket so nothing cuts closer to X0/Y0 than
  // edgeMargin (plus the tool's own outward reach, so the CUTTING PATH -
  // not just the raw geometry - actually respects the margin). Uses the
  // largest tool in play (multi-tool: the biggest diameter in the
  // sequence) since that tool's reach sets the real worst case regardless
  // of which one ends up cutting near a given corner.
  if (edgeMargin > 0) {
    const toolRadiusForMargin = (hasSequence
      ? Math.max(...params.toolSequence.map((t) => t.toolDiameter || 0))
      : (params.toolDiameter || 0)) / 2;
    let minX = Infinity, minY = Infinity;
    for (const c of contours) for (const p of c.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
    for (const pocket of pockets) for (const p of pocket.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
    if (Number.isFinite(minX) && Number.isFinite(minY)) {
      const required = edgeMargin + toolRadiusForMargin;
      const shiftX = required - minX;
      const shiftY = required - minY;
      if (shiftX !== 0 || shiftY !== 0) {
        const shiftPoints = (points) => points.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }));
        contours = contours.map((c) => ({ ...c, points: shiftPoints(c.points) }));
        pockets = pockets.map((pocket) => ({ ...pocket, points: shiftPoints(pocket.points) }));
        edgeShiftX = shiftX;
        edgeShiftY = shiftY;
      }
    }
  }

  const lines = [...HEADER_WARNING, ''];
  if (isWinCNC) {
    lines.push(units === 'mm' ? 'G22 (metric - mm; NOTE: G21 means cm on WinCNC, G22 is used for mm here)' : 'G20 (inch)');
  } else {
    lines.push(units === 'mm' ? 'G21 (metric)' : 'G20 (inch)');
  }
  lines.push('G90 (absolute)');
  if (!isWinCNC) lines.push('G17 (XY plane)'); // not a documented WinCNC code - omitted rather than risking an abort on an unrecognized G-code
  lines.push('G94 (feed per minute)');
  if (isWinCNC) {
    // G54 IS a standard stored work offset on this shop's actual WinCNC
    // machine (a ShopSabre) - confirmed against the machine's own real
    // Autodesk-authored post-processor (shopsabre.cps, see
    // autocam/postprocessors/), which selects G54-G59 by section work
    // offset exactly like a LinuxCNC/Fanuc control does. The earlier
    // "WinCNC has no G54-style stored offset, jog and G92 instead" guidance
    // here was wrong - it came from WinCNC's generic base manual, not this
    // specific machine's real setup, and it meant this app's own files used
    // a different (more manual, error-prone) work-offset workflow than
    // every Fusion-cammed job on the same router already does.
    lines.push('G54 (work offset - verify before running)');
  } else {
    lines.push('G54 (work offset - verify before running)');
    // Defensive only - this program never activates a canned cycle, cutter
    // compensation, or a tool length offset, so these cancels are a no-op
    // for anything IT does. The real reason to still emit them: a shared
    // shop router runs more than just this app's output over its lifetime,
    // and a DIFFERENT prior program leaving one of these modes active is a
    // real, documented cause of a next program misbehaving - cheap
    // insurance against inherited state this program doesn't control.
    // LinuxCNC only - not added for WinCNC, since (like G17 and M30
    // elsewhere in this file) these aren't confirmed against WinCNC's own
    // manual and this file only emits WinCNC codes it has actually verified.
    lines.push('G80 G40 G49 (cancel canned cycle / cutter comp / tool length offset - defensive, in case a prior program on this machine left one active)');
  }
  if (edgeMargin > 0) {
    lines.push(`(Part positioned ${fmt(edgeMargin, 2)}" clear of X0/Y0 - keep clamps/nails/fasteners outside that boundary)`);
  }
  // Which corner work zero is, and which way the axes run from it. The
  // generator already shifts every contour into the +X/+Y quadrant (see
  // edgeShiftX/edgeShiftY above), so both axes point from the origin corner
  // INTO the part - but nothing said so, and an operator zeroing on the
  // wrong corner mirrors the whole job without any of it looking wrong
  // until the cut is already in the material.
  lines.push('(WORK ZERO: the corner of the stock nearest you on the left - set X0 Y0 there.)');
  lines.push('(+X runs to the right and +Y runs away from you, both INTO the part,)');
  lines.push('(so every coordinate in this file is positive. If a move goes negative, the)');
  lines.push('(wrong corner was zeroed - stop and re-zero rather than running it.)');
  // See src/routes/api/cam-generate: set when the selected material has no
  // verified feeds/speeds for this operation, so the numbers below are the
  // generator's generic fallback rather than anything measured for it.
  if (params.materialFeedsUnverified) {
    lines.push('(*** FEEDS AND SPEEDS ARE NOT VERIFIED FOR THIS MATERIAL ***)');
    lines.push(`(No feeds/speeds are on record for ${params.materialName || 'the selected material'} in routering, so the)`);
    lines.push('(generic defaults were used - they are tuned for aluminum. Check feed rate, step-down)');
    lines.push('(and spindle speed against this material before running.)');
  }
  // State the stock this program was built for, so the operator can check
  // what is on the table against what the depths below assume.
  if (stockThickness > 0) {
    lines.push(`(Stock: ${fmt(stockThickness, 3)}" thick - cutting to ${fmt(targetDepth, 3)}")`);
    // Nominal sheet sizes legitimately differ from actual, and a pocket is
    // meant to be shallower than its stock, so a disagreement is surfaced
    // for the operator to judge rather than blocked.
    if (measuredThickness > 0 && Math.abs(measuredThickness - stockThickness) > STOCK_THICKNESS_TOLERANCE) {
      lines.push('(*** CHECK STOCK: the CAD model and the selected stock disagree on thickness ***)');
      lines.push(`(Model measures ${fmt(measuredThickness, 3)}" but the selected stock is ${fmt(stockThickness, 3)}" -)`);
      lines.push('(fine for a pocket or a nominal-vs-actual sheet size, wrong if this was meant to cut through.)');
    }
  }

  let gcode;
  let stats;

  if (!hasSequence) {
    // Single-tool path, unchanged from before multi-tool support existed.
    const { toolDiameter, stepDown = 0.03, tabWidth = 0.25, tabHeight = 0.06, tabSpacing = 6, tabCount = 0, feedRate = 80, plungeRate = 13.333, spindleSpeed = 22000 } = params;
    if (!toolDiameter || toolDiameter <= 0) throw new Error('toolDiameter is required and must be > 0');
    requireSafePlungeAndFeed(feedRate, plungeRate);
    // No T-code / M06 here on purpose - these routers have no automatic
    // tool changer (see toolchange-gcode-plan.md: tool changes are
    // operator-driven, an M00 pause with a load prompt, not automatic -
    // multi-tool mode below already does exactly that between tool steps).
    // A single-tool program has no change to prompt for, but was missing
    // even a plain statement of what to load before pressing start at all -
    // real gap, matching the "load before starting" comment multi-tool mode
    // already gets. Every offset/fit calculation in this file already
    // assumes this exact diameter; loading a different one silently throws
    // off every dimension in the part, not just a tolerance nuance.
    lines.push(`(--- TOOL: ${fmt(toolDiameter, 3)}" diameter - load before starting ---)`);
    lines.push(`S${spindleSpeed} M03 (spindle on)`);
    if (spindleDwellSeconds > 0) lines.push(dwellLine(isWinCNC, spindleDwellSeconds, 'wait for spindle to reach speed'));
    lines.push(`G00 Z${fmt(safeZ)} (safe height)`);

    // Pockets clear first - same "internal features before the outer
    // profile" reasoning as the hole-before-outer ordering just below, one
    // step earlier: a pocket floor is an interior feature too, and cutting
    // it after the outer profile is through risks doing so on a part that's
    // no longer solidly attached to the stock.
    // (pockets here is the already-edge-margin-shifted array from above,
    // not a fresh read of params.pockets.)
    let totalPocketRings = 0;
    for (const pocket of pockets) {
      const { ringCount } = clearPocket(lines, pocket, toolDiameter / 2, { stepDown, feedRate, plungeRate }, safeZ);
      totalPocketRings += ringCount;
    }

    // Real CAM safety practice: internal features (holes/pockets) must be
    // fully machined BEFORE the final outer-profile cut, not after. Once the
    // outer boundary is cut through, the part is only still connected to the
    // surrounding stock via tabs (if any) or clamping - continuing to
    // machine anything else after that risks the part shifting, vibrating,
    // or coming loose mid-operation. `contours` arrives outer-first (largest
    // area, from extractRoutingContoursFromMeshes), so cut holes first here
    // regardless of that original order.
    const orderedContours = [...contours].sort((a, b) => Number(b.isHole) - Number(a.isHole));
    let totalTabZones = 0;
    for (const contour of orderedContours) {
      const { tabZoneCount } = cutContour(lines, contour, toolDiameter / 2, { stepDown, targetDepth, tabWidth, tabHeight, tabSpacing, tabCount, feedRate, plungeRate }, safeZ);
      totalTabZones += tabZoneCount;
    }
    lines.push('M05 (spindle off)');
    lines.push(isWinCNC ? '(PROGRAM END)' : 'M30 (program end)'); // M30 is not a documented WinCNC code - omitted rather than guessed
    gcode = lines.join('\n');
    stats = { contours: contours.length, tabZones: totalTabZones, pockets: pockets.length, pocketRings: totalPocketRings, targetDepth, toolChanges: 0, edgeShiftX, edgeShiftY };
  } else {
    // Multi-tool path.
    const toolSequence = params.toolSequence.map((t) => ({ ...TOOL_STEP_DEFAULTS, tabCount: params.tabCount ?? 0, ...t }));
    for (const t of toolSequence) {
      if (!t.toolDiameter || t.toolDiameter <= 0) throw new Error('Every tool in the sequence needs a toolDiameter > 0');
      requireSafePlungeAndFeed(t.feedRate, t.plungeRate, t.label || `${fmt(t.toolDiameter, 3)}" tool`);
    }
    const assignments = assignContoursToTools(contours, toolSequence);

    lines.push('(--- TOOL PLAN - stage these before starting ---)');
    toolSequence.forEach((t, i) => {
      const count = assignments.filter((a) => a.toolIndex === i).length;
      lines.push(`(  ${i + 1}. ${t.label || `${fmt(t.toolDiameter, 3)}" tool`}${t.toolNumber ? ` (T${t.toolNumber})` : ''} - ${count} contour${count === 1 ? '' : 's'} )`);
    });

    // Same ordering safety rule as the single-tool path above: every hole
    // contour, on whichever tool it needs, is cut before the outer contour
    // - even if that means revisiting a tool already used earlier in the
    // program. Split into two passes (holes, then outer) and run the
    // existing tool-grouping logic within each, so tool changes are still
    // minimized inside each pass.
    const holeAssignments = assignments.filter((a) => a.contour.isHole);
    const outerAssignments = assignments.filter((a) => !a.contour.isHole);

    let totalTabZones = 0;
    let toolChanges = 0;
    // Tracks which tool is physically loaded RIGHT NOW, across both the
    // holes phase and the outer phase below - not just "have we started
    // yet" - so that if the outer contour happens to need the same tool
    // that was just used for the last hole (a common case: both fit the
    // primary/largest tool), cutting continues straight through with no
    // spurious tool-change block. Only a genuine difference from the
    // currently-loaded tool counts as a change.
    let currentToolIndex = -1;

    const cutAssignmentGroup = (groupAssignments) => {
      for (let toolIndex = 0; toolIndex < toolSequence.length; toolIndex += 1) {
        const contoursForTool = groupAssignments.filter((a) => a.toolIndex === toolIndex).map((a) => a.contour);
        if (contoursForTool.length === 0) continue; // nothing needs this tool in this group - skip it, no pointless tool change

        const tool = toolSequence[toolIndex];
        if (toolIndex !== currentToolIndex) {
          if (currentToolIndex === -1) {
            lines.push(`(--- TOOL 1: ${tool.label || `${fmt(tool.toolDiameter, 3)}" tool`}${tool.toolNumber ? ` (T${tool.toolNumber})` : ''} - load before starting ---)`);
            lines.push(`S${tool.spindleSpeed} M03 (spindle on)`);
            if (spindleDwellSeconds > 0) lines.push(dwellLine(isWinCNC, spindleDwellSeconds, 'wait for spindle to reach speed'));
            lines.push(`G00 Z${fmt(safeZ)} (safe height)`);
          } else {
            toolChanges += 1;
            lines.push(`G00 Z${fmt(safeZ)} (retract clear before tool change)`);
            lines.push('M05 (spindle off)');
            lines.push(pauseLine(isWinCNC, `TOOL CHANGE: load ${tool.label || `${fmt(tool.toolDiameter, 3)}" tool`}${tool.toolNumber ? ` - T${tool.toolNumber}` : ''}, then RE-TOUCH OFF Z0 before resuming - no automatic tool length compensation assumed`));
            lines.push(`S${tool.spindleSpeed} M03 (spindle back on)`);
            if (spindleDwellSeconds > 0) lines.push(dwellLine(isWinCNC, spindleDwellSeconds, 'wait for spindle to reach speed'));
            lines.push(`G00 Z${fmt(safeZ)} (safe height)`);
          }
          currentToolIndex = toolIndex;
        } // else: same tool as what's already loaded and spinning - keep cutting, no change block, no re-announcement

        for (const contour of contoursForTool) {
          const { tabZoneCount } = cutContour(lines, contour, tool.toolDiameter / 2, { ...tool, targetDepth: tool.targetDepth || targetDepth }, safeZ);
          totalTabZones += tabZoneCount;
        }
      }
    };

    cutAssignmentGroup(holeAssignments);
    if (holeAssignments.length > 0 && outerAssignments.length > 0) {
      lines.push('(--- internal features complete - outer profile cut last, see file header on cut order ---)');
    }
    cutAssignmentGroup(outerAssignments);

    lines.push('M05 (spindle off)');
    lines.push(isWinCNC ? '(PROGRAM END)' : 'M30 (program end)');

    gcode = lines.join('\n');
    stats = { contours: contours.length, tabZones: totalTabZones, targetDepth, toolChanges, toolsUsed: [...new Set(assignments.map((a) => a.toolIndex))].length, edgeShiftX, edgeShiftY };
  }

  // Renders every comment in the controller's own syntax and, just as
  // importantly, makes each one well-formed - see autocam/gcodeComments.js.
  //
  // This replaced a blind per-character "(" -> "[" swap. That swap was
  // chosen over a balanced-pair regex for a good reason (HEADER_WARNING's
  // inline parenthetical splits its open/close across two array entries,
  // which a "(...)"-matching regex pairs wrong), and it is true that WinCNC
  // treats an unbalanced "[" as fine. But the failure it missed is an early
  // CLOSE: swapping the inner ")" of "...(e.g. ncviewer.com, CAMotics) and
  // ..." produced "...CAMotics] and do a supervised air-cut...]", ending the
  // comment mid-sentence and leaving the rest of the line as live code. One
  // real line came out as "[G92] BEFORE running this file - WinCNC has no
  // G54-style stored work offset]", putting a bare G54 on a controller that
  // comment says has no G54. normalizeGcodeComments works per line rather
  // than by pairing delimiters, so it has neither failure mode.
  gcode = normalizeGcodeComments(gcode, { dialect: isWinCNC ? 'wincnc' : 'linuxcnc' });

  return { gcode, stats };
}
