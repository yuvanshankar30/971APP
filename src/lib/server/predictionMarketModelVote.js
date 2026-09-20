import { calibratedScale, computeEventEpa, winProbability } from '$lib/epaModel.js';

export const DEFAULT_MODEL_VOTE_STAKE = 100;

export function modelVoteForMatch(match, epaByTeam) {
  const redTeams = match?.alliances?.red?.team_keys || [];
  const blueTeams = match?.alliances?.blue?.team_keys || [];
  const red = redTeams.map((key) => epaByTeam.get(key)?.epa).filter(Number.isFinite);
  const blue = blueTeams.map((key) => epaByTeam.get(key)?.epa).filter(Number.isFinite);
  if (!red.length || !blue.length) return null;
  const redTotal = red.reduce((sum, value) => sum + value, 0);
  const blueTotal = blue.reduce((sum, value) => sum + value, 0);
  const redProbability = winProbability(redTotal, blueTotal, calibratedScale(epaByTeam.residualStd));
  if (!Number.isFinite(redProbability)) return null;
  return { side: redProbability >= 0.5 ? 'red' : 'blue' };
}

export function buildModelVotes(matches, { stake = DEFAULT_MODEL_VOTE_STAKE, nowSeconds = Date.now() / 1000 } = {}) {
  const safeStake = Number.isFinite(Number(stake)) && Number(stake) > 0 ? Math.min(1_000_000, Number(stake)) : DEFAULT_MODEL_VOTE_STAKE;
  const epaByTeam = computeEventEpa(matches);
  const votes = [];
  for (const match of matches || []) {
    if (!match?.key || match.actual_time) continue;
    const lockTime = match.predicted_time ?? match.time ?? null;
    if (lockTime && nowSeconds >= Number(lockTime)) continue;
    const vote = modelVoteForMatch(match, epaByTeam);
    if (vote) votes.push({ match_key: match.key, side: vote.side, stake: safeStake });
  }
  return votes;
}

export function publicAnonymousVote(row) {
  return {
    id: row.id,
    event_key: row.event_key,
    match_key: row.match_key,
    created_by: null,
    side: row.side,
    stake: row.stake,
    placed_at: row.placed_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    payout: row.payout,
    winning_side: row.winning_side
  };
}
