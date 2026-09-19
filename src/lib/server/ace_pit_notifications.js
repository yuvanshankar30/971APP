import { env } from '$env/dynamic/private';
import { getSlackClient, getSupabase } from '$lib/server/971bot.js';
import { recordSlackActivity } from '$lib/server/slack_activity.js';

export const ACE_PIT_CHANNEL_NAME = '2026-chezy-ace-strat-pit';

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

export function acePitTeamThreadMessage(eventKey, teamKey, problems = []) {
  const openProblems = problems.filter((problem) => !problem.resolved);
  const team = cleanSlackText(teamKey, 'unknown').replace(/^frc/i, '');
  const lines = [
    `:toolbox: *ACE / Pit thread — Team ${team} · ${cleanSlackText(eventKey, 'Unknown event')}*`,
    'New scout reports, edits, and resolutions for this team stay in this thread.'
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
    lines.push(`• ${problem.severity === 'urgent' ? ':rotating_light:' : ':warning:'} *${displayMatch(problem.match_key)}* — ${cleanSlackText(problem.summary, 'Mechanical issue flagged')} (${count} scout${count === 1 ? '' : 's'})`);
  }
  return lines.join('\n');
}

async function openProblemsForTeam(supa, eventKey, teamKey) {
  const { data, error } = await supa
    .from('pit_problem_reports')
    .select('*')
    .eq('event_key', eventKey)
    .eq('team_key', teamKey)
    .eq('resolved', false)
    .order('match_key');
  if (error) throw new Error(`Could not load ACE team thread: ${error.message}`);
  return data || [];
}

async function removeLegacyTeamMessages(client, supa, eventKey, teamKey) {
  const { data: queued, error: queueError } = await supa
    .from('ace_pit_slack_legacy_messages')
    .select('channel, message_ts')
    .eq('event_key', eventKey)
    .eq('team_key', teamKey);
  if (queueError) throw new Error(`Could not load legacy ACE cleanup queue: ${queueError.message}`);

  const { data: tracked, error } = await supa
    .from('pit_problem_reports')
    .select('slack_channel, slack_ts')
    .eq('event_key', eventKey)
    .eq('team_key', teamKey)
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
  for (const { channel, ts } of messages.values()) {
    try {
      const response = await client.chat.delete({ channel, ts });
      if (response && response.ok === false && response.error !== 'message_not_found') {
        console.error('Failed to retire legacy ACE Slack message', response.error);
      }
    } catch (error) {
      if (error?.data?.error !== 'message_not_found') {
        console.error('Failed to retire legacy ACE Slack message', error?.data?.error || error?.message || error);
      }
    }
  }
  const { error: clearError } = await supa
    .from('ace_pit_slack_legacy_messages')
    .delete()
    .eq('event_key', eventKey)
    .eq('team_key', teamKey);
  if (clearError) throw new Error(`Could not clear legacy ACE cleanup queue: ${clearError.message}`);
}

async function ensureAceTeamThread(client, supa, eventKey, teamKey, channel) {
  const { data: existing, error: lookupError } = await supa
    .from('ace_pit_slack_threads')
    .select('event_key, team_key, channel, root_ts')
    .eq('event_key', eventKey)
    .eq('team_key', teamKey)
    .maybeSingle();
  if (lookupError) throw new Error(`Could not load ACE Slack thread: ${lookupError.message}`);

  const problems = await openProblemsForTeam(supa, eventKey, teamKey);
  const text = acePitTeamThreadMessage(eventKey, teamKey, problems);
  if (existing?.root_ts) {
    const response = await client.chat.update({ channel: existing.channel, ts: existing.root_ts, text });
    if (!response?.ok) throw new Error(response?.error || 'slack-rejected-thread-update');
    return { channel: response.channel || existing.channel, rootTs: response.ts || existing.root_ts };
  }

  // The previous implementation made one top-level message per report. On
  // first use, retire only this team's tracked bot messages and replace them
  // with one durable team thread.
  await removeLegacyTeamMessages(client, supa, eventKey, teamKey);
  const response = await client.chat.postMessage({ channel, text });
  if (!response?.ok) throw new Error(response?.error || 'slack-rejected-team-thread');
  const deliveredChannel = response.channel || channel;
  const rootTs = response.ts;
  const { error: saveError } = await supa.from('ace_pit_slack_threads').upsert({
    event_key: eventKey,
    team_key: teamKey,
    channel: deliveredChannel,
    root_ts: rootTs,
    updated_at: new Date().toISOString()
  }, { onConflict: 'event_key,team_key' });
  if (saveError) throw new Error(`Could not save ACE Slack thread: ${saveError.message}`);
  return { channel: deliveredChannel, rootTs };
}

export async function sendAcePitProblem(problem, scoutName = null, dependencies = {}) {
  if (!problem?.id) return { ok: false, reason: 'missing-problem-id' };
  const client = dependencies.client || getSlackClient();
  const supa = dependencies.supa || getSupabase();
  const configuredChannel = cleanSlackText(dependencies.channel || env.ACE_PIT_SLACK_CHANNEL_ID);
  const channel = configuredChannel || ACE_PIT_CHANNEL_NAME;
  const text = acePitProblemMessage(problem, scoutName);
  const thread = dependencies.ensureThread
    ? await dependencies.ensureThread(client, supa, problem.event_key, problem.team_key, channel)
    : await ensureAceTeamThread(client, supa, problem.event_key, problem.team_key, channel);

  if (problem.slack_last_payload === text) {
    return { ok: true, channel: thread.channel, ts: thread.rootTs, payload: text, duplicate: true };
  }

  const response = await client.chat.postMessage({ channel: thread.channel, thread_ts: thread.rootTs, text });
  if (!response?.ok) return { ok: false, reason: response?.error || 'slack-rejected-message' };
  await recordSlackActivity(supa, {
    text,
    channel: response.channel || thread.channel,
    ts: response.ts || null,
    recipient: `#${ACE_PIT_CHANNEL_NAME}`,
    category: 'ACE pit issue update'
  });
  return {
    ok: true,
    channel: response.channel || thread.channel,
    ts: thread.rootTs,
    replyTs: response.ts || null,
    payload: text,
    duplicate: false
  };
}

export async function notifyAcePitProblem(problem, scoutName = null) {
  try {
    return await sendAcePitProblem(problem, scoutName);
  } catch (error) {
    console.error('Failed to notify ACE pit Slack channel', error?.data?.error || error?.message || error);
    return { ok: false, reason: error?.data?.error || error?.message || 'slack-error' };
  }
}
