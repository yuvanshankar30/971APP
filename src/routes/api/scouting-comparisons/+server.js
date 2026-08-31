import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { normalizePairwiseVote } from '$lib/server/scoutingComparisonSchema.js';

function requestClient(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

function isMissingVotesTable(error) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /(relation|table).*scouting_pairwise_votes.*(does not exist|schema cache)|scouting_pairwise_votes.*(does not exist|schema cache)/i.test(error?.message || '');
}

async function actorFor(client) {
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

export async function GET({ request, url }) {
  const auth = requestClient(request);
  const actor = await actorFor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });

  // Keep this query on the request-scoped client so RLS remains the actual
  // authorization boundary. A service-role fallback would let any signed-in,
  // unapproved account bypass approved_user().
  const { data, error } = await auth
    .from('scouting_pairwise_votes')
    .select('team_a_key,team_b_key,winner_team_key')
    .eq('event_key', eventKey)
    .order('updated_at', { ascending: true });
  // The rankings themselves do not depend on pairwise votes. Let deployments
  // that have not yet applied the optional consensus migration keep working.
  if (error && isMissingVotesTable(error)) return json({ success: true, data: [], unavailable: true });
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data: data || [] });
}

export async function POST({ request }) {
  const auth = requestClient(request);
  const actor = await actorFor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (body?.action !== 'vote') return json({ error: 'Invalid action' }, { status: 400 });
  const { value, error: invalid } = normalizePairwiseVote(body, actor.id);
  if (invalid) return json({ error: invalid }, { status: 400 });

  const { data, error } = await auth
    .from('scouting_pairwise_votes')
    .upsert(value, { onConflict: 'event_key,team_a_key,team_b_key,created_by' })
    .select('team_a_key,team_b_key,winner_team_key')
    .single();
  if (error && isMissingVotesTable(error)) {
    return json({
      error: 'Human comparison voting is unavailable until the scouting pairwise-votes migration is applied.',
      code: 'SCOUTING_PAIRWISE_VOTES_UNAVAILABLE'
    }, { status: 503 });
  }
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data });
}
