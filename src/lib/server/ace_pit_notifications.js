import { getSlackClient, getSupabase } from '$lib/server/971bot.js';

// ACE asked (2026-09-19) for automated pit notifications back, now aimed at
// a new channel and a simpler shape than the old one: ONE thread per
// competition (not per team - Slack only threads whole messages, and one
// thread per team got noisy fast), with every report/edit/resolution posted
// as its own reply in that thread rather than crammed into one message.
export const ACE_PIT_CHANNEL_NAME = '2026-ace-pit-bot';

// Channel IDs aren't derivable from a name, and hardcoding one that was
// never actually looked up in this workspace would risk silently posting
// nowhere (or somewhere wrong) - resolved by name against the real
// workspace instead, once, then cached for the life of the process.
let cachedChannelId = null;

async function resolveAcePitChannelId(client) {
  if (cachedChannelId) return cachedChannelId;
  let cursor;
  do {
    const response = await client.conversations.list({ types: 'public_channel,private_channel', limit: 200, cursor });
    if (!response?.ok) throw new Error(response?.error || 'slack-rejected-channel-list');
    const match = (response.channels || []).find((channel) => channel.name === ACE_PIT_CHANNEL_NAME);
    if (match) {
      cachedChannelId = match.id;
      return cachedChannelId;
    }
    cursor = response.response_metadata?.next_cursor || null;
  } while (cursor);
  throw new Error(`Could not find a Slack channel named #${ACE_PIT_CHANNEL_NAME} - is the bot a member of it?`);
}

function cleanSlackText(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replace(/<!?(channel|everyone|here)>/gi, '@$1');
}

function displayMatch(matchKey) {
  const key = cleanSlackText(matchKey, 'Unknown match');
  const shortKey = key.split('_').pop() || key;
  const qualification = shortKey.match(/^qm(\d+)$/i);
  if (qualification) return `Qualification ${qualification[1]}`;
  const playoff = shortKey.match(/^(ef|qf|sf|f)(\d+)m(\d+)$/i);
  if (playoff) {
    const level = { ef: 'Octofinal', qf: 'Quarterfinal', sf: 'Semifinal', f: 'Final' }[playoff[1].toLowerCase()];
    return `${level} ${playoff[2]} Match ${playoff[3]}`;
  }
  return key;
}

function teamNumber(problem) {
  return cleanSlackText(problem?.team_key, 'unknown').replace(/^frc/i, '');
}

export function acePitProblemMessage(problem, scoutName = null) {
  const resolved = problem?.resolved === true;
  const urgent = problem?.severity === 'urgent';
  const observations = Array.isArray(problem?.scout_observations) ? problem.scout_observations : [];
  const summary = cleanSlackText(problem?.summary, 'Mechanical issue flagged after match');
  const detail = cleanSlackText(problem?.detail);
  const reporter = cleanSlackText(scoutName, 'Match Scout');
  const lines = [
    `${resolved ? ':white_check_mark:' : urgent ? ':rotating_light:' : ':warning:'} *Team ${teamNumber(problem)} — ${resolved ? 'issue resolved' : urgent ? 'URGENT pit update' : 'pit update'}*`,
    `*Match:* ${displayMatch(problem?.match_key)}`,
    `*Competition:* ${cleanSlackText(problem?.event_key, 'Unknown event')}`
  ];
  if (observations.length) {
    lines.push(`*Scout reports (${observations.length}):*`);
    for (const observation of observations) {
      const name = cleanSlackText(observation?.scout_name, 'Match Scout');
      const observationSummary = cleanSlackText(observation?.summary, 'Mechanical issue flagged after match');
      const observationDetail = cleanSlackText(observation?.detail);
      lines.push(`• *${name}:* ${observationSummary}${observationDetail ? ` — ${observationDetail}` : ''}`);
    }
  } else {
    lines.push(`*Issue:* ${summary}`);
    if (detail) lines.push(`*Details:* ${detail}`);
    lines.push(`*Reported by:* ${reporter}`);
  }
  return lines.join('\n');
}

