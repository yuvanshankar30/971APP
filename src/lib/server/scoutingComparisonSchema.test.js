import { describe, expect, it } from 'vitest';
import { normalizePairwiseVote } from './scoutingComparisonSchema.js';

describe('normalizePairwiseVote', () => {
  it('normalizes and orders a valid team pair without changing the winner', () => {
    const { value, error } = normalizePairwiseVote({
      event_key: ' 2026casj ',
      team_a_key: 'frc971',
      team_b_key: '254',
      winner_team_key: '971'
    }, 'user-1');

    expect(error).toBeNull();
    expect(value).toMatchObject({
      event_key: '2026casj',
      team_a_key: 'frc254',
      team_b_key: 'frc971',
      winner_team_key: 'frc971',
      created_by: 'user-1'
    });
  });

  it('rejects duplicate teams and a winner outside the pair', () => {
    expect(normalizePairwiseVote({
      event_key: '2026casj', team_a_key: '971', team_b_key: 'frc971', winner_team_key: '971'
    }, 'user-1').error).toMatch(/different/);
    expect(normalizePairwiseVote({
      event_key: '2026casj', team_a_key: '971', team_b_key: '254', winner_team_key: '1678'
    }, 'user-1').error).toMatch(/winner_team_key/);
  });

  it('requires an event, valid teams, and an authenticated scout', () => {
    expect(normalizePairwiseVote({ team_a_key: '971', team_b_key: '254', winner_team_key: '971' }, 'user-1').error).toMatch(/event_key/);
    expect(normalizePairwiseVote({ event_key: 'x', team_a_key: 'bad', team_b_key: '254', winner_team_key: '254' }, 'user-1').error).toMatch(/valid team/);
    expect(normalizePairwiseVote({ event_key: 'x', team_a_key: '971', team_b_key: '254', winner_team_key: '254' }, null).error).toMatch(/authenticated/);
  });
});
