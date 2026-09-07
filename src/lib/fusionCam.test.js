import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/supabase.js', () => ({ supabase: {} }));

import { isFusionOutputJob } from './fusionCam.js';

describe('isFusionOutputJob', () => {
  it('accepts Fusion operations that generate machine output', () => {
    expect(isFusionOutputJob({ params: { fusionJobKind: 'plate:cam' } })).toBe(true);
    expect(isFusionOutputJob({ params: { fusionJobKind: 'box_tube' } })).toBe(true);
  });

  it('rejects arrangement and malformed jobs', () => {
    expect(isFusionOutputJob({ params: { fusionJobKind: 'plate:arrange' } })).toBe(false);
    expect(isFusionOutputJob({ params: {} })).toBe(false);
    expect(isFusionOutputJob(null)).toBe(false);
  });
});
