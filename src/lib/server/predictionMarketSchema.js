// TBA match keys look like "2026arc_qm12", "2026arc_sf1m2", "2026arc_f1m1" -
// always the event key, an underscore, then the level/number.
const MATCH_KEY_PATTERN = /^[a-z0-9]+_[a-z0-9]+$/i;

// No real bettor will ever legitimately need more than this in one wager -
// a hard ceiling independent of availableBalance() so a malformed or
// absurd client value (e.g. 1e20) can never reach the database and corrupt
// every downstream sum/leaderboard number, even before the balance check.
export const MAX_STAKE = 1_000_000;

function trimmed(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

export function normalizeBetRequest(body) {
  const event_key = trimmed(body?.event_key, 60);
  const match_key = trimmed(body?.match_key, 60);
  const side = String(body?.side || '').trim().toLowerCase();
  const stake = Math.round(Number(body?.stake) * 100) / 100;

  if (!event_key) return { value: null, error: 'event_key is required' };
  if (!match_key || !MATCH_KEY_PATTERN.test(match_key)) return { value: null, error: 'A valid match_key is required (e.g. 2026arc_qm12)' };
  // A match_key belongs to exactly one event by TBA's own convention (the
  // event key is its prefix) - rejecting a mismatch here stops a bet from
  // ever being scoped to the wrong event, before it becomes a confusing
  // leaderboard entry no one can explain later.
  if (!match_key.toLowerCase().startsWith(`${event_key.toLowerCase()}_`)) {
    return { value: null, error: 'match_key must belong to the given event_key' };
  }
  if (side !== 'red' && side !== 'blue') return { value: null, error: 'side must be "red" or "blue"' };
  if (!Number.isFinite(stake) || stake <= 0) return { value: null, error: 'stake must be a positive number' };
  if (stake > MAX_STAKE) return { value: null, error: `stake cannot exceed ${MAX_STAKE}` };

  return { value: { event_key, match_key, side, stake }, error: null };
}
