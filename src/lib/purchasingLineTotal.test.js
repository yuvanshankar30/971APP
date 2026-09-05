import { describe, expect, it } from 'vitest';
import { purchasingLineTotal } from './purchasingLineTotal.js';

describe('purchasingLineTotal', () => {
  it('multiplies the unit price by quantity', () => {
    expect(purchasingLineTotal(4.25, 3)).toBe(12.75);
  });

  it('uses one item when quantity is missing', () => {
    expect(purchasingLineTotal(9.5, null)).toBe(9.5);
  });

  it('keeps an unknown price distinct from a zero-dollar item', () => {
    expect(purchasingLineTotal(null, 4)).toBeNull();
    expect(purchasingLineTotal(0, 4)).toBe(0);
  });
});
