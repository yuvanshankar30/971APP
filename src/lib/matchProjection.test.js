import { describe, expect, it } from 'vitest';
import { allianceStrength, isMatchPlayed, matchLabel, projectMatch } from './matchProjection.js';

describe('allianceStrength', () => {
  it('sums known team power and defaults an unscouted team to average (50)', () => {
    const scoutPower = new Map([['frc1', 80], ['frc2', 60]]);
    expect(allianceStrength(['frc1', 'frc2', 'frc3'], scoutPower)).toBe(80 + 60 + 50);
  });

  it('returns null when nothing about the alliance is known yet', () => {
    expect(allianceStrength(['frc9', 'frc8', 'frc7'], new Map())).toBeNull();
  });
});

describe('projectMatch', () => {
  const scoutPower = new Map([['frc1', 80], ['frc2', 80], ['frc3', 80], ['frc4', 20], ['frc5', 20], ['frc6', 20]]);
  const match = { alliances: { red: { team_keys: ['frc1', 'frc2', 'frc3'] }, blue: { team_keys: ['frc4', 'frc5', 'frc6'] } } };

  it('favors the stronger alliance with a probability above 50%', () => {
    const { redWinProbability } = projectMatch(match, scoutPower);
    expect(redWinProbability).toBeGreaterThan(0.5);
    expect(redWinProbability).toBeLessThan(1);
  });

  it('gives an even match exactly 50/50', () => {
    const evenMatch = { alliances: { red: { team_keys: ['frc1'] }, blue: { team_keys: ['frc2'] } } };
    expect(projectMatch(evenMatch, scoutPower).redWinProbability).toBeCloseTo(0.5);
  });

  it('projects nothing when an alliance has no scouted teams at all', () => {
    const unknownMatch = { alliances: { red: { team_keys: ['frc1'] }, blue: { team_keys: ['frc999'] } } };
    expect(projectMatch(unknownMatch, new Map([['frc1', 80]])).redWinProbability).toBeNull();
  });
});

describe('isMatchPlayed', () => {
  it('is true only once TBA reports an actual play time', () => {
    expect(isMatchPlayed({ actual_time: 1700000000 })).toBe(true);
    expect(isMatchPlayed({ actual_time: null, winning_alliance: '' })).toBe(false);
  });
});

describe('matchLabel', () => {
  it('formats qual and playoff matches readably', () => {
    expect(matchLabel({ comp_level: 'qm', match_number: 12 })).toBe('Qual 12');
    expect(matchLabel({ comp_level: 'sf', set_number: 2, match_number: 1 })).toBe('Semifinal 2-1');
    expect(matchLabel({ comp_level: 'f', set_number: 1, match_number: 3 })).toBe('Final 3');
  });
});
