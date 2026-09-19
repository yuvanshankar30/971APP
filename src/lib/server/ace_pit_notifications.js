import { env } from '$env/dynamic/private';
import { getSlackClient, getSupabase } from '$lib/server/971bot.js';
import { recordSlackActivity } from '$lib/server/slack_activity.js';

export const ACE_PIT_CHANNEL_NAME = '2026-chezy-ace-strat-pit';

function cleanSlackText(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  // Scout-entered text must not be able to create an accidental workspace-
  // wide mention. The channel alert itself is the notification mechanism.
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

export function acePitProblemMessage(problem, scoutName = null) {
  const urgent = problem?.severity === 'urgent';
  const team = cleanSlackText(problem?.team_key, 'unknown').replace(/^frc/i, '');
  const summary = cleanSlackText(problem?.summary, 'Mechanical issue flagged after match');
  const detail = cleanSlackText(problem?.detail);
  const reporter = cleanSlackText(scoutName, 'Match Scout');
  const lines = [
    `${urgent ? ':rotating_light:' : ':warning:'} *${urgent ? 'URGENT ' : ''}ACE / Pit issue*`,
    `*Team:* ${team}`,
    `*Match:* ${displayMatch(problem?.match_key)}`,
    `*Competition:* ${cleanSlackText(problem?.event_key, 'Unknown event')}`,
    `*Issue:* ${summary}`
  ];
  if (detail) lines.push(`*Details:* ${detail}`);
  lines.push(`*Reported by:* ${reporter}`);
  return lines.join('\n');
}

export async function sendAcePitProblem(problem, scoutName = null, dependencies = {}) {
  if (!problem?.id) return { ok: false, reason: 'missing-problem-id' };
  const client = dependencies.client || getSlackClient();
  const supa = dependencies.supa || getSupabase();
  const configuredChannel = cleanSlackText(dependencies.channel || env.ACE_PIT_SLACK_CHANNEL_ID);
  const channel = problem.slack_channel || configuredChannel || ACE_PIT_CHANNEL_NAME;
  const text = acePitProblemMessage(problem, scoutName);

  const response = problem.slack_channel && problem.slack_ts
    ? await client.chat.update({ channel: problem.slack_channel, ts: problem.slack_ts, text })
    : await client.chat.postMessage({ channel, text });

  if (!response?.ok) return { ok: false, reason: response?.error || 'slack-rejected-message' };

  const deliveredChannel = response.channel || channel;
  const deliveredTs = response.ts || problem.slack_ts || null;
  await recordSlackActivity(supa, {
    text,
    channel: deliveredChannel,
    ts: deliveredTs,
    recipient: `#${ACE_PIT_CHANNEL_NAME}`,
    category: 'ACE pit issue'
  });
  return { ok: true, channel: deliveredChannel, ts: deliveredTs };
}

export async function notifyAcePitProblem(problem, scoutName = null) {
  try {
    return await sendAcePitProblem(problem, scoutName);
  } catch (error) {
    console.error('Failed to notify ACE pit Slack channel', error?.data?.error || error?.message || error);
    return { ok: false, reason: error?.data?.error || error?.message || 'slack-error' };
  }
}
