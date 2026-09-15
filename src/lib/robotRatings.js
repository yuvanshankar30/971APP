// Subjective, per-scout robot ratings (Overall/Offense/Shuttling/Driving/
// Defense out of 10) plus free-text notes and practice-match strategy notes.
// Parallel in spirit to applyPairwiseConsensus in scoutingStats.js: this is a
// staff-judgment overlay that Power Rankings can display alongside the
// calculated Scout Power, never a replacement for it.

const RATING_AVERAGE_FIELDS = [
  ['overall_rating', 'overallAvg'],
  ['offense_rating', 'offenseAvg'],
  ['shuttling_rating', 'shuttlingAvg'],
  ['driving_rating', 'drivingAvg'],
  ['defense_rating', 'defenseAvg']
];

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

// Groups raw scouting_robot_ratings rows by team_key and computes the
// per-field averages (each field independently ignores raters who left that
// field blank, same "omit and don't count against the average" rule
// buildPowerRankings uses for missing inputs elsewhere in this app).
export function summarizeRobotRatings(ratings = []) {
  const byTeam = new Map();
  for (const rating of ratings) {
    const key = rating?.team_key;
    if (!key) continue;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(rating);
  }

  const summary = new Map();
  for (const [teamKey, entries] of byTeam) {
    const averages = {};
    for (const [field, label] of RATING_AVERAGE_FIELDS) {
      averages[label] = average(entries.map((entry) => entry[field]));
    }
    summary.set(teamKey, {
      ...averages,
      raterCount: entries.length,
      entries: [...entries].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    });
  }
  return summary;
}

const EMPTY_SUMMARY = { overallAvg: null, offenseAvg: null, shuttlingAvg: null, drivingAvg: null, defenseAvg: null, raterCount: 0, entries: [] };

// Attaches the rating summary to each team row without touching scoutPower/
// powerRank, mirroring applyPairwiseConsensus's "additive, never mutates the
// calculated measure" contract.
export function applyRobotRatings(teams = [], ratings = []) {
  const summaryByTeam = summarizeRobotRatings(ratings);
  return teams.map((team) => {
    const robotRating = summaryByTeam.get(team.key) || EMPTY_SUMMARY;
    // Flat robotRatingAvg/robotRatingCount alongside the nested summary so a
    // simple a[sortKey] table sort (the pattern every other Power Rankings
    // column already uses) works without special-casing this column.
    return { ...team, robotRating, robotRatingAvg: robotRating.overallAvg, robotRatingCount: robotRating.raterCount };
  });
}

export function myRobotRating(ratings = [], teamKey, userId) {
  if (!userId) return null;
  return ratings.find((rating) => rating.team_key === teamKey && rating.created_by === userId) || null;
}
