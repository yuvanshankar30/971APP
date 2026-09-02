/**
 * Conservative sheet nesting for completed router programs.
 *
 * This intentionally packs the measured cutting envelopes, not idealized
 * CAD polygons. It is deterministic, inspectable, and never claims that two
 * irregular parts can share a void in one another's bounding box. A later
 * polygon-nesting engine can replace `packRects` without changing the group
 * API or generated-program contract.
 */

const WORD = /([XY])\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

export function gcodeBounds(gcode) {
  let x = 0;
  let y = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of String(gcode || '').split(/\r?\n/)) {
    let matched = false;
    for (const match of line.matchAll(WORD)) {
      matched = true;
      if (match[1] === 'X') x = Number(match[2]);
      else y = Number(match[2]);
    }
    if (matched && Number.isFinite(x) && Number.isFinite(y)) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) throw new Error('This G-code contains no X/Y motion to nest');
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Safe centerline clearance. The cutter already extends half its diameter
 * beyond a contour centerline, so keeping paths a full cutter diameter apart
 * leaves a real web. Tolerance is added on both sides for setup variation. */
export function minimumPartClearance(toolDiameter, tolerance = 0.01) {
  const diameter = Number(toolDiameter);
  const tol = Number(tolerance);
  if (!(diameter > 0)) throw new Error('A positive end-mill diameter is required for grouping');
  if (tol < 0 || !Number.isFinite(tol)) throw new Error('Tolerance must be zero or greater');
  return diameter + tol * 2;
}

/**
 * First-fit decreasing shelf packing. The result's origin is the *cutting
 * envelope* corner, not a CAD corner, which makes it correct for jobs that
 * applied their own edgeShift before generation.
 */
export function packRects(items, { stockWidth, stockHeight, edgeMargin = 0.5, clearance }) {
  const width = Number(stockWidth), height = Number(stockHeight), margin = Number(edgeMargin);
  if (!(width > 0 && height > 0)) throw new Error('Stock width and height must be positive');
  if (!(margin >= 0 && clearance >= 0)) throw new Error('Margin and clearance must be zero or greater');
  const usableWidth = width - margin * 2;
  const usableHeight = height - margin * 2;
  if (!(usableWidth > 0 && usableHeight > 0)) throw new Error('Stock is smaller than its edge margins');

  const sorted = [...items].sort((a, b) => Math.max(b.bounds.width, b.bounds.height) - Math.max(a.bounds.width, a.bounds.height));
  const shelves = [];
  const placements = [];
  for (const item of sorted) {
    const itemWidth = item.bounds.width;
    const itemHeight = item.bounds.height;
    let shelf = shelves.find((candidate) => candidate.height >= itemHeight && candidate.cursorX + itemWidth <= usableWidth + 1e-9);
    if (!shelf) {
      const y = shelves.length ? shelves[shelves.length - 1].y + shelves[shelves.length - 1].height + clearance : 0;
      if (y + itemHeight > usableHeight + 1e-9) throw new Error(`${item.name || 'A selected job'} does not fit on this stock with the required clearance`);
      shelf = { y, height: itemHeight, cursorX: 0 };
      shelves.push(shelf);
    }
    placements.push({
      ...item,
      x: margin + shelf.cursorX,
      y: margin + shelf.y,
      offsetX: margin + shelf.cursorX - item.bounds.minX,
      offsetY: margin + shelf.y - item.bounds.minY
    });
    shelf.cursorX += itemWidth + clearance;
  }
  const usedHeight = shelves.length ? shelves[shelves.length - 1].y + shelves[shelves.length - 1].height : 0;
  return { placements, usedWidth: Math.max(0, ...shelves.map((s) => s.cursorX - clearance)), usedHeight, utilization: (placements.reduce((sum, p) => sum + p.bounds.width * p.bounds.height, 0) / (width * height)) || 0 };
}

export function planJobNesting(jobs, options) {
  const clearance = options.clearance === '' || options.clearance == null
    ? minimumPartClearance(options.toolDiameter, options.tolerance)
    : Number(options.clearance);
  const items = jobs.map((job) => ({ id: job.id, name: job.name || job.parts?.name || 'Untitled job', bounds: gcodeBounds(job.gcode) }));
  return { ...packRects(items, { ...options, clearance }), clearance };
}
