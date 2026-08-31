import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'app-theme';
const DEFAULT_THEME = 'modern';
export const SPECIAL_THEME_EMAIL = 'arin.rao12@gmail.com';

// 'light'  = Legacy (original design)
// 'modern' = Modern Light (default)
// 'modern-dark' = Modern Dark
export const THEMES = ['light', 'modern', 'modern-dark'];

export const SPECIAL_THEME_GROUPS = [
  {
    label: 'Atmosphere',
    themes: [
      { id: 'theme-kind-of-blue', label: 'Kind of Blue', preview: ['#18314a', '#277da1'] },
      { id: 'theme-funky-fresh', label: 'Funky Fresh', preview: ['#6d5b97', '#52b788'] },
      { id: 'theme-jazz-club', label: 'Jazz Club', preview: ['#8b0000', '#240046'] }
    ]
  },
  {
    label: 'Single color',
    themes: [
      { id: 'theme-aubergine', label: 'Aubergine', preview: ['#2b0a3d', '#7b2cbf'] },
      { id: 'theme-clementine', label: 'Clementine', preview: ['#542000', '#e85d04'] },
      { id: 'theme-banana', label: 'Banana', preview: ['#3d2d00', '#d4a017'] },
      { id: 'theme-jade', label: 'Jade', preview: ['#023c2c', '#2a9d8f'] },
      { id: 'theme-lagoon', label: 'Lagoon', preview: ['#003049', '#00b4d8'] },
      { id: 'theme-barbra', label: 'Barbra', preview: ['#5f0014', '#d90429'] }
    ]
  },
  {
    label: 'Fun and new',
    themes: [
      { id: 'theme-raspberry-beret', label: 'Raspberry Beret', preview: ['#3c001d', '#d0004b'] },
      { id: 'theme-big-business', label: 'Big Business', preview: ['#111827', '#1d4ed8'] },
      { id: 'theme-mint-chip', label: 'Mint Chip', preview: ['#053b2c', '#264de4'] },
      { id: 'theme-pbj', label: 'PB&J', preview: ['#5a2a0c', '#9d174d'] },
      { id: 'theme-chill-vibes', label: 'Chill Vibes', preview: ['#003d36', '#006d77'] }
    ]
  }
];

export const SPECIAL_THEMES = SPECIAL_THEME_GROUPS.flatMap((group) => group.themes.map((entry) => entry.id));
let specialThemesAuthorized = false;
export const specialThemesAllowed = writable(false);

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
  const v = THEMES.includes(value) || (specialThemesAuthorized && SPECIAL_THEMES.includes(value)) ? value : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', v);
  try { localStorage.setItem(STORAGE_KEY, v); } catch {}
}

if (browser) {
  theme.subscribe(applyTheme);
}

export function setTheme(value) {
  theme.set(THEMES.includes(value) || (specialThemesAuthorized && SPECIAL_THEMES.includes(value)) ? value : DEFAULT_THEME);
}

export function authorizeSpecialThemes(email) {
  specialThemesAuthorized = String(email || '').trim().toLowerCase() === SPECIAL_THEME_EMAIL;
  specialThemesAllowed.set(specialThemesAuthorized);
  if (!browser) return specialThemesAuthorized;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (specialThemesAuthorized && SPECIAL_THEMES.includes(saved)) theme.set(saved);
  if (!specialThemesAuthorized) theme.update((value) => SPECIAL_THEMES.includes(value) ? DEFAULT_THEME : value);
  return specialThemesAuthorized;
}

// Toggle between the modern light/dark pair; from legacy light it enters
// Modern Dark (legacy has no dark counterpart anymore).
export function toggleTheme() {
  theme.update((v) => (v === 'modern-dark' ? 'modern' : 'modern-dark'));
}
