export function makePlacement(values = {}) {
  return { id: values.id || crypto.randomUUID(), kind: values.kind || 'part', label: values.label || 'Part', x: Number(values.x) || 0, y: Number(values.y) || 0, rotation: Number(values.rotation) || 0, width_in: Math.max(0, Number(values.width_in) || 0), height_in: Math.max(0, Number(values.height_in) || 0), part_library_path: values.part_library_path || null };
}

export function rotatePlacement(placement, quarterTurns = 1) {
  return { ...placement, rotation: placement.rotation + quarterTurns * Math.PI / 2 };
}

export function placementBounds(placement) {
  const rotation = Number(placement.rotation) || 0;
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const halfWidth = (c * placement.width_in + s * placement.height_in) / 2;
  const halfHeight = (s * placement.width_in + c * placement.height_in) / 2;
  return { left: placement.x - halfWidth, right: placement.x + halfWidth, bottom: placement.y - halfHeight, top: placement.y + halfHeight };
}

export function placementContains(placement, x, y) {
  const c = Math.cos(-placement.rotation), s = Math.sin(-placement.rotation);
  const dx = x - placement.x, dy = y - placement.y;
  const localX = dx * c - dy * s, localY = dx * s + dy * c;
  return Math.abs(localX) <= placement.width_in / 2 && Math.abs(localY) <= placement.height_in / 2;
}

export function sheetContains(sheet, placement) {
  const bounds = placementBounds(placement);
  return bounds.left >= 0 && bounds.bottom >= 0 && bounds.right <= Number(sheet.width_in) && bounds.top <= Number(sheet.height_in);
}

export function placementHasEdgeClearance(sheet, placement, clearance = 0) {
  const bounds = placementBounds(placement), margin = Number(clearance) || 0;
  return bounds.left > margin && bounds.bottom > margin && bounds.right < Number(sheet.width_in) - margin && bounds.top < Number(sheet.height_in) - margin;
}

export function clampPlacementToSheet(sheet, placement) {
  const bounds = placementBounds(placement);
  const width = Number(sheet.width_in), height = Number(sheet.height_in);
  if (bounds.right - bounds.left > width || bounds.top - bounds.bottom > height) return null;
  const dx = Math.max(0, -bounds.left) - Math.max(0, bounds.right - width);
  const dy = Math.max(0, -bounds.bottom) - Math.max(0, bounds.top - height);
  return { ...placement, x: placement.x + dx, y: placement.y + dy };
}
