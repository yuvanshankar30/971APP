import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { getSupabase } from '$lib/server/971bot.js';
import { normalizeBetRequest } from '$lib/server/predictionMarketSchema.js';
import { availableBalance, resolvePariMutuel } from '$lib/predictionMarket.js';

const SELECT_COLUMNS = 'id,event_key,match_key,created_by,side,stake,placed_at,updated_at,resolved_at,payout,winning_side';

function requestClient(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

// Resolving a match's bets has to update every bettor's row, not just the
// caller's own - RLS only ever lets an authenticated user touch their own
// bet, by design (see the migration). The service-role client bypasses RLS
// for exactly this. When no service key is configured, falling back to the
// per-request client still lets each user's own bets resolve as they load
// this page themselves - a slower, eventually-consistent path, not a broken
// one.
function getDbClient(fallbackClient) {
  try {
    return getSupabase();
  } catch {
    return fallbackClient;
  }
}

function isMissingBetsTable(error) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /(relation|table).*prediction_market_bets.*(does not exist|schema cache)|prediction_market_bets.*(does not exist|schema cache)/i.test(error?.message || '');
}

async function actorFor(client) {
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

async function fetchTbaMatch(matchKey) {
  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return null;
  try {
    const response = await fetch(`https://www.thebluealliance.com/api/v3/match/${encodeURIComponent(matchKey)}/simple`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Resolves every outstanding bet whose match TBA now reports a result for.
// Idempotent - the `.is('resolved_at', null)` guard on each update means a
// second concurrent pass (another scout loading this same endpoint at the
// same moment) simply updates zero rows for anything already resolved,
// rather than double-paying anyone.
async function resolveOutstandingBets(db, eventKey) {
  const { data: pending, error } = await db
    .from('prediction_market_bets')
    .select(SELECT_COLUMNS)
    .eq('event_key', eventKey)
    .is('resolved_at', null);
  if (error || !pending?.length) return;

  const byMatch = new Map();
  for (const bet of pending) {
    if (!byMatch.has(bet.match_key)) byMatch.set(bet.match_key, []);
    byMatch.get(bet.match_key).push(bet);
  }

  for (const [matchKey, matchBets] of byMatch) {
    const match = await fetchTbaMatch(matchKey);
    // winning_alliance is '' for an unplayed match too (not just a tie) -
    // only trust it once TBA has also posted an actual play time, proof the
    // match really happened.
    if (!match?.actual_time) continue;
    const resolutions = resolvePariMutuel(matchBets, match.winning_alliance);
    for (const resolution of resolutions) {
      await db
        .from('prediction_market_bets')
        .update({ resolved_at: new Date().toISOString(), payout: resolution.payout, winning_side: resolution.winning_side })
        .eq('id', resolution.id)
        .is('resolved_at', null);
    }
  }
}

export async function GET({ request, url }) {
  const auth = requestClient(request);
  const actor = await actorFor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });

  const db = getDbClient(auth);
  await resolveOutstandingBets(db, eventKey);

  const { data, error } = await auth
    .from('prediction_market_bets')
    .select(SELECT_COLUMNS)
    .eq('event_key', eventKey)
    .order('placed_at', { ascending: false });
  if (error && isMissingBetsTable(error)) return json({ success: true, data: [], unavailable: true });
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data: data || [] });
}

export async function POST({ request }) {
  const auth = requestClient(request);
  const actor = await actorFor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);

  if (body?.action === 'cancel') {
    const id = String(body?.id || '').trim();
    if (!id) return json({ error: 'id is required' }, { status: 400 });
    const { error } = await auth.from('prediction_market_bets').delete().eq('id', id).eq('created_by', actor.id).is('resolved_at', null);
    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true });
  }

  if (body?.action !== 'bet') return json({ error: 'Invalid action' }, { status: 400 });

  const { value, error: invalid } = normalizeBetRequest(body);
  if (invalid) return json({ error: invalid }, { status: 400 });

  const match = await fetchTbaMatch(value.match_key);
  if (match?.actual_time) return json({ error: 'This match has already been played.' }, { status: 409 });

  const { data: existingBets, error: existingError } = await auth
    .from('prediction_market_bets')
    .select(SELECT_COLUMNS)
    .eq('event_key', value.event_key)
    .eq('created_by', actor.id);
  if (existingError && isMissingBetsTable(existingError)) {
    return json({
      error: 'The prediction market is unavailable until its migration is applied.',
      code: 'PREDICTION_MARKET_UNAVAILABLE'
    }, { status: 503 });
  }
  if (existingError) return json({ error: existingError.message }, { status: 500 });

  const editingId = (existingBets || []).find((bet) => bet.match_key === value.match_key)?.id || null;
  const ceiling = availableBalance(existingBets || [], actor.id, editingId);
  if (value.stake > ceiling) {
    return json({ error: `Only ${ceiling.toFixed(2)} available to wager - your balance is already committed to other pending bets.` }, { status: 400 });
  }

  const { data, error } = await auth
    .from('prediction_market_bets')
    .upsert({ ...value, created_by: actor.id, updated_at: new Date().toISOString(), resolved_at: null, payout: null, winning_side: null }, { onConflict: 'event_key,match_key,created_by' })
    .select(SELECT_COLUMNS)
    .single();
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ success: true, data });
}
