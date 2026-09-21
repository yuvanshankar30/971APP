import { json } from '@sveltejs/kit';
import { fetchScopedEventMatches, profileNames, requestClient, requireActor, resolutionClient, resolveOutstandingElo } from '$lib/server/predictionMarketV2.js';

export async function GET({ request, url }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  try {
    if (eventKey) {
      const { matches } = await fetchScopedEventMatches(eventKey);
      await resolveOutstandingElo(resolutionClient(auth), eventKey, matches);
    }
    const historyQuery = auth.from('pm_elo_history').select('user_id,event_key,elo_delta');
    if (eventKey) historyQuery.eq('event_key', eventKey);
    const [{ data: history, error: historyError }, { data: ratings, error: ratingsError }] = await Promise.all([
      historyQuery,
      auth.from('pm_elo_ratings').select('user_id,elo')
    ]);
    if (historyError || ratingsError) throw historyError || ratingsError;
    const byUser = new Map();
    for (const entry of history || []) {
      const row = byUser.get(entry.user_id) || { wins: 0, losses: 0 };
      if (Number(entry.elo_delta) > 0) row.wins += 1;
      else row.losses += 1;
      byUser.set(entry.user_id, row);
    }
    const names = await profileNames(resolutionClient(auth), [...byUser.keys()]);
    const ratingByUser = new Map((ratings || []).map((rating) => [rating.user_id, Number(rating.elo)]));
    return json([...byUser.entries()]
      .map(([userId, score]) => ({ user_id: userId, name: names.get(userId) || userId, elo: ratingByUser.get(userId) ?? 1000, ...score }))
      .sort((left, right) => right.elo - left.elo || right.wins - left.wins || left.name.localeCompare(right.name)));
  } catch (error) {
    return json({ error: error.message || 'Unable to load leaderboard' }, { status: 500 });
  }
}
