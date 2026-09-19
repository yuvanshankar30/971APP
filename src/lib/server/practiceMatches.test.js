import { describe, expect, it } from 'vitest';
import { buildPracticeMatch } from './practiceMatches.js';

describe('buildPracticeMatch', () => {
  it('numbers the first practice match 1 for an event with none yet', () => {
    expect(buildPracticeMatch('2026cc', 0)).toEqual({ match_key: '2026cc_practice_1', label: 'Practice 1', number: 1 });
  });

  it('continues from the existing count rather than restarting', () => {
    expect(buildPracticeMatch('2026cc', 2)).toEqual({ match_key: '2026cc_practice_3', label: 'Practice 3', number: 3 });
  });

  it('scopes the match_key to the event so two events never collide', () => {
    expect(buildPracticeMatch('2026casj', 0).match_key).toBe('2026casj_practice_1');
    expect(buildPracticeMatch('2026cc', 0).match_key).toBe('2026cc_practice_1');
  });

  it('trims a padded event key instead of baking whitespace into the key', () => {
    expect(buildPracticeMatch('  2026cc  ', 0).match_key).toBe('2026cc_practice_1');
  });

  it('treats a missing, negative, or non-finite count as zero rather than producing a bad number', () => {
    for (const bad of [undefined, null, -1, NaN, Infinity]) {
      expect(buildPracticeMatch('2026cc', bad)).toEqual({ match_key: '2026cc_practice_1', label: 'Practice 1', number: 1 });
    }
  });

  it('floors a fractional count so a bad row-count value cannot produce a fractional match number', () => {
    expect(buildPracticeMatch('2026cc', 2.9)).toEqual({ match_key: '2026cc_practice_3', label: 'Practice 3', number: 3 });
  });
});
