import { describe, expect, it } from 'vitest';
import { groupFusionParts } from './grouping.js';

const categories = [
  { id: 1, thickness: 0.125, cam_materials: { name: 'Aluminum' } },
  { id: 2, thickness: 0.25, cam_materials: { name: 'Aluminum' } },
  { id: 3, thickness: 0.125, cam_materials: { name: 'Polycarbonate' } }
];

describe('Fusion stock planning groups', () => {
  it('separates thicknesses and materials while normalizing category ID types', () => {
    const parts = [
      { id: 'a', category_id: 1, quantity: 2 },
      { id: 'b', category_id: 2, quantity: 4 },
      { id: 'c', category_id: '1', quantity: 3 },
      { id: 'd', category_id: 3, quantity: 1 }
    ];
    const groups = groupFusionParts(parts, categories);
    expect(groups.map((group) => group.parts.map((part) => part.id))).toEqual([['a', 'c'], ['b'], ['d']]);
    expect(groups.map((group) => group.remainingQuantity)).toEqual([5, 4, 1]);
    expect(parts.map((part) => part.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps fully assigned parts visible and counts only remaining inventory', () => {
    const groups = groupFusionParts([
      { id: 'a', category_id: 1, quantity: 0, original_quantity: 8 },
      { id: 'b', category_id: 1, quantity: 2, original_quantity: 6 }
    ], categories);
    expect(groups[0].parts).toHaveLength(2);
    expect(groups[0].remainingQuantity).toBe(2);
  });

  it('does not present missing or stale categories as compatible stock', () => {
    const groups = groupFusionParts([
      { id: 'a', category_id: null, quantity: 1 },
      { id: 'b', category_id: null, quantity: 1 },
      { id: 'c', category_id: 99, quantity: 1 }
    ], categories);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.categoryId === null)).toBe(true);
  });

  it('does not let invalid quantities corrupt the group total', () => {
    const groups = groupFusionParts([NaN, -2, 1.5, Infinity, '3'].map((quantity, id) => ({ id, quantity, category_id: 1 })), categories);
    expect(groups[0].remainingQuantity).toBe(3);
    expect(groupFusionParts([], categories)).toEqual([]);
  });
});

describe('editing existing plate assignments', () => {
  it('keeps fully assigned parts editable on their plate, but excludes them elsewhere', async () => {
    const { eligiblePlateParts } = await import('./grouping.js');
    const part = { id: 'a', category_id: 'stock', quantity: 0 };
    const plate = { category_id: 'stock', fusion_part_category_assignments: [{ quantity: 5, fusion_parts: { id: 'a' } }] };
    expect(eligiblePlateParts(plate, [part])).toEqual([part]);
    expect(eligiblePlateParts({ category_id: 'stock' }, [part])).toEqual([]);
    expect(eligiblePlateParts({ ...plate, category_id: 'other' }, [part])).toEqual([]);
  });
});
