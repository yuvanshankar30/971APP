const cloneHistory = (history = {}) => ({
  past: Array.isArray(history.past) ? structuredClone(history.past) : [],
  present: Array.isArray(history.present)
    ? structuredClone(history.present)
    : [],
  future: Array.isArray(history.future) ? structuredClone(history.future) : [],
});

export function createUndoStack(initial, history = null) {
  const restored = history ? cloneHistory(history) : null;
  let past = restored?.past || [],
    present = restored?.present || structuredClone(initial),
    future = restored?.future || [];
  return {
    get value() {
      return structuredClone(present);
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    get snapshot() {
      return cloneHistory({ past, present, future });
    },
    commit(next) {
      past.push(structuredClone(present));
      present = structuredClone(next);
      future = [];
      return this.value;
    },
    undo() {
      if (!past.length) return this.value;
      future.push(structuredClone(present));
      present = past.pop();
      return this.value;
    },
    redo() {
      if (!future.length) return this.value;
      past.push(structuredClone(present));
      present = future.pop();
      return this.value;
    },
  };
}
