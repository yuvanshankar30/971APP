import { normalizeTeamKey } from './matchScoutingSchema.js';

const OPTIONAL_RATING_FIELDS = ['auto_rating', 'offense_rating', 'shuttling_rating', 'driving_rating', 'defense_rating'];

function trimmed(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

// A blank/omitted rating means "not entered" (optional fields) or is caught
// by the caller as missing (overall_rating). Anything else must be a whole
// number 1-10 - NaN signals "present but invalid" so callers can tell that
// apart from "left blank".
function parseRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? number : NaN;
}

export function normalizeRobotRating(body, actorId) {
  const event_key = trimmed(body?.event_key, 60);
  const team_key = normalizeTeamKey(body?.team_key);
  if (!event_key) return { value: null, error: 'event_key is required' };
  if (!team_key) return { value: null, error: 'A valid team_key is required (e.g. frc971)' };
  if (!actorId) return { value: null, error: 'An authenticated scout is required' };

  const overall_rating = parseRating(body?.overall_rating);
  if (overall_rating === null || Number.isNaN(overall_rating) || overall_rating < 1 || overall_rating > 10) {
    return { value: null, error: 'overall_rating must be a whole number from 1 to 10' };
  }

  const optional = {};
  for (const field of OPTIONAL_RATING_FIELDS) {
    const parsed = parseRating(body?.[field]);
    if (parsed === null) { optional[field] = null; continue; }
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 10) {
      return { value: null, error: `${field} must be a whole number from 1 to 10, or left blank` };
    }
    optional[field] = parsed;
  }

  const providedTeamNumber = Number(body?.team_number);
  const team_number = Number.isFinite(providedTeamNumber) ? providedTeamNumber : Number(team_key.slice(3)) || null;

  return {
    value: {
      event_key,
      team_key,
      team_number,
      overall_rating,
      ...optional,
      notes: trimmed(body?.notes, 4000),
      strategy_notes: trimmed(body?.strategy_notes, 4000),
      created_by: actorId,
      updated_at: new Date().toISOString()
    },
    error: null
  };
}
