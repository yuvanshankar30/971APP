import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'app-theme';
const DEFAULT_THEME = 'modern';

// 'light'  = Legacy (original design)
// 'modern' = Modern Light (default)
// 'modern-dark' = Modern Dark
export const THEMES = ['light', 'modern', 'modern-dark'];

let specialThemesAuthorized = false;
export const specialThemesAllowed = writable(false);
export const specialThemeGroups = writable([]);
let specialThemePalettes = new Map();
// A custom theme cannot be validated until the authenticated catalog arrives.
// Keep its saved ID out-of-band so the initial default render does not
// overwrite it in localStorage before registerSpecialThemes() can restore it.
let pendingSavedTheme = null;

function isSpecialTheme(value) {
  return specialThemePalettes.has(value);
}

function clearSpecialPalette() {
  if (!browser) return;
  for (const property of ['--special-bg', '--special-card', '--special-accent', '--special-text']) {
    document.documentElement.style.removeProperty(property);
  }
}

export const THEME_LABELS = {
  light: 'Legacy',
  modern: 'Modern Light (default)',
  'modern-dark': 'Modern Dark'
};

export function resolveStoredTheme(saved) {
  if (saved === 'dark') return { theme: 'modern-dark', pending: null };
  if (THEMES.includes(saved)) return { theme: saved, pending: null };
  return { theme: DEFAULT_THEME, pending: saved || null };
}

function initialTheme() {
  if (!browser) return DEFAULT_THEME;
  const saved = localStorage.getItem(STORAGE_KEY);
  const resolved = resolveStoredTheme(saved);
  pendingSavedTheme = resolved.pending;
  return resolved.theme;
}

export const theme = writable(initialTheme());

// Apply the theme to <html> and persist it whenever it changes.
export function applyTheme(value) {
  if (!browser) return;
  const v = THEMES.includes(value) || (specialThemesAuthorized && isSpecialTheme(value)) ? value : DEFAULT_THEME;
  clearSpecialPalette();
  const palette = specialThemePalettes.get(v);
  if (palette) {
    const [background, card, accent, text] = palette;
    document.documentElement.style.setProperty('--special-bg', background);
    document.documentElement.style.setProperty('--special-card', card);
    document.documentElement.style.setProperty('--special-accent', accent);
    document.documentElement.style.setProperty('--special-text', text);
  }
  document.documentElement.setAttribute('data-theme', v);
  // During startup `v` is temporarily the default while a saved custom theme
  // waits for the server catalog. Persisting here would erase the only copy of
  // that selection and make every custom theme disappear on reload.
  if (!pendingSavedTheme) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch {}
  }
}

if (browser) {
  theme.subscribe(applyTheme);
}

export function setTheme(value) {
  // An explicit user choice always wins over a deferred startup selection.
  pendingSavedTheme = null;
  theme.set(THEMES.includes(value) || (specialThemesAuthorized && isSpecialTheme(value)) ? value : DEFAULT_THEME);
}

export function registerSpecialThemes(groups = []) {
  specialThemePalettes = new Map(groups.flatMap((group) => group.themes || []).map((entry) => [entry.id, entry.palette]));
  specialThemesAuthorized = specialThemePalettes.size > 0;
  specialThemeGroups.set(specialThemesAuthorized ? groups : []);
  specialThemesAllowed.set(specialThemesAuthorized);
  if (!browser) return specialThemesAuthorized;
  const saved = pendingSavedTheme || localStorage.getItem(STORAGE_KEY);
  pendingSavedTheme = null;
  if (specialThemesAuthorized && isSpecialTheme(saved)) {
    theme.set(saved);
  } else if (!specialThemesAuthorized || !THEMES.includes(saved)) {
    theme.update((value) => THEMES.includes(value) ? value : DEFAULT_THEME);
  }
  return specialThemesAuthorized;
}

// Toggle between the modern light/dark pair; from legacy light it enters
// Modern Dark (legacy has no dark counterpart anymore).
export function toggleTheme() {
  theme.update((v) => (v === 'modern-dark' ? 'modern' : 'modern-dark'));
}
