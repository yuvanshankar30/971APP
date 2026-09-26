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

describe('random theme disappearance', () => {
  it('makes one random special theme disappear from the catalog', () => {
    const totalThemes = SPECIAL_THEME_GROUPS.reduce((acc, group) => acc + group.themes.length, 0);
    // There are 14 original themes in the source groups list, and one is filtered out.
    expect(totalThemes).toBe(13);
  });
});