export function acePitCompetitionThreadMessage(eventKey, problems = []) {
  const openProblems = problems.filter((problem) => !problem.resolved);
  const lines = [
    `:toolbox: *ACE / Pit issues — ${cleanSlackText(eventKey, 'Unknown event')}*`,
    'All affected teams are listed here. New scout reports, edits, and resolutions stay in this thread.'
  ];
  if (!openProblems.length) {
    lines.push('', ':white_check_mark: *No open pit issues.*');
    return lines.join('\n');
  }
  lines.push('', '*Open issues:*');
  for (const problem of openProblems) {
    const count = Array.isArray(problem.scout_observations) && problem.scout_observations.length
      ? problem.scout_observations.length
      : 1;
    lines.push(`• ${problem.severity === 'urgent' ? ':rotating_light:' : ':warning:'} *Team ${teamNumber(problem)} · ${displayMatch(problem.match_key)}* — ${cleanSlackText(problem.summary, 'Mechanical issue flagged')} (${count} scout${count === 1 ? '' : 's'})`);
  }
  return lines.join('\n');
}

// The thread's root message: a fixed title only (not a live-updated open-
// issues summary - acePitCompetitionThreadMessage above still exists for
// that if it's ever wanted, but every individual report already gets its
// own reply, so the root's only job is to name the thread). Dated rather
// than keyed by event_key so it reads naturally in Slack; still one thread
// per (event_key, day) underneath (see ensureAcePitCompetitionThread) - a
// multi-day competition gets a fresh thread each day rather than one thread
// spanning the whole event, so the title's date always actually matches
// the thread it names.
export function acePitThreadTitle(date = new Date()) {
  const formatted = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
  return [
    `:toolbox: *${formatted} Ace Issues*`,
    'Every pit issue reported at this competition today lands here as its own reply in this thread.'
  ].join('\n');
}

// The date this thread belongs to, in the same Pacific calendar day
// acePitThreadTitle's date reads by - en-CA gives an ISO-shaped YYYY-MM-DD
// string directly, which is exactly what the `date` column expects.
function pacificDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// One durable root message per (competition, day) - public.ace_pit_slack_
// threads, PK (event_key, thread_date). Every NEW report replies into it
// via sendAcePitProblem below; an edit or resolution of an already-posted
// report updates that report's own existing reply directly and never calls
// this, so it can't be moved into a later day's thread out from under it.
export async function ensureAcePitCompetitionThread(client, supa, eventKey, now = new Date()) {
  const threadDate = pacificDateKey(now);
  const { data: existing, error } = await supa
    .from('ace_pit_slack_threads')
    .select('channel, root_ts')
    .eq('event_key', eventKey)
    .eq('thread_date', threadDate)
    .maybeSingle();
  if (error) throw new Error(`Could not load the ACE Slack thread: ${error.message}`);
  if (existing?.channel && existing?.root_ts) return existing;

  const channel = await resolveAcePitChannelId(client);
  const posted = await client.chat.postMessage({ channel, text: acePitThreadTitle(now) });
  if (!posted?.ok) throw new Error(posted?.error || 'slack-rejected-root-post');

  const { data: inserted, error: insertError } = await supa
    .from('ace_pit_slack_threads')
    .insert({ event_key: eventKey, thread_date: threadDate, channel: posted.channel || channel, root_ts: posted.ts })
    .select('channel, root_ts')
    .single();
  if (!insertError) return inserted;
  if (insertError.code !== '23505') throw new Error(`Could not save the ACE Slack thread: ${insertError.message}`);

  // Another concurrent report raced this one and already created today's
  // real thread - keep theirs (so every issue lands in the same place) and
  // quietly remove the extra root message this call just posted.
  const { data: winner, error: refetchError } = await supa
    .from('ace_pit_slack_threads')
    .select('channel, root_ts')
    .eq('event_key', eventKey)
    .eq('thread_date', threadDate)
    .single();
  if (refetchError) throw new Error(`Could not load the ACE Slack thread after a race: ${refetchError.message}`);
  await client.chat.delete({ channel: posted.channel || channel, ts: posted.ts }).catch(() => {});
  return winner;
}

