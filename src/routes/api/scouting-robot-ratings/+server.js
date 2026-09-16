import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { normalizeRobotRating } from '$lib/server/robotRatingSchema.js';

function requestClient(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

function isMissingRatingsTable(error) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /(relation|table).*scouting_robot_ratings.*(does not exist|schema cache)|scouting_robot_ratings.*(does not exist|schema cache)/i.test(error?.message || '');
}

async function actorFor(client) {
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

const SELECT_COLUMNS = 'id,event_key,team_key,team_number,created_by,overall_rating,offense_rating,shuttling_rating,driving_rating,defense_rating,notes,strategy_notes,created_at,updated_at';

export async function GET({ request, url }) {
  const auth = requestClient(request);
  const actor = await actorFor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });

  // Kept on the request-scoped client so RLS remains the actual
  // authorization boundary - a service-role fallback would let any
  // signed-in, unapproved account bypass approved_user().
  const { data, error } = await auth
    .from('scouting_robot_ratings')
    .select(SELECT_COLUMNS)
    .eq('event_key', eventKey)
    .order('updated_at', { ascending: false });
  // Ratings are an optional overlay - let deployments that have not yet
  // applied this migration keep the rest of scouting working.
  if (error && isMissingRatingsTable(error)) return json({ success: true, data: [], unavailable: true });
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data: data || [] });
}

export async function POST({ request }) {
  const auth = requestClient(request);
  const actor = await actorFor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);

  if (body?.action === 'delete') {
    const id = String(body?.id || '').trim();
    if (!id) return json({ error: 'id is required' }, { status: 400 });
    // RLS also enforces this, but scoping the delete to the actor here keeps
    // the intent explicit: a scout can only remove their own rating.
    const { error } = await auth.from('scouting_robot_ratings').delete().eq('id', id).eq('created_by', actor.id);
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true });
  }

  if (body?.action !== 'rate') return json({ error: 'Invalid action' }, { status: 400 });

  const { value, error: invalid } = normalizeRobotRating(body, actor.id);
  if (invalid) return json({ error: invalid }, { status: 400 });

  const { data, error } = await auth
    .from('scouting_robot_ratings')
    .upsert(value, { onConflict: 'event_key,team_key,created_by' })
    .select(SELECT_COLUMNS)
    .single();
  if (error && isMissingRatingsTable(error)) {
    return json({
      error: 'Robot ratings are unavailable until the scouting robot-ratings migration is applied.',
      code: 'SCOUTING_ROBOT_RATINGS_UNAVAILABLE'
    }, { status: 503 });
  }
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data });
}
