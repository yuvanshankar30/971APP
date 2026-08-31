import { describe, expect, it } from 'vitest';
import { canAccessSpecialThemes } from './special_themes.js';

describe('special theme access', () => {
  it('allows any authenticated user', () => {
    expect(canAccessSpecialThemes({ email: 'someone@example.com' })).toBe(true);
    expect(canAccessSpecialThemes({ email: 'anyone-else@example.com' })).toBe(true);
    expect(canAccessSpecialThemes(null)).toBe(false);
    expect(canAccessSpecialThemes(undefined)).toBe(false);
  });
});
