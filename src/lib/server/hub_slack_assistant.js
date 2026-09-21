import { env } from '$env/dynamic/private';
import { getSlackClient, getSupabase } from '$lib/server/971bot.js';

export const HUB_RECENT_CHANGES = [
  'Drive Team now shows every completed 971 match with Win/Loss/Tie and the final score.',
  'Match Scouting sends mechanical, disabled, and dead-robot ACE handoffs only to #2026-ace-pit-bot.',
  'Completed scouting assignments stay visible, display Done, and match historical labels such as Qual 1 or Quals 1.',
  'Scouting Admin exports submitted match-scouting results as CSV without including assignment rows.',
  'Home shows the current or upcoming TBA match and Match Scouting supports competition selection.'
];

export const HUB_FEATURE_CATALOG = `
Spartans Hub is the internal web workspace for FRC teams 971 and 9584.
Major areas include Manufacturing and AutoCAM, CAD/build tracking, Purchasing,
Planner/tasks, Competition scouting, Strategy, Drive Team, Vision Scouting,
Pit Scouting, Match Scouting, robot ratings, predictions, and administration.
Useful routes include /matchscout for recording match observations,
/scouting-admin for assignments and match-result exports, /pitscout for pit
scouting, /driveteam for completed 971 match results, /predictions for the
prediction market, /manufacture for manufacturing requests, and /autocam for
CAM automation.
Match Scouting lets a scout choose the competition, match, robot, alliance,
starting position, and preload; record autonomous movement, cycles, point band,
fuel source, collisions, and a drawn or saved autonomous path; record teleop
roles, fuel/scoring observations, intake source, intake speed, jams, defense,
driving, accuracy, and speed; mark a robot active, stopped, dead, disabled,
mechanically broken, beached, or carded; record climb results and post-match
notes; file the required ACE/Pit handoff for mechanical, disabled, or dead
robots; and reopen a scout's own reports for corrections.
Scouting Admin manages match, note, quick, pit, and pre-scout assignments and
exports submitted match-scouting results as CSV. My Scout shows each scout's
open assignments and submitted report history. Pit Scouting records robot
capabilities, mechanisms, autonomous options, climb options, technical details,
photos, and likely failure points. Strategy combines the match schedule,
scouting summaries, pit issues, rankings, and team comparisons. Drive Team
shows the 971 match schedule and completed results. Vision Scouting is a
review-only evidence workflow until an authorized reviewer explicitly releases
results. Manufacturing covers requests, routing, turning, printing, laser work,
post-processing, files, and AutoCAM/Fusion job status. Purchasing tracks orders,
budgets, approvals, receiving, and delivery status. Planner tracks tasks,
dependencies, schedules, ownership, and Slack reminders.
The bot is read-only. It must never claim that an action was performed, change
data, reveal credentials, or invent status that is absent from supplied data.
`.trim();

function safeSlackText(value) {
  return String(value || '')
    .trim()
    .replace(/<!?(channel|everyone|here)>/gi, '@$1')
    .replace(/@(channel|everyone|here)\b/gi, '@$1 (mention suppressed)')
    .slice(0, 3500);
}

export function stripAppMention(text) {
  return String(text || '').replace(/<@[A-Z0-9]+>/gi, '').trim();
}

export function isHubStatusRequest(question) {
  return /^\/?(?:hub\s+)?status\b/i.test(String(question || '').trim());
}

