import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { computeEventEpa, winProbability } from '$lib/epaModel.js';
import { FRC_TEAMS } from '$lib/permissions.js';
import { getSupabase } from '$lib/server/971bot.js';

export const ELO_K = 32;
const TEAM_KEYS = [`frc${FRC_TEAMS.TEAM_971}`, `frc${FRC_TEAMS.TEAM_9584}`];

export function requestClient(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

export async function requireActor(client) {
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

export function resolutionClient(fallbackClient) {
  try {
    return getSupabase();
  } catch {
    return fallbackClient;
  }
}

function tbaHeaders() {
  const key = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!key) throw new Error('Server missing TBA_API_KEY');
  return { 'X-TBA-Auth-Key': key };
}

async function fetchTba(path) {
  const response = await fetch(`https://www.thebluealliance.com/api/v3/${path}`, { headers: tbaHeaders() });
  if (!response.ok) throw new Error(`TBA upstream error ${response.status}`);
  return response.json();
}

function eventYear(eventKey) {
  const value = String(eventKey || '').trim();
  return /^20\d{2}/.test(value) ? value.slice(0, 4) : null;
}

export async function assertScopedEvent(eventKey) {
  const key = String(eventKey || '').trim();
  const year = eventYear(key);
  if (!year) throw new Error('event_key must begin with a four-digit FRC year');
  const lists = await Promise.all(TEAM_KEYS.map((teamKey) => fetchTba(`team/${encodeURIComponent(teamKey)}/events/${year}/simple`)));
  const allowed = lists.flat().some((event) => event?.key === key);
  if (!allowed) throw new Error('This event is not registered for FRC 971 or FRC 9584');
  return key;
}

export async function fetchScopedEventMatches(eventKey) {
  const key = await assertScopedEvent(eventKey);
  const matches = await fetchTba(`event/${encodeURIComponent(key)}/matches`);
  return { eventKey: key, matches: Array.isArray(matches) ? matches : [] };
}

export async function fetchScopedAlliances(eventKey) {
  const key = await assertScopedEvent(eventKey);
  try {
    const alliances = await fetchTba(`event/${encodeURIComponent(key)}/alliances`);
    return { eventKey: key, alliances: Array.isArray(alliances) ? alliances : [] };
  } catch (error) {
    if (/404/.test(error.message || '')) return { eventKey: key, alliances: [] };
    throw error;
  }
}

export function isCompletedMatch(match) {
  return Boolean(match?.actual_time) && ['red', 'blue', ''].includes(match?.winning_alliance);
}

export function matchLockTime(match) {
  const time = Number(match?.predicted_time ?? match?.time ?? 0);
  return Number.isFinite(time) && time > 0 ? time : null;
}

export function matchStatus(match, now = Date.now() / 1000) {
  if (isCompletedMatch(match)) return 'completed';
  const lockTime = matchLockTime(match);
  return lockTime && now >= lockTime ? 'locked' : 'upcoming';
}

export function eventModel(matches) {
  const epa = computeEventEpa(matches);
  const probabilities = new Map();
  for (const match of matches || []) {
    const red = (match?.alliances?.red?.team_keys || []).reduce((sum, team) => sum + (epa.get(team)?.epa || 0), 0);
    const blue = (match?.alliances?.blue?.team_keys || []).reduce((sum, team) => sum + (epa.get(team)?.epa || 0), 0);
    probabilities.set(match.key, winProbability(red, blue));
  }
  return probabilities;
}

export async function lockStartedPicks(db, eventKey, matches) {
  const now = Date.now() / 1000;
  for (const match of matches || []) {
    const lockTime = matchLockTime(match);
    if (!lockTime || lockTime > now) continue;
    await db.from('pm_match_picks').update({ locked: true }).eq('event_key', eventKey).eq('match_key', match.key).eq('locked', false);
  }
}

export function communityBreakdown(picks) {
  const red = (picks || []).filter((pick) => pick.side === 'red').length;
  const blue = (picks || []).filter((pick) => pick.side === 'blue').length;
  const total = red + blue;
  return { red, blue, total };
}

export function publicMatch(match, modelProbabilityRed, picks, actorId) {
  const breakdown = communityBreakdown(picks);
  const myPick = (picks || []).find((pick) => pick.user_id === actorId)?.side || null;
  return {
    match_key: match.key,
    red_teams: match?.alliances?.red?.team_keys || [],
    blue_teams: match?.alliances?.blue?.team_keys || [],
    model_probability_red: modelProbabilityRed,
    my_pick: myPick,
    community_red_pct: breakdown.total ? breakdown.red / breakdown.total : 0,
    community_blue_pct: breakdown.total ? breakdown.blue / breakdown.total : 0,
    status: matchStatus(match)
  };
}

function historyKey(row) {
  return `${row.user_id}:${row.event_key}:${row.match_key}`;
}

function isDuplicate(error) {
  return error?.code === '23505' || /duplicate key/i.test(error?.message || '');
}

export function eloDelta(pickedSide, winningSide, modelProbabilityRed) {
  const probability = pickedSide === 'red' ? modelProbabilityRed : 1 - modelProbabilityRed;
  const actual = pickedSide === winningSide ? 1 : 0;
  return { probability, delta: ELO_K * (actual - probability) };
}

export async function resolveOutstandingElo(db, eventKey, matches) {
  await lockStartedPicks(db, eventKey, matches);
  const { data: picks, error: picksError } = await db
    .from('pm_match_picks')
    .select('id,user_id,event_key,match_key,side,picked_at,locked')
    .eq('event_key', eventKey);
  if (picksError) throw picksError;

  const { data: history, error: historyError } = await db
    .from('pm_elo_history')
    .select('user_id,event_key,match_key')
    .eq('event_key', eventKey);
  if (historyError) throw historyError;

  const resolved = new Set((history || []).map(historyKey));
  const byMatch = new Map();
  for (const pick of picks || []) {
    if (!byMatch.has(pick.match_key)) byMatch.set(pick.match_key, []);
    byMatch.get(pick.match_key).push(pick);
  }

  const probabilities = eventModel(matches);
  for (const match of matches || []) {
    if (!isCompletedMatch(match)) continue;
    const matchPicks = byMatch.get(match.key) || [];
    if (!matchPicks.length) continue;
    await db.from('pm_match_picks').update({ locked: true }).eq('event_key', eventKey).eq('match_key', match.key).eq('locked', false);
    const modelProbabilityRed = probabilities.get(match.key) ?? 0.5;

    for (const pick of matchPicks) {
      if (resolved.has(historyKey(pick))) continue;
      const { probability, delta } = eloDelta(pick.side, match.winning_alliance, modelProbabilityRed);
      const { data: rating, error: ratingError } = await db
        .from('pm_elo_ratings')
        .select('elo,events_participated')
        .eq('user_id', pick.user_id)
        .maybeSingle();
      if (ratingError) throw ratingError;
      const currentElo = Number(rating?.elo ?? 1000);
      const eloAfter = currentElo + delta;
      const { error: insertError } = await db.from('pm_elo_history').insert({
        user_id: pick.user_id,
        event_key: eventKey,
        match_key: match.key,
        picked_side: pick.side,
        model_probability: probability,
        elo_delta: delta,
        elo_after: eloAfter
      });
      if (insertError) {
        if (isDuplicate(insertError)) continue;
        throw insertError;
      }
      const { data: userHistory, error: userHistoryError } = await db
        .from('pm_elo_history')
        .select('event_key')
        .eq('user_id', pick.user_id);
      if (userHistoryError) throw userHistoryError;
      const eventsParticipated = new Set((userHistory || []).map((row) => row.event_key)).size;
      const { error: ratingWriteError } = await db.from('pm_elo_ratings').upsert({
        user_id: pick.user_id,
        elo: eloAfter,
        events_participated: eventsParticipated,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      if (ratingWriteError) throw ratingWriteError;
      resolved.add(historyKey(pick));
    }
  }
}

export async function resolveAllianceDraft(db, eventKey) {
  const { alliances } = await fetchScopedAlliances(eventKey);
  if (!alliances.length) return;
  const { data: pending, error } = await db
    .from('pm_alliance_draft_picks')
    .select('id,predicted_captain,predicted_pick,pick_round')
    .eq('event_key', eventKey)
    .is('resolved_at', null);
  if (error) throw error;
  const resolvedAt = new Date().toISOString();
  for (const prediction of pending || []) {
    const correct = alliances.some((alliance) => {
      const picks = alliance?.picks || [];
      return picks[0] === prediction.predicted_captain && picks[prediction.pick_round] === prediction.predicted_pick;
    });
    await db.from('pm_alliance_draft_picks').update({ resolved_at: resolvedAt, correct }).eq('id', prediction.id).is('resolved_at', null);
  }
}

export function eventKeyFromMatchKey(matchKey) {
  const value = String(matchKey || '').trim();
  const separator = value.lastIndexOf('_');
  return separator > 4 ? value.slice(0, separator) : null;
}

export async function profileNames(db, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await db.from('user_profiles').select('id,full_name,email').in('id', ids);
  if (error) throw error;
  return new Map((data || []).map((profile) => [profile.id, profile.full_name || profile.email || profile.id]));
}
