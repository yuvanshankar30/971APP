export function makePlacement(values = {}) {
  return { id: values.id || crypto.randomUUID(), kind: values.kind || 'part', label: values.label || 'Part', x: Number(values.x) || 0, y: Number(values.y) || 0, rotation: Number(values.rotation) || 0, width_in: Math.max(0, Number(values.width_in) || 0), height_in: Math.max(0, Number(values.height_in) || 0), part_library_path: values.part_library_path || null };
}

export function rotatePlacement(placement, quarterTurns = 1) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  return { ...placement, rotation: placement.rotation + turns * Math.PI / 2, ...(turns % 2 ? { width_in: placement.height_in, height_in: placement.width_in } : {}) };
}

export function placementBounds(placement) {
  return { left: placement.x - placement.width_in / 2, right: placement.x + placement.width_in / 2, bottom: placement.y - placement.height_in / 2, top: placement.y + placement.height_in / 2 };
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
