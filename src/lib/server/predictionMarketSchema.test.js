import { describe, expect, it } from 'vitest';
import { normalizeBetRequest } from './predictionMarketSchema.js';

describe('normalizeBetRequest', () => {
  it('normalizes a valid bet, rounding stake to cents', () => {
    const { value, error } = normalizeBetRequest({ event_key: ' 2026arc ', match_key: '2026arc_qm12', side: 'RED', stake: '50.017' });
    expect(error).toBeNull();
    expect(value).toEqual({ event_key: '2026arc', match_key: '2026arc_qm12', side: 'red', stake: 50.02 });
  });

  it('requires event_key, a plausible match_key, a red/blue side, and a positive stake', () => {
    expect(normalizeBetRequest({ match_key: '2026arc_qm12', side: 'red', stake: 10 }).error).toMatch(/event_key/);
    expect(normalizeBetRequest({ event_key: 'x', match_key: 'not a key', side: 'red', stake: 10 }).error).toMatch(/match_key/);
    expect(normalizeBetRequest({ event_key: 'x', match_key: 'x_qm12', side: 'green', stake: 10 }).error).toMatch(/side/);
    expect(normalizeBetRequest({ event_key: 'x', match_key: 'x_qm12', side: 'red', stake: 0 }).error).toMatch(/stake/);
    expect(normalizeBetRequest({ event_key: 'x', match_key: 'x_qm12', side: 'red', stake: -5 }).error).toMatch(/stake/);
  });

  it('rejects a match_key that does not belong to the given event_key', () => {
    // A plausible-looking key from a DIFFERENT event must not be accepted -
    // otherwise a bet could get scoped to the wrong event's leaderboard.
    expect(normalizeBetRequest({ event_key: '2026arc', match_key: '2026casj_qm12', side: 'red', stake: 10 }).error)
      .toMatch(/match_key must belong/);
  });

  it('rejects a stake beyond the hard sanity ceiling, independent of any balance check', () => {
    expect(normalizeBetRequest({ event_key: '2026arc', match_key: '2026arc_qm12', side: 'red', stake: 2_000_000 }).error)
      .toMatch(/stake cannot exceed/);
  });
});
