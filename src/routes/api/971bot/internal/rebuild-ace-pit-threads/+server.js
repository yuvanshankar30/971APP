import { json } from '@sveltejs/kit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { rebuildQueuedAcePitCompetitionThreads } from '$lib/server/ace_pit_notifications.js';

function userClient(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

function matchesHash(token, expectedHash) {
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const expected = Buffer.from(String(expectedHash || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Admin-only maintenance action used when migrating from one top-level Slack
// message per report to one durable thread per competition. It never accepts
// message coordinates from the caller; only the server-side cleanup queue is
// consumed, so it cannot be turned into an arbitrary Slack deletion endpoint.
export async function POST({ request }) {
  const authClient = userClient(request);
  const { data: { user } } = await authClient.auth.getUser();
  const supa = getSupabase();
  let authorized = false;
  if (user) {
    const { data: caller } = await supa.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
    authorized = caller?.role === 'admin';
  }

  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (!authorized && bearer) {
    const { data: grant } = await supa
      .from('ace_pit_cleanup_authorizations')
      .select('token_hash, expires_at, used_at')
      .eq('purpose', 'legacy-slack-thread-cleanup')
      .maybeSingle();
    authorized = Boolean(
      grant
      && !grant.used_at
      && new Date(grant.expires_at).getTime() > Date.now()
      && matchesHash(bearer, grant.token_hash)
    );
  }
  if (!authorized) return json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const result = await rebuildQueuedAcePitCompetitionThreads();
    if (bearer) {
      await supa
        .from('ace_pit_cleanup_authorizations')
        .update({ used_at: new Date().toISOString() })
        .eq('purpose', 'legacy-slack-thread-cleanup')
        .is('used_at', null);
    }
    return json(result);
  } catch (error) {
    return json({ ok: false, error: error?.data?.error || error?.message || String(error) }, { status: 500 });
  }
}
