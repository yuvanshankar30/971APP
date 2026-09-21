import { json } from '@sveltejs/kit';
import { assertScopedEvent, requestClient, requireActor } from '$lib/server/predictionMarketV2.js';

export async function POST({ request }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const eventKey = String(body?.event_key || '').trim();
  const emoji = String(body?.emoji || '').trim();
  if (!eventKey || !emoji || emoji.length > 32) return json({ error: 'event_key and an emoji of at most 32 characters are required' }, { status: 400 });
  try {
    await assertScopedEvent(eventKey);
    const { data, error } = await auth.from('pm_reactions').insert({ user_id: actor.id, event_key: eventKey, emoji }).select('id,user_id,event_key,emoji,created_at').single();
    if (error) throw error;
    return json(data);
  } catch (error) {
    return json({ error: error.message || 'Unable to add reaction' }, { status: 500 });
  }
}
