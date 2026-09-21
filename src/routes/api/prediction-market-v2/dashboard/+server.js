import { json } from '@sveltejs/kit';
import { eventModel, fetchScopedEventMatches, publicMatch, requestClient, requireActor, resolutionClient, resolveOutstandingElo } from '$lib/server/predictionMarketV2.js';

export async function GET({ request, url }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });

  try {
    const { matches } = await fetchScopedEventMatches(eventKey);
    const db = resolutionClient(auth);
    await resolveOutstandingElo(db, eventKey, matches);
    const [{ data: picks, error: picksError }, { data: history, error: historyError }, { data: rating, error: ratingError }] = await Promise.all([
      auth.from('pm_match_picks').select('user_id,match_key,side,locked,picked_at').eq('event_key', eventKey),
      auth.from('pm_elo_history').select('elo_delta').eq('event_key', eventKey).eq('user_id', actor.id),
      auth.from('pm_elo_ratings').select('elo').eq('user_id', actor.id).maybeSingle()
    ]);
    if (picksError || historyError || ratingError) throw picksError || historyError || ratingError;
    const model = eventModel(matches);
    const matchRows = matches.map((match) => publicMatch(match, model.get(match.key) ?? 0.5, (picks || []).filter((pick) => pick.match_key === match.key), actor.id));
    const scored = history || [];
    const wins = scored.filter((row) => Number(row.elo_delta) > 0).length;
    return json({
      elo: Number(rating?.elo ?? 1000),
      active_predictions: (picks || []).filter((pick) => !pick.locked).length,
      accuracy: scored.length ? wins / scored.length : 0,
      scored_predictions: scored.length,
      matches: matchRows
    });
  } catch (error) {
    return json({ error: error.message || 'Unable to load prediction dashboard' }, { status: 500 });
  }
}
