import { isMatchPlayed } from './matchProjection.js';

const timeFor = (match) => {
  for (const value of [match?.predicted_time, match?.time, match?.actual_time]) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return null;
};

const matchOrder = (left, right) => {
  const leftTime = timeFor(left);
  const rightTime = timeFor(right);
  if (leftTime != null && rightTime != null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime != null) return -1;
  if (rightTime != null) return 1;
  return Number(left?.match_number || 0) - Number(right?.match_number || 0);
};

export function teamAlliance(match, teamKey) {
  if ((match?.alliances?.red?.team_keys || []).includes(teamKey)) return 'red';
  if ((match?.alliances?.blue?.team_keys || []).includes(teamKey)) return 'blue';
  return null;
}

/**
 * 971's schedule, with the soonest upcoming match first (direct instruction
 * - it previously rendered latest-first, then that was reversed). Synthetic
 * practice matches remain available for testing without affecting real
 * match urgency.
 */
export function buildStrategySchedule(matches = [], teamKey) {
  const ours = matches.filter((match) => teamAlliance(match, teamKey));
  const realUpcoming = ours.filter((match) => !isMatchPlayed(match) && !match.is_test_market).sort(matchOrder);
  const upcomingByMatch = new Map(realUpcoming.map((match, matchesAway) => [match.key, {
    match,
    alliance: teamAlliance(match, teamKey),
    matchesAway,
    estimatedTime: timeFor(match)
  }]));
  const practice = ours.filter((match) => !isMatchPlayed(match) && match.is_test_market).map((match) => ({
    match, alliance: teamAlliance(match, teamKey), matchesAway: null, estimatedTime: null
  }));
  const upcoming = [...upcomingByMatch.values()].sort((left, right) => matchOrder(left.match, right.match));
  const played = ours.filter(isMatchPlayed).sort((left, right) => matchOrder(right, left)).map((match) => ({
    match, alliance: teamAlliance(match, teamKey), matchesAway: null, estimatedTime: timeFor(match)
  }));
  return { upcoming: [...upcoming, ...practice], played, realUpcoming };
}
