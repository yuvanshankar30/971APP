import { json } from '@sveltejs/kit';
import { fetchScopedEventMatches, matchStatus, requestClient, requireActor } from '$lib/server/predictionMarketV2.js';

export async function POST({ request }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const eventKey = String(body?.event_key || '').trim();
  const matchKey = String(body?.match_key || '').trim();
  const side = String(body?.side || '').trim().toLowerCase();
  if (!eventKey || !matchKey || !['red', 'blue'].includes(side)) return json({ error: 'event_key, match_key, and side (red or blue) are required' }, { status: 400 });

  try {
    const { matches } = await fetchScopedEventMatches(eventKey);
    const match = matches.find((candidate) => candidate.key === matchKey);
    if (!match) return json({ error: 'Match does not belong to this event' }, { status: 400 });
    if (matchStatus(match) !== 'upcoming') return json({ error: 'This match is locked' }, { status: 409 });
    const { data, error } = await auth.from('pm_match_picks').upsert({
      user_id: actor.id,
      event_key: eventKey,
      match_key: matchKey,
      side,
      picked_at: new Date().toISOString(),
      locked: false
    }, { onConflict: 'user_id,event_key,match_key' }).select('id,user_id,event_key,match_key,side,picked_at,locked').single();
    if (error) throw error;
    return json(data);
  } catch (error) {
    return json({ error: error.message || 'Unable to save prediction' }, { status: 500 });
  }
}
