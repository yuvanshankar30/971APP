import { json } from '@sveltejs/kit';
import { assertScopedEvent, requestClient, requireActor, resolutionClient, resolveAllianceDraft } from '$lib/server/predictionMarketV2.js';

export async function GET({ request, url }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });
  try {
    await assertScopedEvent(eventKey);
    await resolveAllianceDraft(resolutionClient(auth), eventKey);
    const { data, error } = await auth.from('pm_alliance_draft_picks').select('id,user_id,event_key,predicted_captain,predicted_pick,pick_round,placed_at,resolved_at,correct').eq('event_key', eventKey).order('placed_at');
    if (error) throw error;
    return json(data || []);
  } catch (error) {
    return json({ error: error.message || 'Unable to load alliance draft' }, { status: 500 });
  }
}

export async function POST({ request }) {
  const auth = requestClient(request);
  const actor = await requireActor(auth);
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const eventKey = String(body?.event_key || '').trim();
  const predictedCaptain = String(body?.predicted_captain || '').trim().toLowerCase();
  const predictedPick = String(body?.predicted_pick || '').trim().toLowerCase();
  const pickRound = Number(body?.pick_round);
  if (!eventKey || !/^frc\d+$/.test(predictedCaptain) || !/^frc\d+$/.test(predictedPick) || !Number.isInteger(pickRound) || pickRound < 1) {
    return json({ error: 'event_key, team-key captain/pick, and a positive pick_round are required' }, { status: 400 });
  }
  try {
    await assertScopedEvent(eventKey);
    const { data, error } = await auth.from('pm_alliance_draft_picks').insert({
      user_id: actor.id,
      event_key: eventKey,
      predicted_captain: predictedCaptain,
      predicted_pick: predictedPick,
      pick_round: pickRound
    }).select('id,user_id,event_key,predicted_captain,predicted_pick,pick_round,placed_at,resolved_at,correct').single();
    if (error) throw error;
    return json(data);
  } catch (error) {
    return json({ error: error.message || 'Unable to submit alliance prediction' }, { status: 500 });
  }
}
