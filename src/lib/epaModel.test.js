import { describe, expect, it } from 'vitest';
import { computeEventEpa, winProbability } from './epaModel.js';

function match({ red, blue, redScore, blueScore, matchNumber, compLevel = 'qm' }) {
  return {
    comp_level: compLevel,
    match_number: matchNumber,
    alliances: {
      red: { team_keys: red, score: redScore },
      blue: { team_keys: blue, score: blueScore }
    }
  };
}

describe('computeEventEpa', () => {
  it('returns an empty map for no matches', () => {
    expect(computeEventEpa([]).size).toBe(0);
  });

  it('ignores unplayed matches (missing or negative scores)', () => {
    const matches = [
      match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'], redScore: -1, blueScore: -1, matchNumber: 1 })
    ];
    const result = computeEventEpa(matches);
    expect(result.size).toBe(0);
  });

  it('moves a team\'s rating up after it outscores its baseline prediction', () => {
    const matches = [
      match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'], redScore: 300, blueScore: 90, matchNumber: 1 })
    ];
    const result = computeEventEpa(matches);
    const red1 = result.get('frc1').epa;
    const blue4 = result.get('frc4').epa;
    // The baseline (event average / 3) is identical for every team before
    // any match is processed, so the side that blew the baseline prediction
    // away should end up rated higher than the side that fell far short of it.
    expect(red1).toBeGreaterThan(blue4);
  });

  it('tracks matches played, win/loss/tie record, and average score per team', () => {
    const matches = [
      match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'], redScore: 100, blueScore: 80, matchNumber: 1 }),
      match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc7', 'frc8', 'frc9'], redScore: 60, blueScore: 60, matchNumber: 2 }),
      match({ red: ['frc4', 'frc5', 'frc6'], blue: ['frc1', 'frc2', 'frc3'], redScore: 120, blueScore: 90, matchNumber: 3 })
    ];
    const result = computeEventEpa(matches);
    const frc1 = result.get('frc1');
    expect(frc1.matchesPlayed).toBe(3);
    expect(frc1.wins).toBe(1);
    expect(frc1.losses).toBe(1);
    expect(frc1.ties).toBe(1);
    expect(frc1.totalScore).toBe(100 + 60 + 90);
    expect(frc1.avgScore).toBeCloseTo((100 + 60 + 90) / 3, 6);
  });

  it('processes matches in time order, not array order, when actual_time is present', () => {
    const early = { ...match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'], redScore: 50, blueScore: 50, matchNumber: 2 }), actual_time: 200 };
    const later = { ...match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'], redScore: 300, blueScore: 10, matchNumber: 1 }), actual_time: 100 };
    // Array order is [early, later] but actual_time says later happened
    // first - a team's final rating should reflect that real ordering.
    const inOrder = computeEventEpa([later, early]);
    const outOfOrder = computeEventEpa([early, later]);
    expect(outOfOrder.get('frc1').epa).toBeCloseTo(inOrder.get('frc1').epa, 9);
  });
});

describe('winProbability', () => {
  it('is 0.5 when both sides have equal EPA', () => {
    expect(winProbability(50, 50)).toBeCloseTo(0.5, 9);
  });

  it('favors the higher-EPA side', () => {
    expect(winProbability(60, 50)).toBeGreaterThan(0.5);
    expect(winProbability(40, 50)).toBeLessThan(0.5);
  });

  it('is symmetric', () => {
    const a = winProbability(70, 50);
    const b = winProbability(50, 70);
    expect(a + b).toBeCloseTo(1, 9);
  });

  // Regression test for the reported bug: every real caller (the Predict
  // tab) passes ALLIANCE TOTALS - the sum of 3 robots' EPA each, not one
  // robot's own rating - and the old default scale (8, sized for a single
  // robot) pushed any normal alliance-level gap past the point where the
  // logistic curve is already effectively 0%/100%, so every match looked
  // like a lock regardless of how close the alliances actually were.
  it('does not saturate to 0%/100% for a normal alliance-level EPA gap', () => {
    // Three teams around 100 EPA each vs three teams around 110 each - a
    // real, meaningfully-favored-but-not-lopsided alliance gap.
    const redTotal = 100 + 95 + 105;
    const blueTotal = 110 + 108 + 112;
    const prob = winProbability(redTotal, blueTotal);
    expect(prob).toBeGreaterThan(0.05);
    expect(prob).toBeLessThan(0.5);
  });

  it('clamps away from the literal extremes even for a huge gap', () => {
    expect(winProbability(1000, 0)).toBeLessThanOrEqual(0.97);
    expect(winProbability(0, 1000)).toBeGreaterThanOrEqual(0.03);
  });
});
