import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { authorizeSpecialThemes, setTheme, specialThemesAllowed, theme } from './theme.js';

describe('special theme authorization', () => {
  it('rejects a special theme for every other account', () => {
    authorizeSpecialThemes('someone@example.com');
    setTheme('theme-kind-of-blue');
    expect(get(specialThemesAllowed)).toBe(false);
    expect(get(theme)).toBe('modern');
  });

  it('allows the exact authenticated Arin account', () => {
    authorizeSpecialThemes('ARIN.RAO12@GMAIL.COM');
    setTheme('theme-kind-of-blue');
    expect(get(specialThemesAllowed)).toBe(true);
    expect(get(theme)).toBe('theme-kind-of-blue');
    authorizeSpecialThemes(null);
  });
});