export function teamNumberFromQuestion(question) {
  return String(question || '').match(/\b(?:team|frc)\s*#?\s*(\d{1,5})\b/i)?.[1] || null;
}

export function isTeamReportStatusRequest(question) {
  return Boolean(
    teamNumberFromQuestion(question)
    && /\b(report|scout|assignment)s?\b/i.test(String(question || ''))
    && /\b(all|complete|completed|done|finish|finished|missing|remaining|status)\b/i.test(String(question || ''))
  );
}

export async function fetchHubStatusSnapshot(supa = getSupabase()) {
  const settings = await supa.from('scouting_settings').select('event_key, updated_at').eq('id', 1).maybeSingle();
  const eventKey = String(settings.data?.event_key || '').trim() || null;
  let openAceQuery = supa.from('pit_problem_reports').select('id', { count: 'exact', head: true }).eq('resolved', false);
  let openAssignmentsQuery = supa.from('scout_match_assignments').select('id', { count: 'exact', head: true }).is('completed_at', null);
  let reportsQuery = supa.from('match_scout_entries').select('id', { count: 'exact', head: true });
  if (eventKey) {
    openAceQuery = openAceQuery.eq('event_key', eventKey);
    openAssignmentsQuery = openAssignmentsQuery.like('match_key', `${eventKey}_%`);
    reportsQuery = reportsQuery.eq('event_key', eventKey);
  }
  const [openAce, openAssignments, reports] = await Promise.all([openAceQuery, openAssignmentsQuery, reportsQuery]);
  const databaseOk = !settings.error && !openAce.error && !openAssignments.error && !reports.error;
  return {
    databaseOk,
    eventKey,
    openAceIssues: openAce.error ? null : (openAce.count ?? 0),
    openScoutingAssignments: openAssignments.error ? null : (openAssignments.count ?? 0),
    matchReportCount: reports.error ? null : (reports.count ?? 0),
    checkedAt: new Date().toISOString()
  };
}

export function formatHubStatus(snapshot) {
  const value = (number) => Number.isFinite(number) ? String(number) : 'unavailable';
  return [
    `*Spartans Hub status:* ${snapshot?.databaseOk ? 'Operational :white_check_mark:' : 'Degraded :warning:'}`,
    `*Database:* ${snapshot?.databaseOk ? 'reachable' : 'one or more status checks failed'}`,
    `*Active scouting event:* ${snapshot?.eventKey || 'not configured'}`,
    `*Open scouting assignments:* ${value(snapshot?.openScoutingAssignments)}`,
    `*Open ACE / Pit issues:* ${value(snapshot?.openAceIssues)}`,
    `*Stored match reports:* ${value(snapshot?.matchReportCount)}`,
    '',
    '*Most recent changes:*',
    ...HUB_RECENT_CHANGES.map((change) => `• ${change}`)
  ].join('\n');
}

export async function fetchTeamReportSnapshot(supa, teamNumber, eventKey) {
  const teamKeys = [`frc${teamNumber}`, String(teamNumber)];
  let assignmentsQuery = supa
    .from('scout_match_assignments')
    .select('id,match_key,scouting_type,completed_at')
    .in('team_key', teamKeys);
  let reportsQuery = supa
    .from('match_scout_entries')
    .select('id,match_key,created_at')
    .in('team_key', teamKeys);
  let pitQuery = supa
    .from('pit_scout_entries')
    .select('id,updated_at')
    .in('team_key', teamKeys);
  if (eventKey) {
    assignmentsQuery = assignmentsQuery.like('match_key', `${eventKey}_%`);
    reportsQuery = reportsQuery.eq('event_key', eventKey);
    pitQuery = pitQuery.eq('event_key', eventKey);
  }
  const [assignments, reports, pit] = await Promise.all([assignmentsQuery, reportsQuery, pitQuery]);
  const rows = assignments.error ? [] : assignments.data || [];
  const byType = {};
  for (const row of rows) {
    const type = String(row.scouting_type || 'unknown');
    if (!byType[type]) byType[type] = { total: 0, completed: 0, remainingMatches: [] };
    byType[type].total += 1;
    if (row.completed_at) byType[type].completed += 1;
    else byType[type].remainingMatches.push(row.match_key);
  }
  const completedAssignments = rows.filter((row) => row.completed_at).length;
  const reportRows = reports.error ? [] : reports.data || [];
  return {
    databaseOk: !assignments.error && !reports.error && !pit.error,
    eventKey,
    teamNumber: String(teamNumber),
    totalAssignments: rows.length,
    completedAssignments,
    remainingAssignments: rows.length - completedAssignments,
    allAssignedReportsComplete: rows.length > 0 && completedAssignments === rows.length,
    byType,
    submittedMatchReports: reportRows.length,
    submittedMatchCount: new Set(reportRows.map((row) => row.match_key).filter(Boolean)).size,
    pitReportPresent: pit.error ? null : (pit.data || []).length > 0
  };
}

export function formatTeamReportStatus(snapshot) {
  const lines = [`*Team ${snapshot.teamNumber} scouting status${snapshot.eventKey ? ` — ${snapshot.eventKey}` : ''}:*`];
  if (!snapshot.databaseOk) lines.push(':warning: One or more scouting tables could not be checked.');
  if (!snapshot.totalAssignments) {
    lines.push('*Assigned reports:* none found, so I cannot claim that every expected report is finished.');
  } else {
    lines.push(`*Assigned reports:* ${snapshot.completedAssignments}/${snapshot.totalAssignments} complete${snapshot.allAssignedReportsComplete ? ' :white_check_mark:' : ` — ${snapshot.remainingAssignments} remaining`}`);
    for (const [type, status] of Object.entries(snapshot.byType).sort()) {
      lines.push(`• ${type}: ${status.completed}/${status.total} complete`);
    }
    const remainingMatches = [...new Set(Object.values(snapshot.byType).flatMap((status) => status.remainingMatches))];
    if (remainingMatches.length) lines.push(`*Still open:* ${remainingMatches.slice(0, 12).join(', ')}${remainingMatches.length > 12 ? ` and ${remainingMatches.length - 12} more` : ''}`);
  }
  lines.push(`*Submitted match-scout entries:* ${snapshot.submittedMatchReports} across ${snapshot.submittedMatchCount} match${snapshot.submittedMatchCount === 1 ? '' : 'es'}`);
  lines.push(`*Pit scouting:* ${snapshot.pitReportPresent === null ? 'unavailable' : snapshot.pitReportPresent ? 'report present' : 'no report found'}`);
  return lines.join('\n');
}

export async function askGroqAboutHub(question, snapshot, options = {}) {
  const apiKey = options.apiKey || env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured');
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  // Slack expects Events API requests to be acknowledged in roughly three
  // seconds. Leave time for the status snapshot and chat.postMessage call.
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 1500);
  try {
    const response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || env.GROQ_MODEL || 'openai/gpt-oss-20b',
        temperature: 0.2,
        max_completion_tokens: 450,
        messages: [
          {
            role: 'system',
            content: `You are 971hub, the concise Slack assistant for Spartans Hub. Answer any question about Hub features, routes, and the supplied live status, but only from the evidence below. If the answer is not present, say you do not know and direct the user to the relevant Hub page or an administrator. Never imply that a report or assignment is complete unless the live data explicitly proves it. Use Slack markdown, no tables, and never generate @channel, @here, or @everyone mentions.\n\nHUB FEATURE CATALOG:\n${HUB_FEATURE_CATALOG}\n\nRECENT CHANGES:\n${HUB_RECENT_CHANGES.join('\n')}\n\nLIVE SNAPSHOT:\n${JSON.stringify(snapshot)}`
          },
          { role: 'user', content: safeSlackText(question).slice(0, 1200) }
        ]
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Groq request failed (${response.status})`);
    const answer = safeSlackText(payload?.choices?.[0]?.message?.content);
    if (!answer) throw new Error('Groq returned an empty answer');
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleHubAppMention(event, dependencies = {}) {
  if (!event?.channel || !event?.ts || event?.bot_id || event?.subtype === 'bot_message') {
    return { ok: false, reason: 'ignored-event' };
  }
  const question = stripAppMention(event.text);
  const supa = dependencies.supa || getSupabase();
  const slack = dependencies.slack || getSlackClient();
  const snapshot = await fetchHubStatusSnapshot(supa);
  let text;
  if (!question) {
    text = 'Ask me about Spartans Hub, or use `@971hub /status` for live status and recent changes.';
  } else if (isHubStatusRequest(question)) {
    text = formatHubStatus(snapshot);
  } else if (isTeamReportStatusRequest(question)) {
    const teamSnapshot = await fetchTeamReportSnapshot(supa, teamNumberFromQuestion(question), snapshot.eventKey);
    text = formatTeamReportStatus(teamSnapshot);
  } else {
    try {
      text = await askGroqAboutHub(question, snapshot, dependencies);
    } catch (error) {
      console.error('Groq Hub assistant failed', error?.message || error);
      text = 'I could not reach the Hub question-answering service. Try `@971hub /status`, or ask again shortly.';
    }
  }
  const response = await slack.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text
  });
  return { ok: !!response?.ok, channel: response?.channel || event.channel, ts: response?.ts || null };
}
