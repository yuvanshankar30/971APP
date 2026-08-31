// Summarizes a flat list of scout_data_events rows (as returned by
// GET /datascout?team_key=...&event_key=...) for one team into simple,
// robust aggregates. Deliberately not a full analytics engine - just what's
// directly derivable from the real event vocabulary datascout/+page.svelte
// actually writes (verified against that file, not guessed):
//   rank_driving  - 1-3, subjective driving quality (Bad/Good/Great)
//   rank_accuracy - 1-5, subjective shooting accuracy
//   rank_speed    - a numeric rate (balls/sec)
//   climb_pos     - one of 'N/A' | 'L1' | 'L2' | 'L3' | 'Failed'
// event_value is always stored as text (scout_data_events.event_value is a
// text column), so numeric fields need parsing; non-numeric/missing values
// are skipped rather than corrupting the average.
//
// Number(null) is 0 in JS, not NaN - a plain `Number.isFinite(Number(v))`
// check silently counts a missing value as a real 0, dragging the average
// down every time an event happens to have no value recorded. Reject
// null/undefined/empty-string explicitly before the numeric conversion.
function parseNumeric(raw) {
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export function summarizeTeamEvents(events) {
  const matchKeys = new Set();
  const driving = [];
  const accuracy = [];
  const speed = [];
  const climbCounts = {};

  for (const e of events || []) {
    if (e?.match_key) matchKeys.add(e.match_key);
    if (e?.event_type === 'rank_driving') {
      const v = parseNumeric(e.event_value);
      if (v != null) driving.push(v);
    } else if (e?.event_type === 'rank_accuracy') {
      const v = parseNumeric(e.event_value);
      if (v != null) accuracy.push(v);
    } else if (e?.event_type === 'rank_speed') {
      const v = parseNumeric(e.event_value);
      if (v != null) speed.push(v);
    } else if (e?.event_type === 'climb_pos') {
      const v = String(e.event_value || 'N/A');
      climbCounts[v] = (climbCounts[v] || 0) + 1;
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  let mostCommonClimb = null;
  let mostCommonClimbCount = 0;
  for (const [pos, count] of Object.entries(climbCounts)) {
    if (count > mostCommonClimbCount) {
      mostCommonClimb = pos;
      mostCommonClimbCount = count;
    }
  }

  return {
    matchesScouted: matchKeys.size,
    avgDrivingRank: avg(driving),
    avgAccuracy: avg(accuracy),
    avgSpeed: avg(speed),
    mostCommonClimb,
    climbCounts
  };
}

// Shuttle/Hub fuel counts: a tap ('shuttle_fuel'/'hub_fuel') increments by
// one; a '..._fuel_override' event sets a new baseline and resets the tap
// count, so a correction doesn't require deleting/replaying prior taps.
// Single source of truth for this derivation - datascout/+page.svelte's
// live counters and the Google Sheets export (deriveMatchTeamRow below)
// both call this instead of each re-implementing the merge logic.
export function fuelCountFromEvents(events, location) {
  const tapType = `${location}_fuel`;
  const overrideType = `${location}_fuel_override`;
  let baseline = 0;
  let taps = 0;
  for (const e of events || []) {
    if (e?.event_type === overrideType) {
      // A non-numeric/negative override is rejected, not coerced to 0 -
      // Math.max(0, NaN || 0) would silently evaluate to 0 and wipe out a
      // real count on garbage input. The live datascout UI already
      // validates before ever recording this event type, but this
      // aggregation reads whatever's actually in the DB, so it can't just
      // assume that held - same defensive-parsing stance as parseNumeric
      // above.
      const parsed = parseNumeric(e.event_value);
      if (parsed != null && parsed >= 0) {
        baseline = Math.round(parsed);
        taps = 0;
      }
    } else if (e?.event_type === tapType) {
      taps += 1;
    }
  }
  return baseline + taps;
}

// One flat summary row for a SINGLE (match_key, team_key) pair - distinct
// from summarizeTeamEvents above, which aggregates across every match a
// team's been scouted in. Caller must already filter `events` down to one
// match+team pair. Built for the Google Sheets export (one row per scouted
// robot per match), not currently used for in-app display.
export function deriveMatchTeamRow(events) {
  const list = events || [];
  const latestValue = (type) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.event_type === type) return list[i].event_value;
    }
    return null;
  };
  return {
    autoStartPosition: latestValue('auto_start_position') || '',
    deadAuto: latestValue('dead_auto') === 'true',
    autoClimbPos: latestValue('auto_climb_pos') || 'N/A',
    finalClimbPos: latestValue('climb_pos') || 'N/A',
    drivingRank: parseNumeric(latestValue('rank_driving')),
    accuracy: parseNumeric(latestValue('rank_accuracy')),
    speed: parseNumeric(latestValue('rank_speed')),
    shuttleFuel: fuelCountFromEvents(list, 'shuttle'),
    hubFuel: fuelCountFromEvents(list, 'hub')
  };
}

