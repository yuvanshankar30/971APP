import { describe, expect, it } from 'vitest';
import { computeEventEpa, winProbability, calibratedScale } from './epaModel.js';

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

  describe('multi-pass convergence', () => {
    // A deterministic round-robin where every match's score is EXACTLY the
    // sum of each participating team's true rating - the same kind of
    // well-conditioned system OPR solves exactly with linear algebra. A
    // single left-to-right pass can't fully recover these because match 1's
    // teams are judged against the flat baseline before anyone's true
    // rating is known; more passes should visibly close that gap.
    const trueEpa = { frc1: 100, frc2: 90, frc3: 80, frc4: 70, frc5: 60, frc6: 50 };
    const scoreOf = (teamKeys) => teamKeys.reduce((sum, key) => sum + trueEpa[key], 0);
    const roundRobin = [
      { red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'] },
      { red: ['frc1', 'frc4', 'frc5'], blue: ['frc2', 'frc3', 'frc6'] },
      { red: ['frc2', 'frc5', 'frc6'], blue: ['frc1', 'frc3', 'frc4'] },
      { red: ['frc3', 'frc4', 'frc6'], blue: ['frc1', 'frc2', 'frc5'] },
      { red: ['frc1', 'frc3', 'frc5'], blue: ['frc2', 'frc4', 'frc6'] },
      { red: ['frc1', 'frc2', 'frc6'], blue: ['frc3', 'frc4', 'frc5'] }
    ].map((sides, index) => match({
      red: sides.red,
      blue: sides.blue,
      redScore: scoreOf(sides.red),
      blueScore: scoreOf(sides.blue),
      matchNumber: index + 1
    }));

    it('fits the observed scores at least as well with more passes (residualStd does not get worse)', () => {
      const onePass = computeEventEpa(roundRobin, { passes: 1 });
      const manyPasses = computeEventEpa(roundRobin, { passes: 8 });
      expect(manyPasses.residualStd).toBeLessThan(onePass.residualStd);
    });

    it('keeps converging rather than drifting further apart as passes increase', () => {
      // This iteration is closer to Gauss-Seidel than a one-shot least-
      // squares solve, so it converges gradually rather than snapping to the
      // exact answer in a couple of passes - the property that actually
      // matters is that later passes move ratings LESS than earlier ones
      // (settling), not that any fixed pass count is already "done".
      const totalDelta = (a, b) => [...a.keys()].reduce((sum, team) => sum + Math.abs(a.get(team).epa - b.get(team).epa), 0);
      const p10 = computeEventEpa(roundRobin, { passes: 10 });
      const p20 = computeEventEpa(roundRobin, { passes: 20 });
      const p40 = computeEventEpa(roundRobin, { passes: 40 });
      expect(totalDelta(p20, p40)).toBeLessThan(totalDelta(p10, p20));
    });
  });

  it('attaches residualStd measuring how well ratings predicted actual scores', () => {
    // Every match ties the baseline exactly, so once ratings settle near
    // that baseline the prediction error should be small and stable.
    const matches = [
      match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'], redScore: 90, blueScore: 90, matchNumber: 1 }),
      match({ red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'], redScore: 90, blueScore: 90, matchNumber: 2 })
    ];
    const result = computeEventEpa(matches);
    expect(Number.isFinite(result.residualStd)).toBe(true);
    expect(result.residualStd).toBeGreaterThanOrEqual(0);
  });

  it('residualStd is 0 for an event with no played matches', () => {
    expect(computeEventEpa([]).residualStd).toBe(0);
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

describe('calibratedScale', () => {
  it('falls back to the default scale when there is no measured variance yet', () => {
    expect(calibratedScale(0)).toBe(35);
    expect(calibratedScale(undefined)).toBe(35);
    expect(calibratedScale(NaN)).toBe(35);
  });

  it('widens for a noisier (higher residualStd) event and tightens for a calmer one', () => {
    const noisy = calibratedScale(40);
    const calm = calibratedScale(5);
    expect(noisy).toBeGreaterThan(calm);
  });

  it('never drops below the floor even for a near-zero but nonzero residualStd', () => {
    expect(calibratedScale(0.01)).toBeGreaterThanOrEqual(12);
  });
});
