import { writable } from 'svelte/store';

const state = writable(null);
let active = null;

export const confirmation = { subscribe: state.subscribe };

export function requestConfirmation(options = {}) {
  const config = typeof options === 'string' ? { message: options } : options;
  const { title = 'Confirm action', message, confirmLabel = 'Confirm', danger = false, requireText = '' } = config;
  return new Promise((resolve) => {
    active = { resolve };
    state.set({ title, message: String(message || ''), confirmLabel, danger, requireText: String(requireText || '') });
  });
}

export function resolveConfirmation(confirmed) {
  const pending = active;
  active = null;
  state.set(null);
  pending?.resolve(Boolean(confirmed));
}
