import { json } from '@sveltejs/kit';
import { assertScopedEvent, requestClient, requireActor } from '$lib/server/predictionMarketV2.js';

export async function GET({ request, url }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });
  try {
    await assertScopedEvent(eventKey);
    const { data, error } = await auth.from('pm_match_picks').select('id,user_id,event_key,match_key,side,picked_at,locked').eq('event_key', eventKey).eq('user_id', actor.id).order('picked_at', { ascending: false });
    if (error) throw error;
    return json(data || []);
  } catch (error) {
    return json({ error: error.message || 'Unable to load predictions' }, { status: 500 });
  }
}
