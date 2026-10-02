import { describe, expect, it } from 'vitest';
import { canAccessSpecialThemes, SPECIAL_THEME_GROUPS } from './special_themes.js';

describe('special theme access', () => {
  it('allows any authenticated user', () => {
    expect(canAccessSpecialThemes({ email: 'someone@example.com' })).toBe(true);
    expect(canAccessSpecialThemes({ email: 'anyone-else@example.com' })).toBe(true);
    expect(canAccessSpecialThemes(null)).toBe(false);
    expect(canAccessSpecialThemes(undefined)).toBe(false);
  });
});

describe('Diggi theme', () => {
  it('is included in the permanent authenticated theme catalog', () => {
    expect(SPECIAL_THEME_GROUPS.some((group) => group.themes.some((theme) => theme.id === 'theme-diggi'))).toBe(true);
  });
});