const CLIMB_LEVEL = { 'N/A': 0, Failed: 0, L1: 1, L2: 2, L3: 3 };

// Builds the local-scouting inputs used by the rankings page. Match-level
// values are derived first so a match with fifty fuel taps does not count as
// fifty independent observations while one subjective rating counts once.
export function summarizeTeamPerformance(events) {
  const byMatch = new Map();
  for (const row of events || []) {
    if (!row?.match_key) continue;
    if (!byMatch.has(row.match_key)) byMatch.set(row.match_key, []);
    byMatch.get(row.match_key).push(row);
  }

  const matches = [...byMatch.values()].map(deriveMatchTeamRow);
  const average = (values) => {
    const usable = values.filter((value) => Number.isFinite(value));
    return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
  };

  return {
    ...summarizeTeamEvents(events),
    avgFuel: matches.length ? average(matches.map((match) => match.shuttleFuel + match.hubFuel)) : null,
    avgClimbLevel: average(matches.map((match) => CLIMB_LEVEL[match.finalClimbPos]).filter((level) => level != null)),
    climbSuccessRate: matches.length
      ? matches.filter((match) => (CLIMB_LEVEL[match.finalClimbPos] || 0) > 0).length / matches.length
      : null
  };
}

function normalize(value, values) {
  if (!Number.isFinite(value)) return null;
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return null;
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  // A tied field contains no evidence that anyone is above or below the
  // event field, so it is neutral rather than a free perfect score.
  if (max === min) return 50;
  return ((value - min) / (max - min)) * 100;
}

function weightedScore(parts) {
  const usable = parts.filter((part) => Number.isFinite(part.value));
  const weight = usable.reduce((sum, part) => sum + part.weight, 0);
  if (!weight) return null;
  return usable.reduce((sum, part) => sum + part.value * part.weight, 0) / weight;
}

export const STAR_PROFILE_AXES = Object.freeze([
  { key: 'fuel', label: 'Fuel', source: (row) => row.scoutSummary.avgFuel },
  { key: 'driving', label: 'Driving', source: (row) => row.scoutSummary.avgDrivingRank },
  { key: 'accuracy', label: 'Accuracy', source: (row) => row.scoutSummary.avgAccuracy },
  { key: 'speed', label: 'Speed', source: (row) => row.scoutSummary.avgSpeed },
  { key: 'climb', label: 'Climb', source: (row) => row.scoutSummary.avgClimbLevel },
  { key: 'pit', label: 'Pit', source: (row) => row.pitSummary.pitScore }
]);

function attachStarProfiles(rows) {
  const fieldValues = new Map(STAR_PROFILE_AXES.map((axis) => [
    axis.key,
    rows.map((row) => axis.source(row))
  ]));

  return rows.map((row) => ({
    ...row,
    starProfile: STAR_PROFILE_AXES.map((axis) => {
      const raw = axis.source(row);
      return {
        key: axis.key,
        label: axis.label,
        raw,
        value: normalize(raw, fieldValues.get(axis.key))
      };
    })
  }));
}

function canonicalPair(firstKey, secondKey) {
  return [String(firstKey || ''), String(secondKey || '')].sort().join('|');
}

export function summarizePairwisePair(votes, firstKey, secondKey) {
  if (!firstKey || !secondKey || firstKey === secondKey) {
    return { voteCount: 0, firstWins: 0, secondWins: 0, firstShare: null, secondShare: null, leaderKey: null };
  }
  const pairKey = canonicalPair(firstKey, secondKey);
  let firstWins = 0;
  let secondWins = 0;
  for (const vote of votes || []) {
    if (canonicalPair(vote?.team_a_key, vote?.team_b_key) !== pairKey) continue;
    if (vote?.winner_team_key === firstKey) firstWins += 1;
    else if (vote?.winner_team_key === secondKey) secondWins += 1;
  }
  const voteCount = firstWins + secondWins;
  return {
    voteCount,
    firstWins,
    secondWins,
    firstShare: voteCount ? firstWins / voteCount : null,
    secondShare: voteCount ? secondWins / voteCount : null,
    leaderKey: firstWins === secondWins ? null : firstWins > secondWins ? firstKey : secondKey
  };
}

