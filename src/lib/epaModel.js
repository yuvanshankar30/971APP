// A simplified version of the iterative EPA (Expected Points Added) model
// popularized by Statbotics: each team starts at a baseline rating, and
// every match nudges each participating team's rating toward the alliance
// score it actually helped produce, processed in the order matches were
// actually played so a team's rating reflects its form across the event.
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
 * @param {{ initialEpa?: number, k?: number }} [options]
 * @returns {Map<string, { epa: number, matchesPlayed: number, wins: number, losses: number, ties: number, totalScore: number, avgScore: number }>}
 */
export function computeEventEpa(matches, options = {}) {
  const k = options.k ?? DEFAULT_K;
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

  const ratings = new Map();
  const stats = new Map();

  function ensure(teamKey) {
    if (!ratings.has(teamKey)) {
      ratings.set(teamKey, initialEpa);
      stats.set(teamKey, { matchesPlayed: 0, wins: 0, losses: 0, ties: 0, totalScore: 0 });
    }
  }

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
export function winProbability(epaA, epaB, scale = 35) {
  const diff = (epaA - epaB) / scale;
  const raw = 1 / (1 + Math.exp(-diff));
  return Math.min(0.97, Math.max(0.03, raw));
}
