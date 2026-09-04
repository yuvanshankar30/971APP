import { describe, expect, it } from 'vitest';
import { rankPurchasingPhotoCandidates } from './purchasingPhotoMatch.js';

const items = [
  { id: 1, name: '1/4 in Aluminum Hex Shaft', vendor: 'West Coast Products', url: 'https://wcproducts.com/hex-shaft', part_number: 'WCP-123' },
  { id: 2, name: 'Falcon 500 Motor', vendor: 'REV Robotics', url: 'https://www.revrobotics.com/falcon-500/', part_number: '217-6515' },
  { id: 3, name: '1/4 in Aluminum Round Tube', vendor: 'McMaster-Carr', url: 'https://mcmaster.com/tube' }
];

describe('rankPurchasingPhotoCandidates', () => {
  it('ranks an exact product and vendor match first', () => {
    const result = rankPurchasingPhotoCandidates({ productName: 'Falcon 500 Motor', vendorGuess: 'REV Robotics', rawText: 'REV 217-6515 Falcon 500' }, items);
    expect(result[0].item.id).toBe(2);
    expect(result[0].score).toBeGreaterThan(0.7);
  });

  it('uses raw package text when the product field is incomplete', () => {
    const result = rankPurchasingPhotoCandidates({ productName: 'shaft', vendorGuess: 'West Coast Products', rawText: 'WCP-123 1/4 inch aluminum hex shaft' }, items);
    expect(result[0].item.id).toBe(1);
  });

  it('does not turn generic packaging text into a match', () => {
    expect(rankPurchasingPhotoCandidates({ rawText: 'thank you for your order packing slip' }, items)).toEqual([]);
  });

  it('keeps close candidates ranked instead of choosing a loose substring', () => {
    const result = rankPurchasingPhotoCandidates({ productName: '1/4 aluminum tube', rawText: 'aluminum tube' }, items);
    expect(result.map(({ item }) => item.id)).toContain(3);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
