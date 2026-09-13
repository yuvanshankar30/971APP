// Validation and normalization for match scouting and the pit-problem
// handoff. Kept pure and separate from the route so the rules are directly
// testable, and because this is the only thing standing between a scout's
// phone and the database - the client is a form anyone can edit.
//
// The vocabularies below mirror what the match scouting workspace collects.
// Anything outside them is dropped rather than stored, so a renamed option in
// the UI shows up as missing data instead of quietly widening the schema.

import {
  BALL_COUNT_RANGES as SHARED_BALL_COUNT_RANGES,
  MATCH_RATING_FIELDS,
  TELEOP_ROLES as SHARED_TELEOP_ROLES,
  parseAutoPointsEstimate,
  AUTO_FUEL_SOURCES, MATCH_FORM_ROLES, MATCH_FORM_RATING_FIELDS, validateMatchScoutForm
} from '$lib/matchScouting.js';

export const START_POSITIONS = ['left trench', 'left mound', 'center', 'right mound', 'right trench'];
export const AUTO_ZONES = ['source', 'wing', 'neutral', 'opponent wing'];
export const RATING_FIELDS = MATCH_RATING_FIELDS;
export const TELEOP_ROLES = SHARED_TELEOP_ROLES;
export const BALL_SOURCES = ['source', 'wing', 'neutral', 'opponent wing', 'human player', 'floor'];
export const BALL_COUNT_RANGES = SHARED_BALL_COUNT_RANGES;
export const CARDS = ['', 'yellow', 'red'];
export const DISABLED_STATES = ['', 'no', 'tipped', 'died', 'disabled'];
export const SEVERITIES = ['urgent', 'watch'];

// A freehand path can emit a point per pointermove event, which is thousands
// over a 15-second auto. The drawing is only ever read back as a shape, so
// cap it and drop the middle rather than storing every sample.
const MAX_PATH_POINTS = 400;
const MAX_NOTE_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 300;

function trimmed(value, max = MAX_NOTE_LENGTH) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function oneOf(value, allowed) {
  if (value == null) return null;
  const text = String(value).trim();
  return allowed.includes(text) ? text : null;
}

export function requiresPitProblemReport(robotDisabled) {
  return ['disabled', 'died'].includes(String(robotDisabled || '').trim());
}

export function validatePitProblemHandoff(body) {
  const requested = body?.teleop_robot_status === 'dead' || body?.mechanical_break === true || body?.report_pit_problem === true || requiresPitProblemReport(body?.robot_disabled);
  if (!requested) return null;
  return trimmed(body?.pit_problem_summary, MAX_SUMMARY_LENGTH)
    ? null
    : 'Describe the problem for the ACE Team when the robot breaks, is disabled, or died';
}

/** Team keys arrive as "971", "frc971" or " frc971 " depending on the caller. */
export function normalizeTeamKey(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  const digits = text.replace(/^frc/, '');
  return /^\d{1,5}$/.test(digits) ? `frc${digits}` : null;
}

export function normalizeAutoPath(value) {
  if (!Array.isArray(value)) return [];
  const points = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Percentages of the field diagram, so they stay meaningful at any size.
    points.push([
      Math.round(Math.min(100, Math.max(0, x)) * 100) / 100,
      Math.round(Math.min(100, Math.max(0, y)) * 100) / 100
    ]);
  }
  if (points.length <= MAX_PATH_POINTS) return points;
  // Keep the endpoints - where a robot started and finished is the part
  // anyone actually reads - and evenly sample between them.
  const step = (points.length - 1) / (MAX_PATH_POINTS - 1);
  const sampled = [];
  for (let index = 0; index < MAX_PATH_POINTS; index += 1) {
    sampled.push(points[Math.round(index * step)]);
  }
  return sampled;
}

export function normalizeRatings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const ratings = {};
  for (const field of [...RATING_FIELDS, 'BPS']) {
    const raw = Number(value[field]);
    if (!Number.isFinite(raw)) continue;
    const clamped = Math.min(5, Math.max(0, Math.round(raw)));
    // 0 means "not rated" in the UI, so there is nothing to record.
    if (clamped > 0) ratings[field] = clamped;
  }
  return ratings;
}

