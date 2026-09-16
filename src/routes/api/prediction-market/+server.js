import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { getSupabase } from '$lib/server/971bot.js';
import { availableBalance, isTestMarketKey, settleMarket } from '$lib/predictionMarket.js';

const COLUMNS = 'id,event_key,market_key,market_type,outcome_key,created_by,stake,placed_at,updated_at,resolved_at,payout,winning_outcome';
const missing = (error) => error?.code === '42P01' || error?.code === 'PGRST205' || /prediction_market_(positions|ticks).*does not exist/i.test(error?.message || '');
function requestClient(request) { return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, { global: { headers: { Authorization: request.headers.get('authorization') || '' } } }); }
function dbFor(fallback) { try { return getSupabase(); } catch { return fallback; } }
async function actorFor(client) { const { data } = await client.auth.getUser(); return data?.user || null; }
async function tba(path) {
  const key = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!key) return null;
  const response = await fetch(`https://www.thebluealliance.com/api/v3${path}`, { headers: { 'X-TBA-Auth-Key': key } }).catch(() => null);
  return response?.ok ? response.json() : null;
}
const pools = (rows) => rows.reduce((result, row) => ({ ...result, [row.outcome_key]: Number(result[row.outcome_key] || 0) + Number(row.stake || 0) }), {});
async function snapshot(db, eventKey, marketKey) {
  const { data } = await db.from('prediction_market_positions').select('outcome_key,stake').eq('event_key', eventKey).eq('market_key', marketKey).is('resolved_at', null);
  await db.from('prediction_market_ticks').insert({ event_key: eventKey, market_key: marketKey, pools: pools(data || []) });
}
async function settleResolvedMarkets(db, eventKey) {
  const { data: pending } = await db.from('prediction_market_positions').select(COLUMNS).eq('event_key', eventKey).is('resolved_at', null);
  if (!pending?.length) return;
  const groups = new Map();
  for (const position of pending) groups.set(position.market_key, [...(groups.get(position.market_key) || []), position]);
  for (const [marketKey, positions] of groups) {
    let winner = null;
    if (positions[0].market_type === 'practice') continue;
    if (positions[0].market_type === 'match_winner') {
      const match = await tba(`/match/${encodeURIComponent(marketKey.replace(/^match:/, ''))}/simple`);
      if (match?.actual_time && match.winning_alliance) winner = match.winning_alliance;
    } else if (marketKey === 'qualification-rank-1') {
      const matches = await tba(`/event/${encodeURIComponent(eventKey)}/matches/simple`);
      if (Array.isArray(matches) && matches.filter((match) => match.comp_level === 'qm').every((match) => match.actual_time)) {
        const rankings = await tba(`/event/${encodeURIComponent(eventKey)}/rankings`);
        winner = rankings?.rankings?.[0]?.team_key || null;
      }
    }
    if (!winner) continue;
    for (const result of settleMarket(positions, winner)) await db.from('prediction_market_positions').update({ resolved_at: new Date().toISOString(), payout: result.payout, winning_outcome: winner }).eq('id', result.id).is('resolved_at', null);
    await snapshot(db, eventKey, marketKey);
  }
}
function validRequest(body) {
  const eventKey = String(body?.event_key || '').trim(); const marketKey = String(body?.market_key || '').trim(); const marketType = String(body?.market_type || '').trim(); const outcomeKey = String(body?.outcome_key || '').trim(); const stake = Number(body?.stake);
  if (!eventKey || !marketKey || !outcomeKey || !Number.isFinite(stake) || stake < 1 || stake > 1000) return { error: 'Choose an outcome and wager between 1 and 1,000 points.' };
  if (marketType === 'match_winner' && /^match:[\w-]+$/.test(marketKey) && ['red', 'blue'].includes(outcomeKey)) return { value: { eventKey, marketKey, marketType, outcomeKey, stake } };
  if (marketType === 'practice' && /^match:[\w-]+$/.test(marketKey) && isTestMarketKey(marketKey, eventKey) && ['red', 'blue'].includes(outcomeKey)) return { value: { eventKey, marketKey, marketType, outcomeKey, stake } };
  if (marketType === 'qualification_rank' && marketKey === 'qualification-rank-1' && /^frc\d+$/.test(outcomeKey)) return { value: { eventKey, marketKey, marketType, outcomeKey, stake } };
  return { error: 'That market is not available.' };
}

