import { describe, expect, it } from 'vitest';
import { buildEmitFilename } from './emitFilename.js';
import { emitNestingGcode } from './gcodeEmit.js';
import { placementContains, rotatePlacement, sheetContains } from './sheetModel.js';
import { screenToSheet, sheetToScreen, zoomAt } from './coords.js';
import { createUndoStack } from './undoStack.js';

describe('nesting geometry', () => {
  it('round-trips positive sheet coordinates through the canvas view', () => {
    const view = { scale: 20, originX: 10, originY: 300 };
    expect(screenToSheet(sheetToScreen({ x: 4.5, y: 8 }, view), view)).toEqual({ x: 4.5, y: 8 });
  });
  it('keeps the point under the cursor fixed while zooming', () => {
    const view = { scale: 20, originX: 10, originY: 300 }, cursor = { x: 210, y: 160 };
    expect(screenToSheet(cursor, zoomAt(view, cursor, 1.5))).toEqual(screenToSheet(cursor, view));
  });
  it('uses rotated dimensions for sheet containment', () => {
    const item = rotatePlacement({ x: 1, y: 3, width_in: 3, height_in: 1, rotation: 0 });
    expect(item.width_in).toBe(1); expect(item.height_in).toBe(3);
    expect(sheetContains({ width_in: 4, height_in: 4 }, item)).toBe(false);
    expect(placementContains(item, 1, 3)).toBe(true);
  });
});

describe('nesting edit history', () => {
  it('undoes and redoes a committed placement state', () => {
    const stack = createUndoStack([]); stack.commit([{ id: 'a' }]);
    expect(stack.undo()).toEqual([]); expect(stack.redo()).toEqual([{ id: 'a' }]);
  });
});

describe('nesting emission', () => {
  it('prevents suffix filename collisions', () => {
    expect(buildEmitFilename('My Sheet', 'router', 2, '.tap')).toBe('My_Sheet_router.tap');
    expect(buildEmitFilename('My Sheet', 'router', 1, 'tap')).toBe('My_Sheet.tap');
  });
  it('translates each placed program and leaves one program terminator', () => {
    const result = emitNestingGcode({ name: 'nest', placements: [{ label: 'A', x: 2, y: 3, part_library_path: 'a' }], programs: { a: { source: 'G1 X1 Y2\nM30' } } });
    expect(result.text).toContain('G1 X3.0000 Y5.0000');
    expect(result.text.match(/M30/g)).toHaveLength(1);
  });
});
