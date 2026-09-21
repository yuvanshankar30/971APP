const DUPLICATE_KEY_CODE = '23505';

function cleanError(error) {
  return String(error?.message || error || 'unknown error').slice(0, 500);
}

export async function claimSlackEvent(supa, { eventId, eventType, channelId = null, eventTs = null }) {
  const receipt = {
    event_id: eventId,
    event_type: eventType,
    channel_id: channelId,
    event_ts: eventTs,
    status: 'processing',
    last_error: null,
    updated_at: new Date().toISOString()
  };
  const inserted = await supa.from('slack_event_receipts').insert(receipt);
  if (!inserted.error) return { claimed: true, retried: false };
  if (inserted.error.code !== DUPLICATE_KEY_CODE) {
    throw new Error(`Could not record Slack event: ${cleanError(inserted.error)}`);
  }

  const retried = await supa
    .from('slack_event_receipts')
    .update({ status: 'processing', last_error: null, updated_at: new Date().toISOString() })
    .eq('event_id', eventId)
    .eq('status', 'failed')
    .select('event_id')
    .maybeSingle();
  if (retried.error) throw new Error(`Could not reclaim Slack event: ${cleanError(retried.error)}`);
  return { claimed: Boolean(retried.data?.event_id), retried: Boolean(retried.data?.event_id) };
}

export async function completeSlackEvent(supa, eventId) {
  const completedAt = new Date().toISOString();
  const result = await supa
    .from('slack_event_receipts')
    .update({ status: 'completed', completed_at: completedAt, updated_at: completedAt, last_error: null })
    .eq('event_id', eventId);
  if (result.error) throw new Error(`Could not complete Slack event: ${cleanError(result.error)}`);
}

export async function failSlackEvent(supa, eventId, error) {
  const result = await supa
    .from('slack_event_receipts')
    .update({ status: 'failed', last_error: cleanError(error), updated_at: new Date().toISOString() })
    .eq('event_id', eventId);
  if (result.error) throw new Error(`Could not fail Slack event: ${cleanError(result.error)}`);
}
