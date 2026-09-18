import { DEFAULT_AUTO_END_MS, autoStartPosition, deadAuto, fuseObservations, visionAutoPath } from './visionAnalytics.js';

const REVIEWED = new Set(['accepted', 'corrected']);
const START_POSITIONS = new Set(['left trench', 'left mound', 'center', 'right mound', 'right trench']);
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;

function phaseIsAuto(observation, autoEndMs) {
  return observation.phase ? observation.phase === 'auto' : (number(observation.started_ms) ?? Infinity) < autoEndMs;
}

function consensus(values) {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length === 1 ? unique[0] : null;
}

function strongestTrack(tracks) {
  return [...tracks].sort((left, right) => Number(right.metrics?.coverageMs || 0) - Number(left.metrics?.coverageMs || 0))[0] || null;
}

/**
 * Converts human-reviewed, team-attributed vision evidence into the subset of
 * Match Scouting fields the system can actually observe. This deliberately
 * excludes subjective ratings, preload, crashes, intake, cards, and points:
 * those require a scout's judgement or are not measured in this form.
 */
export function buildVisionMatchScoutSuggestions({ run = {}, teamKey, tracks = [], observations = [] } = {}) {
  const autoEndMs = number(run.config?.auto_end_ms) ?? DEFAULT_AUTO_END_MS;
  const teamTracks = tracks.filter(track => track.team_key === teamKey);
  const reviewed = observations.filter(row => row.team_key === teamKey && REVIEWED.has(row.review_status));
  const fused = fuseObservations(reviewed);
  const fields = {};
  const evidence = { reviewed_observations: fused.length, tracks: teamTracks.length };

  const startPosition = consensus(teamTracks.map(autoStartPosition));
  if (START_POSITIONS.has(startPosition)) fields.startingPosition = startPosition;

  const movement = teamTracks
    .map(track => deadAuto(track, { autoEndMs }))
    .filter(value => typeof value === 'boolean');
  // A moving view wins over a stationary one; camera occlusion must never mark
  // a working robot as dead. If every eligible view agrees it was stationary,
  // offer the more conservative did-not-run answer.
  if (movement.includes(false)) fields.autoMoved = 'ran';
  else if (movement.length && movement.every(value => value === true)) fields.autoMoved = 'did-not-run';

  const bestTrack = strongestTrack(teamTracks);
  // Recalculate after identity review: a candidate made before a reviewer
  // named the track is intentionally rejected as unresolved, but is valid now.
  const pathCandidate = bestTrack && visionAutoPath(bestTrack, { autoEndMs });
  if (pathCandidate?.viable && pathCandidate.path?.length >= 2) {
    fields.autoPath = pathCandidate.path;
    fields.autoPathName = 'Vision-reviewed auto path';
    evidence.auto_path = { samples: pathCandidate.sampleCount, coverage_ms: pathCandidate.coverageMs };
  }

  const teleopFuel = fused.filter(row => row.observation_type === 'fuel_scored' && !phaseIsAuto(row, autoEndMs));
  if (teleopFuel.length) {
    const count = teleopFuel.reduce((sum, row) => sum + Math.max(0, number(row.value?.count) ?? 1), 0);
    fields.ballsScored = String(Math.round(count));
    evidence.teleop_fuel_events = teleopFuel.length;
  }

  const disabled = fused.filter(row => row.observation_type === 'disabled' && !phaseIsAuto(row, autoEndMs));
  if (disabled.length) {
    fields.teleopRobotStatus = 'stopped';
    evidence.disabled_events = disabled.length;
  }

  return {
    fields,
    evidence,
    reviewed: Boolean(fused.length || teamTracks.length),
    unavailable: [
      'preload', 'autoPoints', 'teleopRoles', 'ratings', 'significantCrash',
      'intakeSpeed', 'intakeJammed', 'mechanicalBreak', 'cards', 'driverSkill'
    ]
  };
}
