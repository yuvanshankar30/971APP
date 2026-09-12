import { describe, it, expect } from 'vitest';
import { isOnshapePlaceholderName } from './onshape_placeholder_names.js';

describe('isOnshapePlaceholderName', () => {
  it('matches bare placeholder names with or without a numeric suffix', () => {
    expect(isOnshapePlaceholderName('SOLID')).toBe(true);
    expect(isOnshapePlaceholderName('SOLID_1')).toBe(true);
    expect(isOnshapePlaceholderName('COMPOUND')).toBe(true);
    expect(isOnshapePlaceholderName('COMPOUND_2')).toBe(true);
    expect(isOnshapePlaceholderName('Chamfer1')).toBe(true);
    expect(isOnshapePlaceholderName('Boss-Extrude1')).toBe(true);
    expect(isOnshapePlaceholderName('Extrude1')).toBe(true);
    expect(isOnshapePlaceholderName('Fillet1')).toBe(true);
    expect(isOnshapePlaceholderName('fillet')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isOnshapePlaceholderName('solid')).toBe(true);
    expect(isOnshapePlaceholderName('CHAMFER1')).toBe(true);
  });

  it('does not match a real part name that merely contains one of these words', () => {
    expect(isOnshapePlaceholderName('Chamfer Bracket')).toBe(false);
    expect(isOnshapePlaceholderName('Fillet Guide Plate')).toBe(false);
    expect(isOnshapePlaceholderName('Pattern Alignment Jig')).toBe(false);
    expect(isOnshapePlaceholderName('pivot gearbox plate')).toBe(false);
  });

  it('does not match blank/undefined/unrelated names', () => {
    expect(isOnshapePlaceholderName('')).toBe(false);
    expect(isOnshapePlaceholderName(undefined)).toBe(false);
    expect(isOnshapePlaceholderName('Bottom Tube')).toBe(false);
  });
});
