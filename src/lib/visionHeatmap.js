export function buildVisionHeatmap(tracks = [], { columns = 36, rows = 18 } = {}) {
  const points = tracks.flatMap((track) => (track?.trajectory || [])
    .filter((point) => point?.calibrated === true && Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: Number(point.x), y: Number(point.y), alliance: track.alliance })));

  if (!points.length) return { points: 0, cells: [], bounds: null, maxCount: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const spanX = Math.max(bounds.maxX - bounds.minX, 0.001);
  const spanY = Math.max(bounds.maxY - bounds.minY, 0.001);
  const bins = new Map();

  for (const point of points) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor(((point.x - bounds.minX) / spanX) * columns)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((point.y - bounds.minY) / spanY) * rows)));
    const key = `${column}:${row}`;
    const cell = bins.get(key) || { column, row, red: 0, blue: 0, unknown: 0, count: 0 };
    const alliance = point.alliance === 'red' || point.alliance === 'blue' ? point.alliance : 'unknown';
    cell[alliance] += 1;
    cell.count += 1;
    bins.set(key, cell);
  }

  const cells = [...bins.values()];
  return { points: points.length, cells, bounds, maxCount: Math.max(...cells.map((cell) => cell.count)), columns, rows };
}
