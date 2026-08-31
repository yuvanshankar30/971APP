import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { registerSpecialThemes, resolveStoredTheme, setTheme, specialThemesAllowed, theme } from './theme.js';

const privateGroups = [{ label: 'Private', themes: [{ id: 'theme-kind-of-blue', palette: ['#000', '#111', '#22f', '#fff'] }] }];

describe('special theme authorization', () => {
  it('rejects a special theme when the server returned no groups', () => {
    registerSpecialThemes([]);
    setTheme('theme-kind-of-blue');
    expect(get(specialThemesAllowed)).toBe(false);
    expect(get(theme)).toBe('modern');
  });

  it('allows a special theme once the server returns groups', () => {
    registerSpecialThemes(privateGroups);
    setTheme('theme-kind-of-blue');
    expect(get(specialThemesAllowed)).toBe(true);
    expect(get(theme)).toBe('theme-kind-of-blue');
    registerSpecialThemes([]);
  });
});

describe('theme reload persistence', () => {
  it('defers a saved catalog theme instead of discarding its ID at startup', () => {
    expect(resolveStoredTheme('theme-kind-of-blue')).toEqual({
      theme: 'modern',
      pending: 'theme-kind-of-blue'
    });
  });

  it('applies built-in and migrated themes immediately', () => {
    expect(resolveStoredTheme('modern-dark')).toEqual({ theme: 'modern-dark', pending: null });
    expect(resolveStoredTheme('dark')).toEqual({ theme: 'modern-dark', pending: null });
    expect(resolveStoredTheme(null)).toEqual({ theme: 'modern', pending: null });
  });
});
