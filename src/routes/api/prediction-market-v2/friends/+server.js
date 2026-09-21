import { json } from '@sveltejs/kit';
import { requestClient, requireActor } from '$lib/server/predictionMarketV2.js';

export async function GET({ request }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await auth.from('pm_friends').select('user_id,friend_id,status,created_at').or(`user_id.eq.${actor.id},friend_id.eq.${actor.id}`).order('created_at', { ascending: false });
  if (error) return json({ error: error.message }, { status: 500 });
  return json(data || []);
}

export async function POST({ request }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const friendId = String(body?.friend_id || '').trim();
  if (!friendId || friendId === actor.id) return json({ error: 'A different friend_id is required' }, { status: 400 });
  const { data, error } = await auth.from('pm_friends').upsert({ user_id: actor.id, friend_id: friendId, status: 'pending' }, { onConflict: 'user_id,friend_id' }).select('user_id,friend_id,status,created_at').single();
  if (error) return json({ error: error.message }, { status: 500 });
  return json(data);
}
