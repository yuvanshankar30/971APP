import { writable } from 'svelte/store';
import { browser } from '$app/environment';

// Client-side cache of the account's login-screen preference, mirroring
// theme.js's pattern. The authoritative value lives on user_profiles
// (login_screen_style) and is only readable once signed in - this cache is
// what lets the signed-out screen itself render the right style, synced
// here whenever the account's saved value is known (see +page.svelte and
// profile/+page.svelte).
const STORAGE_KEY = 'login-screen-style';
// The split-hero redesign is now the default for anyone without an explicit
// saved preference (new signed-out browsers, and new accounts - see the
// matching `|| 'modern'` fallbacks in profile/+page.svelte). Existing
// accounts with a saved 'legacy' value keep seeing it until they change it
// themselves in Profile > Login Screen, same as any other per-account
// preference - this only changes what an unset preference resolves to.
const DEFAULT_STYLE = 'modern';

export const LOGIN_SCREEN_STYLES = ['legacy', 'modern'];

export const LOGIN_SCREEN_STYLE_LABELS = {
  legacy: 'Legacy Login',
  modern: 'Modern Login'
};

function initialLoginScreenStyle() {
  if (!browser) return DEFAULT_STYLE;
  const saved = localStorage.getItem(STORAGE_KEY);
  return LOGIN_SCREEN_STYLES.includes(saved) ? saved : DEFAULT_STYLE;
}

export const loginScreenStyle = writable(initialLoginScreenStyle());

export function setLoginScreenStyle(value) {
  const v = LOGIN_SCREEN_STYLES.includes(value) ? value : DEFAULT_STYLE;
  loginScreenStyle.set(v);
  if (browser) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch {}
  }
}
