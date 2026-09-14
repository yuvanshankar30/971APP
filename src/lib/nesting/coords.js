export function sheetToScreen(point, view) {
  return { x: view.originX + point.x * view.scale, y: view.originY - point.y * view.scale };
}
export function screenToSheet(point, view) {
  return { x: (point.x - view.originX) / view.scale, y: (view.originY - point.y) / view.scale };
}
export function zoomAt(view, cursor, factor) {
  const before = screenToSheet(cursor, view);
  const scale = Math.max(4, Math.min(500, view.scale * factor));
  return { scale, originX: cursor.x - before.x * scale, originY: cursor.y + before.y * scale };
}
