// A rough, honest approximation of match win likelihood from each team's
// existing Scout Power (0-100) - NOT a calibrated points/score model. This
// app has no per-game scoring configuration wired up yet (see the
// "Confirm the desired initial season/game scoring model" open decision in
// the Competition Workspace plan), so rather than invent one, this only
// ever compares relative team strength: alliance strength is the sum of its
// three teams' Scout Power, and win probability comes from a logistic curve
// over the strength gap (the same shape an Elo rating uses), loosely scaled
// rather than fit to real results. Good enough to rank matches by how close
// they look; not a promise about final score.
const STRENGTH_SPREAD = 25;

export function allianceStrength(teamKeys = [], scoutPowerByTeam = new Map()) {
  const known = teamKeys.filter((key) => Number.isFinite(scoutPowerByTeam.get(key)));
  if (!known.length) return null;
  // A team with no scouting data yet is assumed average (50) rather than 0,
  // so one un-scouted team doesn't collapse the whole alliance's estimate.
  return teamKeys.reduce((sum, key) => {
    const value = scoutPowerByTeam.get(key);
    return sum + (Number.isFinite(value) ? value : 50);
  }, 0);
}

// A rough predicted score for one alliance: the sum of each team's average
// scouted match points (auto + teleop balls), where known. Same "assume
// average" honesty rule as allianceStrength would apply, but here there's
// no meaningful "average points" to assume for an un-scouted team, so it's
// simply left out of the sum - a predicted score built from 2 of 3 teams is
// still informative, whereas inventing a fake baseline points value would
// not be.
export function allianceProjectedScore(teamKeys = [], projectedScoreByTeam = new Map()) {
  const known = teamKeys.map((key) => projectedScoreByTeam.get(key)).filter(Number.isFinite);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

export function projectMatch(match, scoutPowerByTeam = new Map(), projectedScoreByTeam = new Map()) {
  const redKeys = match?.alliances?.red?.team_keys || [];
  const blueKeys = match?.alliances?.blue?.team_keys || [];
  const redStrength = allianceStrength(redKeys, scoutPowerByTeam);
  const blueStrength = allianceStrength(blueKeys, scoutPowerByTeam);
  const redProjectedScore = allianceProjectedScore(redKeys, projectedScoreByTeam);
  const blueProjectedScore = allianceProjectedScore(blueKeys, projectedScoreByTeam);
  if (redStrength == null || blueStrength == null) {
    return { redStrength, blueStrength, redWinProbability: null, redProjectedScore, blueProjectedScore };
  }
  const redWinProbability = 1 / (1 + Math.pow(10, (blueStrength - redStrength) / STRENGTH_SPREAD));
  return { redStrength, blueStrength, redWinProbability, redProjectedScore, blueProjectedScore };
}

// TBA marks a match as actually played by having an actual_time; winning_alliance
// is '' both before a match starts and (rarely) on a genuine tie, so it alone
// can't distinguish "not played yet" from "no winner".
export function isMatchPlayed(match) {
  return Boolean(match?.actual_time);
}

export function matchLabel(match) {
  const level = { qm: 'Qual', ef: 'Octofinal', qf: 'Quarterfinal', sf: 'Semifinal', f: 'Final', pm: 'Practice', test: 'Test match' }[String(match?.comp_level || '').toLowerCase()] || 'Match';
  const set = match?.set_number > 1 || match?.comp_level === 'sf' ? `${match.set_number}-` : '';
  return `${level} ${set}${match?.match_number ?? ''}`.trim();
}
