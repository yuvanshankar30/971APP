import { describe, expect, it } from 'vitest';
import { buildModelVotes, modelVoteForMatch, publicAnonymousVote } from './predictionMarketModelVote.js';

const match = (key, red, blue, extra = {}) => ({
  key,
  alliances: { red: { team_keys: red, score: -1 }, blue: { team_keys: blue, score: -1 } },
  actual_time: null,
  predicted_time: 2_000,
  time: 2_000,
  ...extra
});

describe('private prediction-market model vote', () => {
  it('votes for the higher-rated alliance without returning its probability', () => {
    const ratings = new Map([
      ['frc1', { epa: 30 }], ['frc2', { epa: 20 }],
      ['frc3', { epa: 10 }], ['frc4', { epa: 5 }]
    ]);
    ratings.residualStd = 10;
    expect(modelVoteForMatch(match('event_qm1', ['frc1', 'frc2'], ['frc3', 'frc4']), ratings)).toEqual({ side: 'red' });
  });

  it('only creates fixed-stake votes for unlocked matches with enough evidence', () => {
    const played = {
      key: 'event_qm0', actual_time: 500,
      alliances: { red: { team_keys: ['frc1'], score: 30 }, blue: { team_keys: ['frc2'], score: 10 } }
    };
    const votes = buildModelVotes([
      played,
      match('event_qm1', ['frc1'], ['frc2']),
      match('event_qm2', ['frc1'], ['frc2'], { predicted_time: 900 })
    ], { stake: 75, nowSeconds: 1_000 });
    expect(votes).toEqual([{ match_key: 'event_qm1', side: 'red', stake: 75 }]);
  });

  it('removes every system/source marker from the public row', () => {
    const output = publicAnonymousVote({
      id: 'secret-id', event_key: 'event', match_key: 'event_qm1', side: 'blue', stake: 100,
      placed_at: 'now', updated_at: 'now', resolved_at: null, payout: null, winning_side: null,
      source: 'model', probability: 0.83
    });
    expect(output).toMatchObject({ id: 'secret-id', created_by: null, side: 'blue', stake: 100 });
    expect(output).not.toHaveProperty('source');
    expect(output).not.toHaveProperty('probability');
  });
});
