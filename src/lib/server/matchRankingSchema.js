import { normalizeTeamKey } from './matchScoutingSchema.js';

function text(value, maxLength) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

// A submitted order is intentionally complete and unique. It produces every
// higher-over-lower comparison exactly once, so allowing duplicates would
// make a malformed ranking amplify one robot in the consensus calculation.
export function normalizeMatchRanking(body, actorId) {
  const event_key = text(body?.event_key, 60);
  const match_key = text(body?.match_key, 120);
  const rawTeams = Array.isArray(body?.ranked_team_keys) ? body.ranked_team_keys : [];
  const ranked_team_keys = rawTeams.map(normalizeTeamKey).filter(Boolean);

  if (!event_key) return { value: null, error: 'event_key is required' };
  if (!match_key) return { value: null, error: 'match_key is required' };
  if (ranked_team_keys.length < 2) return { value: null, error: 'Rank at least two teams' };
  if (ranked_team_keys.length > 6) return { value: null, error: 'A match ranking may include at most six teams' };
  if (new Set(ranked_team_keys).size !== ranked_team_keys.length) return { value: null, error: 'Each team may appear only once' };
  if (!actorId) return { value: null, error: 'An authenticated scout is required' };

  return {
    value: {
      event_key,
      match_key,
      ranked_team_keys,
      updated_by: actorId,
      updated_at: new Date().toISOString()
    },
    error: null
  };
}
