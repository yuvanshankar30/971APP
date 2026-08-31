import { describe, expect, it } from 'vitest';
import { canAccessSpecialThemes } from './special_themes.js';

describe('special theme access', () => {
  it('allows only Arin Rao authenticated email', () => {
    expect(canAccessSpecialThemes({ email: 'arin.rao12@gmail.com' })).toBe(true);
    expect(canAccessSpecialThemes({ email: 'ARIN.RAO12@GMAIL.COM' })).toBe(true);
    expect(canAccessSpecialThemes({ email: 'arin.rao12+copy@gmail.com' })).toBe(false);
    expect(canAccessSpecialThemes({ email: 'someone@example.com' })).toBe(false);
    expect(canAccessSpecialThemes(null)).toBe(false);
  });
});
