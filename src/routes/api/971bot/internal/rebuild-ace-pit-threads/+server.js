import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { rebuildQueuedAcePitCompetitionThreads } from '$lib/server/ace_pit_notifications.js';

function userClient(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

// Admin-only maintenance action used when migrating from one top-level Slack
// message per report to one durable thread per competition. It never accepts
// message coordinates from the caller; only the server-side cleanup queue is
// consumed, so it cannot be turned into an arbitrary Slack deletion endpoint.
export async function POST({ request }) {
  const authClient = userClient(request);
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

  const supa = getSupabase();
  const { data: caller } = await supa.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  if (caller?.role !== 'admin') return json({ error: 'Admin only' }, { status: 403 });

  try {
    return json(await rebuildQueuedAcePitCompetitionThreads());
  } catch (error) {
    return json({ ok: false, error: error?.data?.error || error?.message || String(error) }, { status: 500 });
  }
}
