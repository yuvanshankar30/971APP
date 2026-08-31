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

function initialTheme() {
  if (!browser) return DEFAULT_THEME;
  const saved = localStorage.getItem(STORAGE_KEY);
  // Legacy dark was removed — migrate users who had it saved to Modern Dark
  if (saved === 'dark') return 'modern-dark';
  return THEMES.includes(saved) ? saved : DEFAULT_THEME;
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
  try { localStorage.setItem(STORAGE_KEY, v); } catch {}
}

if (browser) {
  theme.subscribe(applyTheme);
}

export function setTheme(value) {
  theme.set(THEMES.includes(value) || (specialThemesAuthorized && isSpecialTheme(value)) ? value : DEFAULT_THEME);
}

export function registerSpecialThemes(groups = []) {
  specialThemePalettes = new Map(groups.flatMap((group) => group.themes || []).map((entry) => [entry.id, entry.palette]));
  specialThemesAuthorized = specialThemePalettes.size > 0;
  specialThemeGroups.set(specialThemesAuthorized ? groups : []);
  specialThemesAllowed.set(specialThemesAuthorized);
  if (!browser) return specialThemesAuthorized;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (specialThemesAuthorized && isSpecialTheme(saved)) theme.set(saved);
  if (!specialThemesAuthorized) theme.update((value) => THEMES.includes(value) ? value : DEFAULT_THEME);
  return specialThemesAuthorized;
}

// Toggle between the modern light/dark pair; from legacy light it enters
// Modern Dark (legacy has no dark counterpart anymore).
export function toggleTheme() {
  theme.update((v) => (v === 'modern-dark' ? 'modern' : 'modern-dark'));
}
