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
// side's total EPA, using a logistic curve the same shape Statbotics/Elo
// systems use - `scale` controls how quickly a rating gap turns into
// near-certainty; 8 points of EPA gap (roughly one good subsystem's worth
// of output in most FRC games) reads as a clear but not lopsided favorite
// with the default.
export function winProbability(epaA, epaB, scale = 8) {
  const diff = (epaA - epaB) / scale;
  return 1 / (1 + Math.exp(-diff));
}
