/**
 * The cutoff line the router scribes so a tube can be band-sawn to length.
 *
 * Stock length is whatever the extrusion happened to be cut to, and it is
 * rarely the length the part needs. The router does not part the tube off
 * itself - it cuts a line the operator then saws along - so what this
 * produces is a cut line, not a separation.
 *
 * The shape is an obround: a rectangle with a semicircular cap at each end,
 * the caps being what a round cutter leaves anyway at the ends of a slot.
 * Sawing to a scribed obround rather than a bare straight line gives the
 * blade an entry at each end and leaves a visible line on both walls the
 * saw passes through.
 *
 * Coordinates are the same face coordinates the hole positions use: x runs
 * along the tube from the same datum, y is the lateral offset across the
 * face, with 0 on the face centreline.
 */

/** Angular resolution of the end caps. A cap is a half turn, so this many
 * segments across it puts a vertex roughly every 9 degrees - fine enough
 * that the saw line reads as an arc rather than a polygon, without burying
 * the program in points. */
const CAP_SEGMENTS = 20;

/**
 * @param {object} cutoff
 *   position (inches) - where along the tube the line sits, in the same
 *     coordinates as a hole's position
 *   width (inches) - across the face, the full width of the obround
 *   length (inches) - along the tube, the overall length including both
 *     caps, so it is the size of the shape as measured rather than the
 *     rectangle hidden inside it
 * @returns {Array<{x: number, y: number}>} a closed loop, first point
 *   repeated last, wound counter-clockwise
 */
export function tubeCutoffPath({ position, width, length }) {
  const pos = Number(position);
  const w = Number(width);
  const len = Number(length);
  if (!Number.isFinite(pos)) throw new Error('cutoff position must be a real number');
  if (!(w > 0)) throw new Error('cutoff width must be > 0');
  if (!(len > 0)) throw new Error('cutoff length must be > 0');

  const radius = w / 2;
  // The caps eat one radius off each end, so the straight section is what
  // is left. A length of exactly the width degenerates to a circle rather
  // than failing, which is a legitimate shape to saw to.
  if (len < w) throw new Error('cutoff length must be at least its width - the end caps alone are that long');
  const straight = len - w;
  const halfStraight = straight / 2;

  const points = [];
  const cap = (centerX, fromAngle) => {
    for (let i = 0; i <= CAP_SEGMENTS; i += 1) {
      const angle = fromAngle + (Math.PI * i) / CAP_SEGMENTS;
      points.push({ x: centerX + radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
  };

  // Bottom edge left to right, right cap, top edge right to left, left cap.
  points.push({ x: pos - halfStraight, y: -radius });
  points.push({ x: pos + halfStraight, y: -radius });
  cap(pos + halfStraight, -Math.PI / 2);
  points.push({ x: pos - halfStraight, y: radius });
  cap(pos - halfStraight, Math.PI / 2);

  // Each cap starts where the edge before it ended, and the last cap ends
  // where the whole path started. Those coincident points would each emit a
  // zero-length move, so they are dropped before the loop is closed rather
  // than left for the generator to trip over.
  const deduped = points.filter((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-9;
  });
  const last = deduped[deduped.length - 1];
  if (Math.hypot(last.x - deduped[0].x, last.y - deduped[0].y) <= 1e-9) deduped.pop();
  deduped.push({ ...deduped[0] });
  return deduped;
}

/**
 * Where the cut line has to sit for a part of a given length.
 *
 * The saw takes material out, so the line goes one kerf beyond the part -
 * cut on the line and the part comes out short by the width of the blade.
 *
 * @returns {number} position along the tube, in hole-position coordinates
 */
export function tubeCutoffPosition({ partEnd, kerf = 0 }) {
  const end = Number(partEnd);
  if (!Number.isFinite(end)) throw new Error('partEnd must be a real number');
  const blade = Number(kerf) || 0;
  if (blade < 0) throw new Error('kerf cannot be negative');
  return end + blade / 2;
}