async function removeLegacyCompetitionMessages(client, supa, eventKey) {
  const { data: queued, error: queueError } = await supa
    .from('ace_pit_slack_legacy_messages')
    .select('channel, message_ts')
    .eq('event_key', eventKey);
  if (queueError) throw new Error(`Could not load legacy ACE cleanup queue: ${queueError.message}`);

  const { data: tracked, error } = await supa
    .from('pit_problem_reports')
    .select('slack_channel, slack_ts')
    .eq('event_key', eventKey)
    .not('slack_channel', 'is', null)
    .not('slack_ts', 'is', null);
  if (error) throw new Error(`Could not inventory legacy ACE messages: ${error.message}`);

  const messages = new Map();
  for (const message of queued || []) messages.set(`${message.channel}:${message.message_ts}`, {
    channel: message.channel,
    ts: message.message_ts
  });
  for (const problem of tracked || []) messages.set(`${problem.slack_channel}:${problem.slack_ts}`, {
    channel: problem.slack_channel,
    ts: problem.slack_ts
  });
  const failures = [];
  for (const { channel, ts } of messages.values()) {
    try {
      const response = await client.chat.delete({ channel, ts });
      if (response && response.ok === false && response.error !== 'message_not_found') {
        failures.push(response.error || 'slack-rejected-delete');
      }
    } catch (error) {
      if (error?.data?.error !== 'message_not_found') {
        failures.push(error?.data?.error || error?.message || String(error));
      }
    }
  }
  if (failures.length) throw new Error(`Could not delete ${failures.length} ACE Slack message(s): ${failures.join(', ')}`);
  const { error: clearError } = await supa
    .from('ace_pit_slack_legacy_messages')
    .delete()
    .eq('event_key', eventKey);
  if (clearError) throw new Error(`Could not clear legacy ACE cleanup queue: ${clearError.message}`);
}

export async function deleteQueuedAcePitMessages(dependencies = {}) {
  const client = dependencies.client || getSlackClient();
  const supa = dependencies.supa || getSupabase();
  const { data, error } = await supa.from('ace_pit_slack_legacy_messages').select('event_key');
  if (error) throw new Error(`Could not load ACE cleanup queue: ${error.message}`);
  const eventKeys = [...new Set((data || []).map((row) => row.event_key).filter(Boolean))];
  for (const eventKey of eventKeys) await removeLegacyCompetitionMessages(client, supa, eventKey);
  return { ok: true, deleted_competitions: eventKeys.length };
}

function isAceBotMessage(message, identity) {
  return Boolean(
    (identity.bot_id && message?.bot_id === identity.bot_id)
    || (identity.user_id && message?.user === identity.user_id)
  );
}

async function conversationReplies(client, channel, rootTs) {
  const messages = [];
  let cursor;
  do {
    try {
      const response = await client.conversations.replies({ channel, ts: rootTs, limit: 200, cursor });
      if (!response?.ok) {
        if (response?.error === 'message_not_found') return messages;
        throw new Error(response?.error || 'slack-rejected-replies-list');
      }
      messages.push(...(response.messages || []));
      cursor = response.response_metadata?.next_cursor || null;
    } catch (error) {
      if (error?.data?.error === 'message_not_found') return messages;
      throw error;
    }
  } while (cursor);
  return messages;
}

export async function purgeAcePitSlackMessages(dependencies = {}) {
  const client = dependencies.client || getSlackClient();
  const supa = dependencies.supa || getSupabase();
  const identity = await client.auth.test();
  if (!identity?.ok) throw new Error(identity?.error || 'slack-auth-failed');
  const channelId = await resolveAcePitChannelId(client);

  const { data: queued, error: queueError } = await supa
    .from('ace_pit_slack_legacy_messages')
    .select('channel, message_ts');
  if (queueError) throw new Error(`Could not load ACE cleanup queue: ${queueError.message}`);
  const roots = new Map((queued || []).map((message) => [
    `${message.channel}:${message.message_ts}`,
    { channel: message.channel, ts: message.message_ts }
  ]));

  let cursor;
  do {
    const history = await client.conversations.history({ channel: channelId, limit: 200, cursor });
    if (!history?.ok) throw new Error(history?.error || 'slack-rejected-history-list');
    for (const message of history.messages || []) {
      if (isAceBotMessage(message, identity) && /ACE\s*\/\s*Pit|ACE issues/i.test(String(message.text || ''))) {
        roots.set(`${channelId}:${message.ts}`, { channel: channelId, ts: message.ts });
      }
    }
    cursor = history.response_metadata?.next_cursor || null;
  } while (cursor);

  let deletedReplies = 0;
  let deletedRoots = 0;
  for (const root of roots.values()) {
    const replies = await conversationReplies(client, root.channel, root.ts);
    const botReplies = replies
      .filter((message) => message.ts !== root.ts && isAceBotMessage(message, identity))
      .sort((left, right) => Number(right.ts) - Number(left.ts));
    for (const reply of botReplies) {
      const response = await client.chat.delete({ channel: root.channel, ts: reply.ts });
      if (!response?.ok && response?.error !== 'message_not_found') throw new Error(response?.error || 'slack-rejected-reply-delete');
      if (response?.ok) deletedReplies += 1;
    }
    const response = await client.chat.delete({ channel: root.channel, ts: root.ts });
    if (!response?.ok && response?.error !== 'message_not_found') throw new Error(response?.error || 'slack-rejected-root-delete');
    if (response?.ok) deletedRoots += 1;
  }

  const { error: clearError } = await supa.from('ace_pit_slack_legacy_messages').delete().neq('message_ts', '');
  if (clearError) throw new Error(`Could not clear ACE cleanup queue: ${clearError.message}`);
  return { ok: true, deleted_roots: deletedRoots, deleted_replies: deletedReplies };
}

