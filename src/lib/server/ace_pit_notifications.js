import { getSlackClient, getSupabase } from '$lib/server/971bot.js';

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

export async function sendAcePitProblem(problem) {
  if (!problem?.id) return { ok: false, reason: 'missing-problem-id' };
  // ACE explicitly disabled automated pit notifications. Keep this guard in
  // application code in addition to the database privilege revocation so a
  // future schema grant cannot silently reactivate channel traffic.
  return { ok: false, reason: 'ace-pit-notifications-disabled' };
}

export async function notifyAcePitProblem(problem, scoutName = null) {
  try {
    return await sendAcePitProblem(problem, scoutName);
  } catch (error) {
    console.error('Failed to notify ACE pit Slack channel', error?.data?.error || error?.message || error);
    return { ok: false, reason: error?.data?.error || error?.message || 'slack-error' };
  }
}
