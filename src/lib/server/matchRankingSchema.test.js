import { describe, expect, it } from 'vitest';
import { normalizeMatchRanking } from './matchRankingSchema.js';

describe('normalizeMatchRanking', () => {
  const base = { event_key: '2026casj', match_key: '2026casj_qm4', ranked_team_keys: ['254', 'frc4414', '2910'] };

  it('normalizes a complete ordered match result and identifies its editor', () => {
    const { value, error } = normalizeMatchRanking(base, 'scout-1');
    expect(error).toBeNull();
    expect(value).toMatchObject({
      event_key: '2026casj', match_key: '2026casj_qm4',
      ranked_team_keys: ['frc254', 'frc4414', 'frc2910'],
      updated_by: 'scout-1'
    });
  });

  it('rejects incomplete, duplicate, and oversized orders', () => {
    expect(normalizeMatchRanking({ ...base, ranked_team_keys: ['254'] }, 'scout-1').error).toMatch(/at least two/i);
    expect(normalizeMatchRanking({ ...base, ranked_team_keys: ['254', '254'] }, 'scout-1').error).toMatch(/only once/i);
    expect(normalizeMatchRanking({ ...base, ranked_team_keys: ['1', '2', '3', '4', '5', '6', '7'] }, 'scout-1').error).toMatch(/at most six/i);
  });
});
