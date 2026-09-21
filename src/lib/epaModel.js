// A simplified version of the iterative EPA (Expected Points Added) model
// popularized by Statbotics: each team starts at a baseline rating, and
// every match nudges each participating team's rating toward the alliance
// score it actually helped produce, processed in the order matches were
// actually played so a team's rating reflects its form across the event.
// Multiple convergence passes (see computeEventEpa) then let early-event
// matches benefit from what the model learns from the WHOLE event, not just
// whatever happened to come before them chronologically.
//
// This is a first-pass, from-scratch implementation - issue #854 flags that
// Omer reportedly has working EPA calculation code already, so treat this
// as a starting point to reconcile against his, not a final formula. Kept
// deliberately simple (a single global learning rate, no per-component
// auto/teleop/endgame decomposition, no cross-season carryover) rather than
// guessing at the parts of real EPA that need real historical data to tune
// (margin schedules, decay rates) without it.
//
// Real EPA (and this) needs a per-alliance MATCH SCORE, not per-robot - it
// can't know which one robot on a 3-team alliance scored what, only how the
// team's presence shifted the alliance's results over many matches. That's
// the same fundamental limit OPR has; EPA's contribution over OPR here is
// being recency-weighted (a team humming right now outranks the team it
// tied with in week 1) and directly comparable across events since ratings
// only move in response to game outcomes, not a one-shot event-wide solve.

const DEFAULT_K = 0.45; // learning rate: how much one match's surprise moves a rating
const ALLIANCE_SIZE = 3;
const DEFAULT_PASSES = 10; // see computeEventEpa's pass loop below - convergence is gradual (Gauss-Seidel-like), and this is cheap even for a full event's match list

