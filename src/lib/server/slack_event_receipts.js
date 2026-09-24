const DUPLICATE_KEY_CODE = '23505';
const CONTEXT_PREFIX = 'assistant_context_v1:';

function conversationContext({ ts, threadTs = ts, question, answer = null }) {
  return `${CONTEXT_PREFIX}${JSON.stringify({
    ts: String(ts || ''),
    threadTs: String(threadTs || ts || ''),
    question: String(question || '').slice(0, 1200),
    answer: answer === null ? null : String(answer).slice(0, 1500)
  })}`;
}

function parseConversationContext(value) {
  if (typeof value !== 'string' || !value.startsWith(CONTEXT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(value.slice(CONTEXT_PREFIX.length));
    return parsed?.ts && typeof parsed.question === 'string' ? parsed : null;
  } catch { return null; }
}

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

// The service-role-only receipt already exists in production. Its last_error
// text holds context while processing/completed and an error when failed.
export async function recordSlackAssistantQuestion(supa, eventId, { ts, threadTs = ts, question }) {
  const result = await supa.from('slack_event_receipts')
    .update({ last_error: conversationContext({ ts, threadTs, question }), updated_at: new Date().toISOString() })
    .eq('event_id', eventId);
  if (result.error) throw new Error(`Could not remember Slack question: ${cleanError(result.error)}`);
}

export async function completeSlackEvent(supa, eventId, context = null) {
  const completedAt = new Date().toISOString();
  const result = await supa
    .from('slack_event_receipts')
    .update({ status: 'completed', completed_at: completedAt, updated_at: completedAt,
      last_error: context ? conversationContext(context) : null })
    .eq('event_id', eventId);
  if (result.error) throw new Error(`Could not complete Slack event: ${cleanError(result.error)}`);
}

export async function readSlackAssistantThread(supa, { channel, threadTs, beforeTs }) {
  if (!channel || !threadTs || !beforeTs) return [];
  // event_ts identifies each message for the unique receipt constraint.
  // Context stores the shared parent separately, so follow-ups cannot collide.
  const recent = await supa.from('slack_event_receipts')
    .select('last_error,received_at')
    .eq('channel_id', channel)
    .in('status', ['processing', 'completed'])
    .in('event_type', ['app_mention', 'message.thread_reply'])
    .like('last_error', `${CONTEXT_PREFIX}%"threadTs":"${threadTs}"%`)
    .order('received_at', { ascending: false })
    .limit(40);
  if (recent.error) throw new Error(`Could not read Slack thread memory: ${cleanError(recent.error)}`);
  // Older root receipts predate threadTs in their context, but event_ts was
  // already the root message's own timestamp, so they remain readable.
  const root = await supa.from('slack_event_receipts')
    .select('last_error')
    .eq('channel_id', channel)
    .eq('event_ts', threadTs)
    .eq('event_type', 'app_mention')
    .in('status', ['processing', 'completed'])
    .limit(1)
    .maybeSingle();
  if (root.error) throw new Error(`Could not read Slack thread root: ${cleanError(root.error)}`);
  const rootContext = parseConversationContext(root.data?.last_error);
  const contexts = [rootContext, ...(recent.data || [])
    .map((row) => parseConversationContext(row?.last_error))
    .filter((context) => context?.threadTs === threadTs)]
    .filter((context) => context && Number(context.ts) < Number(beforeTs));
  const unique = [...new Map(contexts.map((context) => [context.ts, context])).values()]
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  return unique.flatMap(({ question, answer }) => [
    ...(question ? [{ role: 'user', text: question }] : []),
    ...(answer ? [{ role: 'assistant', text: answer }] : [])
  ]);
}

export async function failSlackEvent(supa, eventId, error) {
  const result = await supa
    .from('slack_event_receipts')
    .update({ status: 'failed', last_error: cleanError(error), updated_at: new Date().toISOString() })
    .eq('event_id', eventId);
  if (result.error) throw new Error(`Could not fail Slack event: ${cleanError(result.error)}`);
}
