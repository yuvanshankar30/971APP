import { describe, expect, it } from 'vitest';
import { canAccessSpecialThemes, DIGGI_THEME_EXPIRES_AT, DIGGI_THEME_ID, getSpecialThemeGroups } from './special_themes.js';

describe('special theme access', () => {
  it('allows any authenticated user', () => {
    expect(canAccessSpecialThemes({ email: 'someone@example.com' })).toBe(true);
    expect(canAccessSpecialThemes({ email: 'anyone-else@example.com' })).toBe(true);
    expect(canAccessSpecialThemes(null)).toBe(false);
    expect(canAccessSpecialThemes(undefined)).toBe(false);
  });
});

function hasDiggi(groups) {
  return groups.some((group) => group.themes.some((theme) => theme.id === DIGGI_THEME_ID));
}

describe('Diggi launch window', () => {
  it('is available before the global expiry and never included after it', () => {
    expect(hasDiggi(getSpecialThemeGroups(DIGGI_THEME_EXPIRES_AT - 1))).toBe(true);
    expect(hasDiggi(getSpecialThemeGroups(DIGGI_THEME_EXPIRES_AT))).toBe(false);
    expect(hasDiggi(getSpecialThemeGroups(DIGGI_THEME_EXPIRES_AT + 1))).toBe(false);
  });
});
