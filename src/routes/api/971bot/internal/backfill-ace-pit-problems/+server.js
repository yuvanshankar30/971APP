import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { backfillUnsentAcePitProblems } from '$lib/server/ace_pit_notifications.js';

function userClient(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

// Admin-only one-time catch-up, run once after re-enabling ACE Slack
// notifications: posts every pit_problem_reports row that still has no
// slack_notified_at (i.e. every report filed while notifications were
// disabled) into the #2026-ace-pit-bot thread, oldest first, so today's
// backlog isn't silently missing from the thread.
export async function POST({ request }) {
  const authClient = userClient(request);
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

  const supa = getSupabase();
  const { data: caller } = await supa.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  if (caller?.role !== 'admin') return json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const result = await backfillUnsentAcePitProblems();
    return json(result);
  } catch (error) {
    return json({ ok: false, error: error?.data?.error || error?.message || String(error) }, { status: 500 });
  }
}