function normalizeStringList(value, allowed) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    const match = oneOf(entry, allowed);
    if (match) seen.add(match);
  }
  return [...seen];
}

/**
 * @returns {{ value: object|null, error: string|null }}
 */
export function normalizeMatchScoutEntry(body, actorId = null) {
  const event_key = trimmed(body?.event_key, 60);
  const match_key = trimmed(body?.match_key, 60);
  const team_key = normalizeTeamKey(body?.team_key);
  if (!event_key) return { value: null, error: 'event_key is required' };
  if (!match_key) return { value: null, error: 'match_key is required' };
  if (!team_key) return { value: null, error: 'A valid team_key is required (e.g. frc971)' };

  const rawAutoPoints = body?.auto_points_estimate ?? body?.auto_points_band;
  const autoPoints = parseAutoPointsEstimate(rawAutoPoints);
  if (String(rawAutoPoints ?? '').trim() && !autoPoints) {
    return {
      value: null,
      error: 'Auto points must be a number, a range like 40-60, or a lower bound like 100+'
    };
  }

  // Balls are picked from a fixed bucket list, so an unrecognized value is a
  // client that has drifted from the vocabulary rather than a scout typo -
  // dropped like every other out-of-vocabulary field instead of stored.
  const currentForm = body?.form_version === 2;
  if (currentForm) {
    const invalid = validateMatchScoutForm(body);
    if (invalid) return { value: null, error: invalid };
    if (!START_POSITIONS.includes(body.starting_position)) return { value: null, error: 'Select a starting position.' };
    if (typeof body.mechanical_break !== 'boolean') return { value: null, error: 'Select whether a mechanical break occurred.' };
    if (body.auto_cycles != null && (!Number.isInteger(body.auto_cycles) || body.auto_cycles < 0 || body.auto_cycles > 100)) return { value: null, error: 'Auto cycles must be a whole number from 0 to 100.' };
  }
  const ballsBand = currentForm ? body.balls_scored_band : oneOf(body?.balls_scored_band, BALL_COUNT_RANGES);
  const balls = ballsBand ? parseAutoPointsEstimate(ballsBand) : null;

  const driverSkillRaw = Number(body?.driver_skill);
  return {
    value: {
      event_key,
      match_key,
      team_key,
      ...(currentForm ? {
        form_version: 2,
        scout_name: trimmed(body.scout_name, 120),
        preload: body.preload,
        auto_cycles: Number.isInteger(body.auto_cycles) && body.auto_cycles >= 0 && body.auto_cycles <= 100 ? body.auto_cycles : null,
        teleop_roles_none: body.teleop_roles_none === true && !body.teleop_roles.length,
        ratings_unknown: normalizeStringList(body.ratings_unknown, MATCH_FORM_RATING_FIELDS),
        significant_crash: body.significant_crash,
        crash_target: body.significant_crash ? body.crash_target : null,
        crash_details: body.significant_crash ? trimmed(body.crash_details, 500) : null,
        teleop_robot_status: body.teleop_robot_status,
        mechanical_break: body.mechanical_break
      } : {}),
      alliance: oneOf(body?.alliance, ['red', 'blue']),
      starting_position: oneOf(body?.starting_position, START_POSITIONS),
      auto_start_zone: oneOf(body?.auto_start_zone, AUTO_ZONES),
      // Keep the readable estimate for old consumers and store its parsed
      // values separately so analytics do not need to reverse-engineer text.
      auto_points_band: autoPoints?.input ?? null,
      auto_points_min: autoPoints?.min ?? null,
      auto_points_max: autoPoints?.max ?? null,
      auto_points_average: autoPoints?.average ?? null,
      auto_finish: trimmed(body?.auto_finish, 120),
      auto_moved: trimmed(body?.auto_moved, 40),
      ball_sources: normalizeStringList(body?.ball_sources, currentForm ? AUTO_FUEL_SOURCES : BALL_SOURCES),
      // Same shape as auto points: the readable bucket plus its parsed bounds,
      // so analytics never has to re-parse text. "500+" has no max, and its
      // average is the lower bound rather than an invented midpoint.
      balls_scored_band: balls?.input ?? null,
      balls_scored_min: balls?.min ?? null,
      balls_scored_max: balls?.max ?? null,
      balls_scored_average: balls?.average ?? null,
      auto_collision: body?.auto_collision === true,
      auto_collision_notes: trimmed(body?.auto_collision_notes, 500),
      auto_path_name: trimmed(body?.auto_path_name, 120),
      auto_path: normalizeAutoPath(body?.auto_path),
      ratings: normalizeRatings(currentForm ? Object.fromEntries(MATCH_FORM_RATING_FIELDS.map(field => [field, body.ratings?.[field]])) : body?.ratings),
      teleop_roles: normalizeStringList(body?.teleop_roles, currentForm ? MATCH_FORM_ROLES : TELEOP_ROLES),
      teleop_notes: trimmed(body?.teleop_notes),
      intake_speed: Number.isFinite(Number(body?.intake_speed))
        ? Math.min(3, Math.max(1, Math.round(Number(body.intake_speed))))
        : null,
      intake_jammed: body?.intake_jammed === true,
      crash_or_break: currentForm ? body.mechanical_break || body.significant_crash : body?.crash_or_break === true,
      robot_disabled: currentForm && body.teleop_robot_status === 'dead' ? 'died' : oneOf(body?.robot_disabled, DISABLED_STATES),
      card: oneOf(body?.card, CARDS),
      driver_skill: Number.isFinite(driverSkillRaw)
        ? Math.min(5, Math.max(0, Math.round(driverSkillRaw)))
        : null,
      post_notes: trimmed(body?.post_notes),
      created_by: actorId,
      updated_at: new Date().toISOString()
    },
    error: null
  };
}