// Human preference is intentionally parallel to calculated Scout Power. It
// creates a consensus rank and review signal but never modifies scoutPower or
// powerRank, preserving the provenance of both measures.
export function applyPairwiseConsensus(teams, votes) {
  const rows = teams || [];
  const byKey = new Map(rows.map((team) => [team.key, {
    wins: 0,
    losses: 0,
    voteCount: 0,
    winRate: null,
    humanRank: null,
    reviewCount: 0,
    reviewFlag: false
  }]));
  const pairs = new Map();

  for (const vote of votes || []) {
    const firstKey = vote?.team_a_key;
    const secondKey = vote?.team_b_key;
    const winnerKey = vote?.winner_team_key;
    if (!byKey.has(firstKey) || !byKey.has(secondKey) || firstKey === secondKey) continue;
    if (winnerKey !== firstKey && winnerKey !== secondKey) continue;
    const loserKey = winnerKey === firstKey ? secondKey : firstKey;
    const winner = byKey.get(winnerKey);
    const loser = byKey.get(loserKey);
    winner.wins += 1;
    winner.voteCount += 1;
    loser.losses += 1;
    loser.voteCount += 1;

    const pairKey = canonicalPair(firstKey, secondKey);
    if (!pairs.has(pairKey)) pairs.set(pairKey, { firstKey, secondKey, winners: [] });
    pairs.get(pairKey).winners.push(winnerKey);
  }

  for (const summary of byKey.values()) {
    summary.winRate = summary.voteCount ? summary.wins / summary.voteCount : null;
  }

  const ranked = rows
    .filter((team) => byKey.get(team.key).voteCount > 0)
    .sort((a, b) => {
      const first = byKey.get(a.key);
      const second = byKey.get(b.key);
      return second.winRate - first.winRate
        || second.voteCount - first.voteCount
        || (a.powerRank ?? Number.MAX_SAFE_INTEGER) - (b.powerRank ?? Number.MAX_SAFE_INTEGER)
        || (a.team_number ?? 0) - (b.team_number ?? 0);
    });
  ranked.forEach((team, index) => { byKey.get(team.key).humanRank = index + 1; });

  const teamByKey = new Map(rows.map((team) => [team.key, team]));
  for (const pair of pairs.values()) {
    if (pair.winners.length < 2) continue;
    const winsByTeam = new Map();
    for (const winner of pair.winners) winsByTeam.set(winner, (winsByTeam.get(winner) || 0) + 1);
    const [majorityKey, majorityWins] = [...winsByTeam.entries()].sort((a, b) => b[1] - a[1])[0];
    if (majorityWins / pair.winners.length < (2 / 3)) continue;
    const first = teamByKey.get(pair.firstKey);
    const second = teamByKey.get(pair.secondKey);
    if (!Number.isFinite(first?.scoutPower) || !Number.isFinite(second?.scoutPower)) continue;
    if (Math.abs(first.scoutPower - second.scoutPower) < 5) continue;
    const calculatedLeader = first.scoutPower > second.scoutPower ? first.key : second.key;
    if (majorityKey === calculatedLeader) continue;
    byKey.get(first.key).reviewCount += 1;
    byKey.get(second.key).reviewCount += 1;
  }

  return rows.map((team) => {
    const consensusSummary = byKey.get(team.key);
    consensusSummary.reviewFlag = consensusSummary.reviewCount > 0;
    return {
      ...team,
      consensusSummary,
      humanRank: consensusSummary.humanRank,
      humanWinRate: consensusSummary.winRate,
      humanVoteCount: consensusSummary.voteCount,
      reviewFlag: consensusSummary.reviewFlag
    };
  });
}

// Freeform prose is never scored automatically. Scouts explicitly attach a
// -2..2 impact so rankings use human judgment without pretending sentiment
// analysis understands match context. Neutral/legacy notes are review-only.
export function summarizeScoutNotes(notes) {
  const impacts = (notes || [])
    .map((note) => Number(note?.ranking_impact))
    .filter((impact) => Number.isInteger(impact) && impact >= -2 && impact <= 2 && impact !== 0);
  const averageImpact = impacts.length
    ? impacts.reduce((sum, impact) => sum + impact, 0) / impacts.length
    : null;

  return {
    noteCount: (notes || []).length,
    scoredNoteCount: impacts.length,
    averageImpact,
    impactScore: averageImpact == null ? null : ((averageImpact + 2) / 4) * 100
  };
}

const PIT_CLIMB_SCORE = Object.freeze({
  'No Climb': 0,
  'L1 Auto': 45,
  L1: 35,
  L2: 70,
  L3: 100
});
const PIT_PROBLEM_PENALTY = Object.freeze({ watch: 8, urgent: 20 });

