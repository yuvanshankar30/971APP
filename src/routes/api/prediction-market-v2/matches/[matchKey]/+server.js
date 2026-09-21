import { json } from '@sveltejs/kit';
import { eventKeyFromMatchKey, eventModel, fetchScopedEventMatches, requestClient, requireActor, resolutionClient, resolveOutstandingElo } from '$lib/server/predictionMarketV2.js';

export async function GET({ request, params }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const matchKey = String(params.matchKey || '').trim();
  const eventKey = eventKeyFromMatchKey(matchKey);
  if (!eventKey) return json({ error: 'Invalid match key' }, { status: 400 });
  try {
    const { matches } = await fetchScopedEventMatches(eventKey);
    const match = matches.find((candidate) => candidate.key === matchKey);
    if (!match) return json({ error: 'Match not found' }, { status: 404 });
    await resolveOutstandingElo(resolutionClient(auth), eventKey, matches);
    const [{ data: picks, error: picksError }, { data: history, error: historyError }] = await Promise.all([
      auth.from('pm_match_picks').select('user_id,side,picked_at').eq('event_key', eventKey).eq('match_key', matchKey).order('picked_at'),
      auth.from('pm_elo_history').select('model_probability').eq('event_key', eventKey).eq('match_key', matchKey).eq('user_id', actor.id).maybeSingle()
    ]);
    if (picksError || historyError) throw picksError || historyError;
    const modelProbabilityRed = eventModel(matches).get(matchKey) ?? 0.5;
    const ownPick = (picks || []).find((pick) => pick.user_id === actor.id)?.side || null;
    let red = 0;
    const eloHistorySeries = (picks || []).map((pick, index) => {
      if (pick.side === 'red') red += 1;
      const total = index + 1;
      return { t: pick.picked_at, model_prob: modelProbabilityRed, community_prob: total ? red / total : 0 };
    });
    const total = (picks || []).length;
    return json({
      match_key: matchKey,
      red_teams: match?.alliances?.red?.team_keys || [],
      blue_teams: match?.alliances?.blue?.team_keys || [],
      model_probability_red: modelProbabilityRed,
      my_pick: ownPick,
      model_probability_at_my_pick: history?.model_probability ?? (ownPick === 'blue' ? 1 - modelProbabilityRed : ownPick ? modelProbabilityRed : null),
      community_breakdown: { red, blue: total - red, total },
      elo_history_series: eloHistorySeries
    });
  } catch (error) {
    return json({ error: error.message || 'Unable to load match' }, { status: 500 });
  }
}
