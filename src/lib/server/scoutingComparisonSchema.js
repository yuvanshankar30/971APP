import { normalizeTeamKey } from './matchScoutingSchema.js';

function trimmed(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

export function normalizePairwiseVote(body, actorId) {
  const event_key = trimmed(body?.event_key, 60);
  const first = normalizeTeamKey(body?.team_a_key);
  const second = normalizeTeamKey(body?.team_b_key);
  const winner = normalizeTeamKey(body?.winner_team_key);

  if (!event_key) return { value: null, error: 'event_key is required' };
  if (!first || !second) return { value: null, error: 'Two valid team keys are required' };
  if (first === second) return { value: null, error: 'Choose two different teams' };
  if (winner !== first && winner !== second) {
    return { value: null, error: 'winner_team_key must be one of the compared teams' };
  }
  if (!actorId) return { value: null, error: 'An authenticated scout is required' };

  const [team_a_key, team_b_key] = [first, second].sort((a, b) => {
    const numberA = Number(a.slice(3));
    const numberB = Number(b.slice(3));
    return numberA - numberB;
  });

  return {
    value: {
      event_key,
      team_a_key,
      team_b_key,
      winner_team_key: winner,
      created_by: actorId,
      updated_at: new Date().toISOString()
    },
    error: null
  };
}
