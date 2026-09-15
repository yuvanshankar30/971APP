// TBA match keys look like "2026arc_qm12", "2026arc_sf1m2", "2026arc_f1m1".
const MATCH_KEY_PATTERN = /^[a-z0-9]+_[a-z0-9]+$/i;

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
  if (side !== 'red' && side !== 'blue') return { value: null, error: 'side must be "red" or "blue"' };
  if (!Number.isFinite(stake) || stake <= 0) return { value: null, error: 'stake must be a positive number' };

  return { value: { event_key, match_key, side, stake }, error: null };
}