// Every report, edit (merged scout observation), and resolution calls this.
// An edit/resolution of a problem that already has a Slack message updates
// that SAME reply in place (chat.update) rather than posting a duplicate;
// a brand-new problem gets a fresh reply into that competition's thread.
export async function sendAcePitProblem(problem, scoutName = null, dependencies = {}) {
  if (!problem?.id) return { ok: false, reason: 'missing-problem-id' };
  const client = dependencies.client || getSlackClient();
  const supa = dependencies.supa || getSupabase();
  const ensureThread = dependencies.ensureThread || ensureAcePitCompetitionThread;

  const text = acePitProblemMessage(problem, scoutName);

  if (problem.slack_channel && problem.slack_ts) {
    const updated = await client.chat.update({ channel: problem.slack_channel, ts: problem.slack_ts, text });
    if (!updated?.ok) throw new Error(updated?.error || 'slack-rejected-update');
    return { ok: true, channel: updated.channel || problem.slack_channel, ts: updated.ts || problem.slack_ts, payload: text };
  }

  const thread = await ensureThread(client, supa, problem.event_key);
  const posted = await client.chat.postMessage({ channel: thread.channel, thread_ts: thread.root_ts, text });
  if (!posted?.ok) throw new Error(posted?.error || 'slack-rejected-post');
  return { ok: true, channel: posted.channel, ts: posted.ts, payload: text };
}

export async function notifyAcePitProblem(problem, scoutName = null, dependencies = {}) {
  try {
    return await sendAcePitProblem(problem, scoutName, dependencies);
  } catch (error) {
    console.error('Failed to notify ACE pit Slack channel', error?.data?.error || error?.message || error);
    return { ok: false, reason: error?.data?.error || error?.message || 'slack-error' };
  }
}

// One-time catch-up for reports that predate this feature going back live:
// every pit_problem_reports row still missing slack_notified_at (the same
// condition pit_problem_reports_unsent_slack_idx was built for) gets posted
// now, oldest first, so today's backlog isn't silently missing once
// notifications resume. Each one goes through the normal send/update path -
// a report that already has a Slack message (from before a mid-event
// disable/re-enable) still gets treated as new here only if slack_notified_at
// was never set, so this cannot double-post something already delivered.
export async function backfillUnsentAcePitProblems(dependencies = {}) {
  const supa = dependencies.supa || getSupabase();
  const notify = dependencies.notify || notifyAcePitProblem;

  const { data, error } = await supa
    .from('pit_problem_reports')
    .select('*')
    .is('slack_notified_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Could not load unsent ACE pit reports: ${error.message}`);

  let sent = 0;
  let failed = 0;
  for (const problem of data || []) {
    const latestObservation = Array.isArray(problem.scout_observations) ? problem.scout_observations.at(-1) : null;
    const scoutName = latestObservation?.scout_name || null;
    const result = await notify(problem, scoutName, dependencies);
    if (!result?.ok) {
      failed += 1;
      continue;
    }
    const slackDelivery = {
      slack_channel: result.channel,
      slack_ts: result.ts,
      slack_last_payload: result.payload,
      slack_notified_at: new Date().toISOString()
    };
    const { error: updateError } = await supa.from('pit_problem_reports').update(slackDelivery).eq('id', problem.id);
    if (updateError) {
      failed += 1;
      continue;
    }
    sent += 1;
  }
  return { ok: true, sent, failed, total: (data || []).length };
}