export async function GET({ request, url }) {
  const auth = requestClient(request); const actor = await actorFor(auth); if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const eventKey = String(url.searchParams.get('event_key') || '').trim(); if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });
  const db = dbFor(auth); await settleResolvedMarkets(db, eventKey);
  const { data: positions, error } = await auth.from('prediction_market_positions').select(COLUMNS).eq('event_key', eventKey).order('updated_at', { ascending: false });
  if (missing(error)) return json({ success: true, data: { positions: [], ticks: [] }, unavailable: true }); if (error) return json({ error: error.message }, { status: 500 });
  const { data: ticks } = await auth.from('prediction_market_ticks').select('event_key,market_key,captured_at,pools').eq('event_key', eventKey).order('captured_at', { ascending: true });
  return json({ success: true, data: { positions: positions || [], ticks: ticks || [] } });
}
export async function POST({ request }) {
  const auth = requestClient(request); const actor = await actorFor(auth); if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (body?.action === 'cancel') {
    const { error } = await auth.from('prediction_market_positions').delete().eq('id', String(body.id || '')).eq('created_by', actor.id).is('resolved_at', null);
    if (error) return json({ error: error.message }, { status: 500 }); return json({ success: true });
  }
  const { value, error: invalid } = validRequest(body); if (invalid) return json({ error: invalid }, { status: 400 });
  if (value.market_type === 'match_winner') {
    const match = await tba(`/match/${encodeURIComponent(value.market_key.replace(/^match:/, ''))}/simple`);
    if (!match || match.event_key !== value.eventKey) return json({ error: 'That match is not part of this event.' }, { status: 400 });
    if (match.actual_time) return json({ error: 'This market is locked: the match has already played.' }, { status: 409 });
    const lockTime = match.predicted_time ?? match.time ?? null;
    if (lockTime && Date.now() / 1000 >= lockTime) return json({ error: 'This market is locked: the match has started.' }, { status: 409 });
  } else if (value.market_type === 'qualification_rank') {
    const eventTeams = await tba(`/event/${encodeURIComponent(value.eventKey)}/teams/keys`);
    if (!Array.isArray(eventTeams) || !eventTeams.includes(value.outcomeKey)) return json({ error: 'Choose a team that is competing at this event.' }, { status: 400 });
  }
  const { data: existing, error: readError } = await auth.from('prediction_market_positions').select(COLUMNS).eq('event_key', value.eventKey).eq('created_by', actor.id);
  if (missing(readError)) return json({ error: 'Apply the prediction-market v2 migration first.', code: 'PREDICTION_MARKET_UNAVAILABLE' }, { status: 503 }); if (readError) return json({ error: readError.message }, { status: 500 });
  const edited = (existing || []).find((row) => row.market_key === value.marketKey);
  if (value.stake > availableBalance(existing || [], actor.id, edited?.id)) return json({ error: 'That wager exceeds your available balance.' }, { status: 400 });
  const { data, error } = await auth.from('prediction_market_positions').upsert({ event_key: value.eventKey, market_key: value.marketKey, market_type: value.marketType, outcome_key: value.outcomeKey, stake: value.stake, created_by: actor.id, updated_at: new Date().toISOString(), resolved_at: null, payout: null, winning_outcome: null }, { onConflict: 'event_key,market_key,created_by' }).select(COLUMNS).single();
  if (error) return json({ error: error.message }, { status: 500 }); await snapshot(dbFor(auth), value.eventKey, value.marketKey); return json({ success: true, data });
}
