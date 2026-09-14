export function createUndoStack(initial) {
  let past = [], present = structuredClone(initial), future = [];
  return {
    get value() { return structuredClone(present); },
    get canUndo() { return past.length > 0; }, get canRedo() { return future.length > 0; },
    commit(next) { past.push(structuredClone(present)); present = structuredClone(next); future = []; return this.value; },
    undo() { if (!past.length) return this.value; future.push(structuredClone(present)); present = past.pop(); return this.value; },
    redo() { if (!future.length) return this.value; past.push(structuredClone(present)); present = future.pop(); return this.value; }
  };
}