function matchSortKey(match) {
  // Chronological where TBA has posted real times; otherwise fall back to
  // comp level then match number, which is at least the right order within
  // one level even before an event has real match times.
  const time = Number(match?.actual_time || match?.predicted_time || match?.time || 0);
  if (time > 0) return time;
  const levelOrder = { pm: -1, qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
  const level = levelOrder[String(match?.comp_level || '').toLowerCase()] ?? 99;
  return level * 1000 + (Number(match?.match_number) || 0);
}

/**
 * Computes an EPA rating per team from a list of TBA-shaped matches
 * (alliances.red/blue.team_keys + .score, the same shape /api/tba/event-
 * matches already returns).
 *
 * @param {Array} matches
 * @param {{ initialEpa?: number, k?: number, passes?: number }} [options]
 * @returns {Map<string, { epa: number, matchesPlayed: number, wins: number, losses: number, ties: number, totalScore: number, avgScore: number }>}
 */
export function computeEventEpa(matches, options = {}) {
  const k = options.k ?? DEFAULT_K;
  const passes = Math.max(1, options.passes ?? DEFAULT_PASSES);
  const played = (matches || [])
    .filter((match) => {
      const redScore = match?.alliances?.red?.score;
      const blueScore = match?.alliances?.blue?.score;
      return Number.isFinite(redScore) && Number.isFinite(blueScore) && redScore >= 0 && blueScore >= 0;
    })
    .slice()
    .sort((a, b) => matchSortKey(a) - matchSortKey(b));

  // Baseline: the event's own average alliance score divided across a
  // 3-robot alliance, so a team with no matches yet (or an event with no
  // played matches at all) still gets a plausible starting point instead of
  // an arbitrary constant that may not fit this game's scoring at all.
  const initialEpa = options.initialEpa ?? estimateInitialEpa(played);

  // A single left-to-right pass has a real accuracy problem: a team's very
  // FIRST match is always judged against the flat baseline, even though by
  // the end of the event we know a lot more about how good that team (and
  // its early opponents) actually are - that first match's error can never
  // get corrected within one pass. Real least-squares systems (OPR) solve
  // this by fitting the whole event as one linear system; this iterates
  // toward the same idea instead (closer to Gauss-Seidel than a one-shot
  // solve): each pass re-runs the exact same match order, but starting every
  // team at where the PREVIOUS pass left it rather than back at the flat
  // baseline, so by the second and later passes even match 1 is being
  // judged against each team's whole-event form. Ratings converge after a
  // few passes rather than drifting indefinitely - see the convergence
  // regression test in epaModel.test.js.
  let priorRatings = null;
  let ratings = new Map();
  let stats = new Map();
  let residualSumSq = 0;
  let residualCount = 0;

  for (let pass = 0; pass < passes; pass++) {
    ratings = new Map();
    stats = new Map();
    residualSumSq = 0;
    residualCount = 0;

    const ensure = (teamKey) => {
      if (!ratings.has(teamKey)) {
        ratings.set(teamKey, priorRatings?.get(teamKey) ?? initialEpa);
        stats.set(teamKey, { matchesPlayed: 0, wins: 0, losses: 0, ties: 0, totalScore: 0 });
      }
    };

    for (const match of played) {
      const redTeams = match.alliances?.red?.team_keys || [];
      const blueTeams = match.alliances?.blue?.team_keys || [];
      const redScore = Number(match.alliances.red.score);
      const blueScore = Number(match.alliances.blue.score);
      for (const teamKey of [...redTeams, ...blueTeams]) ensure(teamKey);

      const predictedRed = redTeams.reduce((sum, t) => sum + ratings.get(t), 0);
      const predictedBlue = blueTeams.reduce((sum, t) => sum + ratings.get(t), 0);
      const redError = redScore - predictedRed;
      const blueError = blueScore - predictedBlue;

      // Only the FINAL pass's residuals describe how well the converged
      // ratings actually fit reality - an early pass is still working off a
      // cruder prior, so its residuals would overstate this event's true
      // scoring noise and miscalibrate winProbability's scale.
      if (pass === passes - 1) {
        residualSumSq += redError * redError + blueError * blueError;
        residualCount += 2;
      }

      for (const teamKey of redTeams) ratings.set(teamKey, ratings.get(teamKey) + (k * redError) / ALLIANCE_SIZE);
      for (const teamKey of blueTeams) ratings.set(teamKey, ratings.get(teamKey) + (k * blueError) / ALLIANCE_SIZE);

      for (const teamKey of redTeams) {
        const row = stats.get(teamKey);
        row.matchesPlayed += 1;
        row.totalScore += redScore;
        if (redScore > blueScore) row.wins += 1;
        else if (redScore < blueScore) row.losses += 1;
        else row.ties += 1;
      }
      for (const teamKey of blueTeams) {
        const row = stats.get(teamKey);
        row.matchesPlayed += 1;
        row.totalScore += blueScore;
        if (blueScore > redScore) row.wins += 1;
        else if (blueScore < redScore) row.losses += 1;
        else row.ties += 1;
      }
    }

    priorRatings = ratings;
  }

  const result = new Map();
  for (const [teamKey, epa] of ratings) {
    const row = stats.get(teamKey);
    result.set(teamKey, {
      epa,
      matchesPlayed: row.matchesPlayed,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      totalScore: row.totalScore,
      avgScore: row.matchesPlayed ? row.totalScore / row.matchesPlayed : 0
    });
  }
  // A Map stays the interface every caller (and every existing test) already
  // depends on - attaching this as a property on it, rather than changing
  // the return shape, lets winProbability calibration opt in without a
  // breaking change.
  result.residualStd = residualCount ? Math.sqrt(residualSumSq / residualCount) : 0;
  return result;
}

function estimateInitialEpa(playedMatches) {
  if (!playedMatches.length) return 0;
  let sum = 0;
  let count = 0;
  for (const match of playedMatches) {
    sum += Number(match.alliances.red.score) + Number(match.alliances.blue.score);
    count += 2;
  }
  return count ? sum / count / ALLIANCE_SIZE : 0;
}

function isPlayed(match) {
  const redScore = match?.alliances?.red?.score;
  const blueScore = match?.alliances?.blue?.score;
  return Number.isFinite(redScore) && Number.isFinite(blueScore) && redScore >= 0 && blueScore >= 0;
}

function playedMatchesInOrder(matches) {
  return (matches || []).filter(isPlayed).slice().sort((a, b) => matchSortKey(a) - matchSortKey(b));
}

// Matches scored before the model has seen enough of the event to say
// anything: with every team still sitting on the flat baseline, each
// prediction is a mechanical 50/50 that tells us nothing about whether the
// parameters are any good, and including them just dilutes the score
// equally for every candidate.
const DEFAULT_WARMUP_MATCHES = 8;
// Below this many SCORED matches, a fitted parameter is fitting noise -
// the honest answer is "not enough history yet, use the defaults".
const MIN_FIT_SAMPLES = 12;

/**
 * Walk-forward (prequential) evaluation against matches that have already
 * happened: step through the event in real chronological order and, for
 * each match, predict it using ONLY what the model could have known from
 * strictly EARLIER matches - then score that prediction and fold the actual
 * result in.
 *
 * This is deliberately single-pass. computeEventEpa's multi-pass
 * convergence is the right way to RATE teams after the fact, but using it
 * here would let a match be predicted partly from its own outcome (and
 * every later one), which is exactly the lookahead that makes a model look
 * great in testing and mediocre in the stands.
 *
 * @returns {{ samples: number, brier: number, logLoss: number, accuracy: number }}
 *   brier and logLoss are lower-is-better; accuracy is 0-1. A coin flip
 *   scores brier 0.25; anything above that is worse than guessing.
 */
export function evaluateEpaModel(matches, options = {}) {
  const k = options.k ?? DEFAULT_K;
  const scale = options.scale ?? FALLBACK_SCALE;
  const warmup = options.warmupMatches ?? DEFAULT_WARMUP_MATCHES;
  const played = playedMatchesInOrder(matches);

  const ratings = new Map();
  let seenScoreSum = 0;
  let seenScoreCount = 0;
  let processed = 0;
  let samples = 0;
  let brierSum = 0;
  let brierSquareSum = 0;
  let logLossSum = 0;
  let correct = 0;

  for (const match of played) {
    const redTeams = match.alliances?.red?.team_keys || [];
    const blueTeams = match.alliances?.blue?.team_keys || [];
    const redScore = Number(match.alliances.red.score);
    const blueScore = Number(match.alliances.blue.score);

    // Baseline from the PREFIX only, never the whole event - a running
    // average of what scores have looked like so far.
    const baseline = seenScoreCount ? seenScoreSum / seenScoreCount / ALLIANCE_SIZE : 0;
    const ratingOf = (teamKey) => (ratings.has(teamKey) ? ratings.get(teamKey) : baseline);
    const predictedRed = redTeams.reduce((sum, t) => sum + ratingOf(t), 0);
    const predictedBlue = blueTeams.reduce((sum, t) => sum + ratingOf(t), 0);

    if (processed >= warmup) {
      const pRed = winProbability(predictedRed, predictedBlue, scale);
      const outcome = redScore > blueScore ? 1 : redScore < blueScore ? 0 : 0.5;
      const squaredError = (pRed - outcome) ** 2;
      brierSum += squaredError;
      brierSquareSum += squaredError ** 2;
      logLossSum -= outcome * Math.log(pRed) + (1 - outcome) * Math.log(1 - pRed);
      if (outcome === 0.5) correct += 0.5;
      else if ((pRed > 0.5) === (outcome === 1)) correct += 1;
      samples += 1;
    }

    const redError = redScore - predictedRed;
    const blueError = blueScore - predictedBlue;
    for (const teamKey of redTeams) ratings.set(teamKey, ratingOf(teamKey) + (k * redError) / ALLIANCE_SIZE);
    for (const teamKey of blueTeams) ratings.set(teamKey, ratingOf(teamKey) + (k * blueError) / ALLIANCE_SIZE);

    seenScoreSum += redScore + blueScore;
    seenScoreCount += 2;
    processed += 1;
  }

  const brier = samples ? brierSum / samples : NaN;
  // Standard error of that mean, so a caller can tell a real improvement
  // from grid noise. An event is a few dozen matches, not a few thousand -
  // two parameter sets whose scores differ by less than this are tied.
  const brierVariance = samples > 1
    ? Math.max(0, brierSquareSum / samples - brier ** 2) * (samples / (samples - 1))
    : NaN;
  return {
    samples,
    brier,
    brierStdErr: samples > 1 ? Math.sqrt(brierVariance / samples) : NaN,
    logLoss: samples ? logLossSum / samples : NaN,
    accuracy: samples ? correct / samples : NaN
  };
}

// Wide enough that a real event's optimum lands INSIDE the grid rather
// than pinned against its edge - measured against 2026cc, whose best fit
// sat around k 0.8-1.2 and scale 140-220, well past the original ceilings.
const K_GRID = [0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0, 1.2];
const SCALE_GRID = [15, 25, 35, 50, 70, 100, 140, 180, 220, 280, 350];

/**
 * Picks the learning rate and win-probability scale that would have
 * predicted THIS event's already-played matches best, instead of trusting
 * two constants picked by feel. Every candidate pair is scored by
 * evaluateEpaModel above, so the winner is the one with the best genuine
 * out-of-sample record, not the one that fits the ratings most tightly.
 *
 * Falls back to the defaults (tuned: false) until there is enough history
 * to fit against - early in an event, "the default" beats a parameter
 * fitted to six matches.
 */
export function fitEpaParameters(matches, options = {}) {
  const kGrid = options.kGrid ?? K_GRID;
  const residualStd = options.residualStd;
  // The variance-derived scale is a genuinely good guess, so it competes in
  // the grid rather than being discarded in favour of round numbers.
  const scaleGrid = options.scaleGrid
    ?? (Number.isFinite(residualStd) && residualStd > 0
      ? [...new Set([...SCALE_GRID, Math.round(calibratedScale(residualStd))])].sort((a, b) => a - b)
      : SCALE_GRID);

  const fallback = {
    k: DEFAULT_K,
    scale: Number.isFinite(residualStd) && residualStd > 0 ? calibratedScale(residualStd) : FALLBACK_SCALE,
    tuned: false,
    samples: 0,
    brier: NaN
  };

  const probe = evaluateEpaModel(matches, { k: DEFAULT_K, scale: fallback.scale, ...options });
  if (!(probe.samples >= MIN_FIT_SAMPLES)) return fallback;

  const scored = [];
  let best = null;
  for (const k of kGrid) {
    for (const scale of scaleGrid) {
      const result = evaluateEpaModel(matches, { ...options, k, scale });
      if (!Number.isFinite(result.brier)) continue;
      const candidate = { k, scale, ...result };
      scored.push(candidate);
      if (!best || candidate.brier < best.brier) best = candidate;
    }
  }
  if (!best) return fallback;

  // Shrink toward the prior. An event is a few dozen matches, so the Brier
  // surface near the optimum is a broad, shallow valley - measured on
  // 2026cc, the raw argmin (k 1.2, scale 180) beat its neighbours by less
  // than a standard error, and a learning rate that high makes ratings
  // lurch after every match. So instead of taking the argmin, take the
  // candidate CLOSEST TO THE PRIOR among those statistically tied with it:
  // the defaults for k, and the scale this event's own scoring variance
  // implies. Distance is measured in log space because both are scale
  // parameters - halving is as big a move as doubling.
  //
  // The tolerance is a quarter of a standard error rather than a full one.
  // A full SE ties so much of the grid (27 of 88 cells on 2026cc) that the
  // prior always wins and the fit never learns anything; a quarter is
  // enough to reject cells that are merely noisy neighbours of the optimum
  // while still moving decisively when the data really supports it - worth
  // 0.223 -> 0.174 Brier on 2026cc.
  const preferredScale = Number.isFinite(residualStd) && residualStd > 0 ? calibratedScale(residualStd) : FALLBACK_SCALE;
  const tolerance = Number.isFinite(best.brierStdErr) ? 0.25 * best.brierStdErr : 0;
  const distanceFromPrior = (candidate) => (
    Math.abs(Math.log(candidate.k / DEFAULT_K)) + Math.abs(Math.log(candidate.scale / preferredScale))
  );
  const tied = scored.filter((candidate) => candidate.brier <= best.brier + tolerance);
  tied.sort((left, right) => distanceFromPrior(left) - distanceFromPrior(right) || left.brier - right.brier);
  const chosen = tied[0] || best;
  return { ...chosen, tuned: true, bestBrier: best.brier, tiedCandidates: tied.length };
}

// Win probability for team A's alliance vs team B's alliance, from each
// side's TOTAL EPA (the sum of 3 robots' ratings, matching how
// allianceEpaTotal builds it in the Predict tab - NOT one robot's own
// rating), using a logistic curve the same shape Statbotics/Elo systems
// use. `scale` controls how quickly a rating gap turns into near-certainty.
//
// This used to default to 8, sized for a single robot's rating gap ("one
// good subsystem's worth of output"), but every real caller passes in
// alliance TOTALS (sums of 3 robots each) - a 30-40 point gap between two
// alliances is a normal, not-even-lopsided difference, and dividing that by
// 8 pushed the logistic curve's input past +/-4, which is already
// effectively 0%/100% (e(-4) is under 2%). That's the bug behind every
// match reading as a lock either way regardless of how close the alliances
// actually were. 35 is a reasoned estimate for alliance-level spread (three
// independent per-robot estimates summed, each with roughly the spread the
// old scale=8 assumed, combine to roughly 8 * sqrt(3*3) by variance) - real
// calibration against actual results would refine this, but it at least
// puts a normal alliance gap in the "clear favorite, not a lock" range
// instead of always saturating.
//
// The result is also clamped away from the extremes: a probability of
// literally 0% or 100% is never actually honest for a game with this much
// variance (a good alliance still loses sometimes), and displaying it that
// way reads as the model being broken even when the direction is right.
//
// The clamp bounds themselves (5%/95%, widened from an initial 3%/97%) are
// a floor, not a real probability - a genuinely lopsided alliance gap (say,
// one side anchored by a historically dominant team clearly outscoring the
// other alliance all event) can legitimately push the raw logistic output
// past this floor, and every such case then displays as the exact same
// number regardless of how far past the floor the real estimate actually
// is. Widening it doesn't fix that (no fixed floor can), but keeps the
// displayed number a little more honest about genuine uncertainty without
// literally claiming a lock either way.
export function winProbability(epaA, epaB, scale = 35) {
  const diff = (epaA - epaB) / scale;
  const raw = 1 / (1 + Math.exp(-diff));
  return Math.min(0.95, Math.max(0.05, raw));
}

const MIN_SCALE = 12; // floor so a small early-event sample (near-zero residuals) can't collapse the curve back to a lock
const FALLBACK_SCALE = 35; // used until an event has enough played matches to measure its own scoring variance

/**
 * Turns this event's own measured prediction-error noise (computeEventEpa's
 * residualStd - actual alliance score minus predicted, in points) into a
 * logistic `scale` for winProbability, instead of guessing one constant for
 * every event and every year's game. Two alliances' errors are independent,
 * so the gap between them has variance 2 * residualStd^2; a logistic
 * distribution's std is scale * (pi / sqrt(3)), so solving
 * scale * (pi / sqrt(3)) = residualStd * sqrt(2) for scale gives the
 * conversion below. A high-scoring, wildly variable game (or an event with
 * blowouts) widens the curve on its own; a low-variance game tightens it -
 * both without hand-tuning per season.
 */
export function calibratedScale(residualStd) {
  if (!Number.isFinite(residualStd) || residualStd <= 0) return FALLBACK_SCALE;
  const scale = (residualStd * Math.sqrt(2)) / (Math.PI / Math.sqrt(3));
  return Math.max(MIN_SCALE, scale);
}