/** A reusable autonomous-path file saved independently of a match report. */
export function normalizeAutoPathFile(body, actorId = null) {
  const event_key = trimmed(body?.event_key, 60);
  const team_key = normalizeTeamKey(body?.team_key);
  const name = trimmed(body?.name, 120);
  const path = normalizeAutoPath(body?.path);
  if (!event_key) return { value: null, error: 'event_key is required' };
  if (!team_key) return { value: null, error: 'A valid team_key is required (e.g. frc971)' };
  if (!name) return { value: null, error: 'A path name is required' };
  if (path.length < 2) return { value: null, error: 'Draw a path before saving the file' };

  return {
    value: {
      event_key,
      team_key,
      name,
      alliance: oneOf(body?.alliance, ['red', 'blue']),
      path,
      created_by: actorId,
      updated_at: new Date().toISOString()
    },
    error: null
  };
}

/**
 * A match scout flagging a mechanical problem for the pit crew. Severity is
 * derived from what was observed rather than trusted from the client: a robot
 * that died or was disabled is urgent regardless of what the form sent.
 */
export function normalizePitProblemReport(body, actorId = null) {
  const event_key = trimmed(body?.event_key, 60);
  const team_key = normalizeTeamKey(body?.team_key);
  if (!event_key) return { value: null, error: 'event_key is required' };
  if (!team_key) return { value: null, error: 'A valid team_key is required (e.g. frc971)' };

  const summary = trimmed(body?.summary, MAX_SUMMARY_LENGTH)
    || 'Mechanical issue flagged after match';
  const observedUrgent = ['died', 'disabled'].includes(String(body?.robot_disabled || '').trim());
  const requested = oneOf(body?.severity, SEVERITIES);

  return {
    value: {
      event_key,
      team_key,
      match_key: trimmed(body?.match_key, 60),
      source: trimmed(body?.source, 60) || 'Match scout',
      summary,
      detail: trimmed(body?.detail),
      severity: observedUrgent ? 'urgent' : (requested || 'watch'),
      resolved: false,
      created_by: actorId
    },
    error: null
  };
}
