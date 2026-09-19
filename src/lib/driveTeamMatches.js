export function teamMatchResult(match, teamKey) {
  const normalizedTeamKey = String(teamKey || '').toLowerCase();
  const redTeams = match?.alliances?.red?.team_keys || [];
  const blueTeams = match?.alliances?.blue?.team_keys || [];
  const alliance = redTeams.some((key) => String(key).toLowerCase() === normalizedTeamKey)
    ? 'red'
    : blueTeams.some((key) => String(key).toLowerCase() === normalizedTeamKey)
      ? 'blue'
      : null;

  if (!alliance) return { alliance: null, outcome: 'unknown', ourScore: null, opponentScore: null };

  const opponentAlliance = alliance === 'red' ? 'blue' : 'red';
  const ourScore = match?.alliances?.[alliance]?.score;
  const opponentScore = match?.alliances?.[opponentAlliance]?.score;
  const scoresAreFinal = Number.isFinite(ourScore) && Number.isFinite(opponentScore) && ourScore >= 0 && opponentScore >= 0;
  const winner = String(match?.winning_alliance || '').toLowerCase();

  let outcome = 'unknown';
  if (winner === alliance) outcome = 'win';
  else if (winner === opponentAlliance) outcome = 'loss';
  else if (scoresAreFinal) {
    if (ourScore > opponentScore) outcome = 'win';
    else if (ourScore < opponentScore) outcome = 'loss';
    else outcome = 'tie';
  }

  return {
    alliance,
    outcome,
    ourScore: scoresAreFinal ? ourScore : null,
    opponentScore: scoresAreFinal ? opponentScore : null
  };
}
