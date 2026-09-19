import { describe, expect, it } from 'vitest';
import { teamMatchResult } from './driveTeamMatches.js';

const match = ({ red = ['frc971'], blue = ['frc254'], redScore = 0, blueScore = 0, winner = '' } = {}) => ({
  alliances: {
    red: { team_keys: red, score: redScore },
    blue: { team_keys: blue, score: blueScore }
  },
  winning_alliance: winner
});

describe('teamMatchResult', () => {
  it('reports a red-alliance 971 win with scores from 971 perspective', () => {
    expect(teamMatchResult(match({ redScore: 143, blueScore: 120, winner: 'red' }), 'frc971')).toEqual({
      alliance: 'red', outcome: 'win', ourScore: 143, opponentScore: 120
    });
  });

  it('reports a blue-alliance 971 loss', () => {
    expect(teamMatchResult(match({ red: ['frc254'], blue: ['frc971'], redScore: 152, blueScore: 148, winner: 'red' }), 'frc971')).toEqual({
      alliance: 'blue', outcome: 'loss', ourScore: 148, opponentScore: 152
    });
  });

  it('reports tied final scores when TBA has no winning alliance', () => {
    expect(teamMatchResult(match({ redScore: 130, blueScore: 130 }), 'frc971').outcome).toBe('tie');
  });

  it('does not treat TBA placeholder scores as a result', () => {
    expect(teamMatchResult(match({ redScore: -1, blueScore: -1 }), 'frc971')).toEqual({
      alliance: 'red', outcome: 'unknown', ourScore: null, opponentScore: null
    });
  });
});
