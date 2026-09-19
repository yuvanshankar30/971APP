import { describe, expect, it } from 'vitest';
import { matchDisplayName, selectCurrentEventMatch } from './currentEventMatch.js';

const match = (number, extra = {}) => ({
  key: `2026cc_qm${number}`,
  comp_level: 'qm',
  set_number: 1,
  match_number: number,
  predicted_time: 1_800_000_000 + number * 600,
  actual_time: null,
  post_result_time: null,
  ...extra
});

describe('current TBA event match', () => {
  it('selects the first unplayed match even when TBA returns matches out of order', () => {
    const result = selectCurrentEventMatch([
      match(3), match(1, { actual_time: 1_800_000_100 }), match(2)
    ], 1_800_001_150);
    expect(result.match.key).toBe('2026cc_qm2');
    expect(result.state).toBe('current');
  });

  it('labels a future match as upcoming and a finished event as complete', () => {
    expect(selectCurrentEventMatch([match(1)], 1_700_000_000).state).toBe('upcoming');
    const finished = selectCurrentEventMatch([
      match(1, { actual_time: 10 }), match(2, { actual_time: 20 })
    ], 30);
    expect(finished).toMatchObject({ state: 'complete', match: { match_number: 2 } });
  });

  it('formats qualification and playoff match numbers without losing round structure', () => {
    expect(matchDisplayName(match(7))).toBe('Qualification 7');
    expect(matchDisplayName({ comp_level: 'sf', set_number: 2, match_number: 1 })).toBe('Semifinal 2-1');
  });
});
