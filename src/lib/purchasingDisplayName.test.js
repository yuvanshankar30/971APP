import { describe, expect, it } from 'vitest';
import { purchasingDisplayName } from './purchasingDisplayName.js';

describe('purchasingDisplayName', () => {
  it('shows the first word of a real stored name', () => {
    expect(purchasingDisplayName('Alex Smith')).toBe('Alex');
  });

  it('never manufactures a name from a bare email', () => {
    expect(purchasingDisplayName('mason.j.qian@gmail.com')).toBe('Name not set');
  });

  it('falls back to Unknown when nothing is stored', () => {
    expect(purchasingDisplayName(null)).toBe('Unknown');
    expect(purchasingDisplayName('')).toBe('Unknown');
    expect(purchasingDisplayName(undefined)).toBe('Unknown');
  });

  it('trims incidental whitespace', () => {
    expect(purchasingDisplayName('  Alex  ')).toBe('Alex');
  });
});