// Pit claims are useful pre-match evidence, but deliberately remain a small
// part of Scout Power. Capability fields are scored; archetype and prose are
// surfaced for humans without pretending categories or sentences are numbers.
export function summarizePitScouting(entry, problems = [], normalizedBps = null) {
  const climbs = Array.isArray(entry?.climb_options) ? entry.climb_options : [];
  const climbScore = climbs.length
    ? Math.max(...climbs.map((value) => PIT_CLIMB_SCORE[value] ?? 0))
    : null;
  const reliability = Number(entry?.technical_details?.overall_reliability_rating);
  const reliabilityScore = reliability >= 1 && reliability <= 10 ? reliability * 10 : null;
  const openProblems = (problems || []).filter((problem) => !problem?.resolved);
  const urgentProblems = openProblems.filter((problem) => problem?.severity === 'urgent').length;
  const problemPenalty = Math.min(60, openProblems.reduce(
    (sum, problem) => sum + (PIT_PROBLEM_PENALTY[problem?.severity] || PIT_PROBLEM_PENALTY.watch),
    0
  ));
  const capabilityScore = weightedScore([
    { value: climbScore, weight: 0.45 },
    { value: normalizedBps, weight: 0.35 },
    { value: reliabilityScore, weight: 0.2 }
  ]);
  const pitScore = capabilityScore == null && !openProblems.length
    ? null
    : Math.max(0, (capabilityScore ?? 50) - problemPenalty);

  return {
    pitScore,
    capabilityScore,
    climbScore,
    reliabilityScore,
    estimatedBps: parseNumeric(entry?.estimated_bps),
    openProblemCount: openProblems.length,
    urgentProblemCount: urgentProblems,
    problemPenalty,
    robotArchetype: entry?.robot_archetype || null,
    hasAdditionalNotes: Boolean(String(entry?.additional_notes || '').trim())
  };
}

// Produces event-relative rankings from the team's own scouting observations.
// Missing dimensions are omitted and the remaining weights are normalized,
// never converted to fake zeroes.
export function buildPowerRankings(teams, events, notes = [], pitInputs = {}) {
  const eventsByTeam = new Map();
  for (const row of events || []) {
    if (!row?.team_key) continue;
    if (!eventsByTeam.has(row.team_key)) eventsByTeam.set(row.team_key, []);
    eventsByTeam.get(row.team_key).push(row);
  }

  const rows = (teams || []).map((team) => ({
    ...team,
    scoutSummary: summarizeTeamPerformance(eventsByTeam.get(team.key) || [])
  }));
  const metricValues = (key) => rows.map((row) => row.scoutSummary[key]);
  const notesByTeam = new Map();
  for (const note of notes || []) {
    if (!note?.team_key) continue;
    if (!notesByTeam.has(note.team_key)) notesByTeam.set(note.team_key, []);
    notesByTeam.get(note.team_key).push(note);
  }
  const pitByTeam = new Map((pitInputs.pitEntries || []).map((entry) => [entry.team_key, entry]));
  const problemsByTeam = new Map();
  for (const problem of pitInputs.problemReports || []) {
    if (!problem?.team_key) continue;
    if (!problemsByTeam.has(problem.team_key)) problemsByTeam.set(problem.team_key, []);
    problemsByTeam.get(problem.team_key).push(problem);
  }
  const bpsValues = [...pitByTeam.values()].map((entry) => parseNumeric(entry?.estimated_bps));
  const ranked = rows.map((row) => {
    const summary = row.scoutSummary;
    const performanceScore = weightedScore([
      { value: normalize(summary.avgFuel, metricValues('avgFuel')), weight: 0.4 },
      { value: normalize(summary.avgDrivingRank, metricValues('avgDrivingRank')), weight: 0.2 },
      { value: normalize(summary.avgAccuracy, metricValues('avgAccuracy')), weight: 0.15 },
      { value: normalize(summary.avgSpeed, metricValues('avgSpeed')), weight: 0.1 },
      { value: normalize(summary.avgClimbLevel, metricValues('avgClimbLevel')), weight: 0.15 }
    ]);
    const noteSummary = summarizeScoutNotes(notesByTeam.get(row.key) || []);
    const pitEntry = pitByTeam.get(row.key) || null;
    const rawBps = parseNumeric(pitEntry?.estimated_bps);
    const pitSummary = summarizePitScouting(
      pitEntry,
      problemsByTeam.get(row.key) || [],
      normalize(rawBps, bpsValues)
    );
    const scoutPower = weightedScore([
      { value: performanceScore, weight: 0.7 },
      { value: noteSummary.impactScore, weight: 0.15 },
      { value: pitSummary.pitScore, weight: 0.15 }
    ]);
    return {
      ...row,
      scoutPower,
      performanceScore,
      noteSummary,
      pitSummary
    };
  });

  const order = [...ranked]
    .sort((a, b) => (b.scoutPower ?? -1) - (a.scoutPower ?? -1))
    .map((row, index) => [row.key, row.scoutPower == null ? null : index + 1]);
  const rankByKey = new Map(order);
  return attachStarProfiles(ranked.map((row) => ({ ...row, powerRank: rankByKey.get(row.key) })));
}
