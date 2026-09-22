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

export function isScoutingAssignmentQuestion(question) {
  const value = String(question || '');
  return /\b(assign(?:ed|ment|ments)?|shift|shifts|task|tasks)\b/i.test(value)
    && /\b(scout|scouts|scouting|match|pit|prescout)\b/i.test(value);
}

export function shouldUseGoogleSearch(question) {
  if (isScoutingAssignmentQuestion(question)) return false;
  if (/\b(spartans\s*hub|971hub|scouting admin|match scouting|pit scouting|planner|manufacturing|autocam|prediction market)\b/i.test(String(question || ''))) {
    return false;
  }
  const possibleArithmetic = String(question || '')
    .trim()
    .replace(/^(?:what\s+is|calculate|compute)\s+/i, '')
    .replace(/\?+$/, '')
    .trim();
  if (/^[\d\s()+\-*/%.^]+$/.test(possibleArithmetic)) return false;
  return /\b(when|where|who|what|which|date|start|schedule|event|competition|regional|district|championship|q2|quarterfinal|latest|today|current|news|price|weather)\b/i
    .test(String(question || ''));
}

export function assignmentEventKey(question, activeEventKey) {
  const value = String(question || '');
  if (/\bchezy(?:\s+champs?)?\b/i.test(value)) {
    const explicitYear = value.match(/\b(20\d{2})\b/)?.[1];
    const activeYear = String(activeEventKey || '').match(/^(20\d{2})/)?.[1];
    return `${explicitYear || activeYear || new Date().getFullYear()}cc`;
  }
  return activeEventKey;
}

function assignmentRow(row, names, kind) {
  if (!row?.assigned_user) return null;
  return {
    scout: names.get(row.assigned_user) || 'Unknown scout',
    kind,
    match: row.match_key || null,
    team: String(row.team_key || '').replace(/^frc/i, '') || null,
    completed: Boolean(row.completed_at)
  };
}

export async function fetchScoutingAssignmentsForSlackUser(supa, slackUserId, eventKey, options = {}) {
  const normalizedSlackId = String(slackUserId || '').trim();
  if (!normalizedSlackId) return { available: false, reason: 'missing-slack-user' };
  if (!eventKey) return { available: false, reason: 'no-active-event' };

  let profileResult = await supa
    .from('user_profiles')
    .select('id, full_name, role, banned')
    .eq('slack_user_id', normalizedSlackId)
    .maybeSingle();
  if (!profileResult.data && options.slack?.users?.info) {
    const slackResult = await options.slack.users.info({ user: normalizedSlackId }).catch(() => null);
    const email = String(slackResult?.user?.profile?.email || '').trim().toLowerCase();
    if (email) {
      profileResult = await supa
        .from('user_profiles')
        .select('id, full_name, role, banned')
        .ilike('email', email)
        .maybeSingle();
    }
  }
  const profile = profileResult.data;
  if (profileResult.error || !profile?.id) return { available: false, reason: 'slack-profile-not-linked' };
  if (profile.banned) return { available: false, reason: 'account-disabled' };

  const rosterResult = await supa
    .from('roster_entries')
    .select('key:key_id(key_name)')
    .eq('user_id', profile.id);
  const rosterKeys = new Set((rosterResult.data || [])
    .map((row) => String(row?.key?.key_name || '').trim().toLowerCase())
    .filter(Boolean));
  // Match the Scouting Admin page's full-roster access boundary exactly.
  const canViewAll = profile.role === 'admin' || rosterKeys.has('scouting admin');

  let matchQuery = supa
    .from('scout_match_assignments')
    .select('scouting_type, match_key, team_key, assigned_user, completed_at')
    .like('match_key', `${eventKey}_%`)
    .limit(2000);
  let pitQuery = supa
    .from('scout_pit_assignments')
    .select('event_key, team_key, assigned_user, completed_at')
    .eq('event_key', eventKey)
    .limit(1000);
  let prescoutQuery = supa
    .from('scout_prescout_assignments')
    .select('event_key, team_key, assigned_user, completed_at')
    .eq('event_key', eventKey)
    .limit(1000);
  if (!canViewAll) {
    matchQuery = matchQuery.eq('assigned_user', profile.id);
    pitQuery = pitQuery.eq('assigned_user', profile.id);
    prescoutQuery = prescoutQuery.eq('assigned_user', profile.id);
  }

  const [matchResult, pitResult, prescoutResult] = await Promise.all([matchQuery, pitQuery, prescoutQuery]);
  if ([matchResult, pitResult, prescoutResult].some((result) => result.error)) {
    return { available: false, reason: 'assignment-query-failed' };
  }

  const matchRows = matchResult.data || [];
  const pitRows = pitResult.data || [];
  const prescoutRows = prescoutResult.data || [];
  const userIds = [...new Set([...matchRows, ...pitRows, ...prescoutRows]
    .map((row) => row.assigned_user)
    .filter(Boolean))];
  const names = new Map([[profile.id, profile.full_name || 'Requesting scout']]);
  if (canViewAll && userIds.length) {
    const usersResult = await supa.from('user_profiles').select('id, full_name').in('id', userIds);
    for (const row of usersResult.data || []) names.set(row.id, row.full_name || 'Unknown scout');
  }

  return {
    available: true,
    eventKey,
    visibility: canViewAll ? 'all-scouts' : 'requester-only',
    requester: profile.full_name || null,
    assignments: [
      ...matchRows.map((row) => assignmentRow(row, names, String(row.scouting_type || 'match'))),
      ...pitRows.map((row) => assignmentRow(row, names, 'pit')),
      ...prescoutRows.map((row) => assignmentRow(row, names, 'prescout'))
    ].filter(Boolean)
  };
}

function compactMatch(matchKey) {
  const value = String(matchKey || '');
  const qualification = value.match(/_qm(\d+)$/i);
  return qualification ? `Q${qualification[1]}` : value.split('_').at(-1) || value;
}

export function formatScoutingAssignments(context, question = '') {
  if (!context?.available) {
    if (context?.reason === 'no-active-event') return 'No active scouting event is configured, so I cannot resolve assignments.';
    if (context?.reason === 'slack-profile-not-linked' || context?.reason === 'missing-slack-user') {
      return 'I cannot read scouting assignments for this Slack account because it is not linked to a Spartans Hub profile.';
    }
    if (context?.reason === 'account-disabled') return 'This Spartans Hub account is disabled.';
    return 'I could not read scouting assignments from Spartans Hub right now.';
  }

  let rows = context.assignments || [];
  if (context.visibility === 'all-scouts') {
    const normalizedQuestion = String(question || '').toLowerCase();
    const namedScouts = [...new Set(rows.map((row) => row.scout))]
      .filter((name) => name !== 'Unknown scout' && normalizedQuestion.includes(name.toLowerCase()));
    if (namedScouts.length) rows = rows.filter((row) => namedScouts.includes(row.scout));
  }
  if (!rows.length) {
    return context.visibility === 'requester-only'
      ? `You have no assignments for ${context.eventKey}.`
      : `No matching scouting assignments were found for ${context.eventKey}.`;
  }

  const byScout = new Map();
  for (const row of rows) {
    if (!byScout.has(row.scout)) byScout.set(row.scout, []);
    const target = row.match ? `${compactMatch(row.match)}/T${row.team}` : `T${row.team}`;
    byScout.get(row.scout).push(`${row.kind}: ${target}${row.completed ? ' ✓' : ''}`);
  }
  const heading = context.visibility === 'requester-only'
    ? `*Your scouting assignments — ${context.eventKey}:*`
    : `*Scouting assignments — ${context.eventKey}:*`;
  const lines = [heading];
  for (const [scout, assignments] of [...byScout.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`• *${scout}:* ${assignments.join(', ')}`);
  }
  return safeSlackText(lines.join('\n'));
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

export async function askGeminiAboutHub(question, snapshot, options = {}) {
  const apiKey = options.apiKey ?? env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  // Google limits Gemini 2.5 access for new projects. Use the current stable
  // Flash-Lite model unless an administrator deliberately overrides it.
  const model = options.model ?? env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  // A Gemini request can outlast Slack's three-second acknowledgement window.
  // The durable event receipt prevents Slack's retry from posting a second reply.
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: `You are Spartans Hub, a concise general-purpose Slack assistant with special knowledge of Spartans Hub. Answer ordinary general-knowledge, math, science, robotics, and programming questions directly. Answer claims about Spartans Hub only from the supplied internal evidence; never invent Hub data. You may use Google Search for public facts such as event dates, schedules, locations, news, and current information. If a Hub answer is not present and search is irrelevant, say you do not know and direct the user to the relevant Hub page or an administrator. Never imply that a report or assignment is complete unless live data explicitly proves it. Use Slack markdown, no tables, include concise source links for web-grounded facts, and never generate @channel, @here, or @everyone mentions.\n\nHUB FEATURE CATALOG:\n${HUB_FEATURE_CATALOG}\n\nRECENT CHANGES:\n${HUB_RECENT_CHANGES.join('\n')}\n\nLIVE SNAPSHOT:\n${JSON.stringify(snapshot)}` }]
        },
        contents: [{ role: 'user', parts: [{ text: safeSlackText(question).slice(0, 1200) }] }],
        ...(options.useGoogleSearch ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { maxOutputTokens: 450 }
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const providerStatus = String(payload?.error?.status || '').toUpperCase();
      const providerMessage = String(payload?.error?.message || '');
      let reason = 'service';
      if (
        [400, 401, 403].includes(response.status)
        && (/API[_ ]?KEY|CREDENTIAL|PERMISSION_DENIED/.test(`${providerStatus} ${providerMessage}`.toUpperCase()))
      ) {
        reason = 'credential';
      } else if (response.status === 404 || providerStatus === 'NOT_FOUND') {
        reason = 'model';
      } else if (response.status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
        reason = 'quota';
      }
      const error = new Error(`Gemini request failed (${response.status}${providerStatus ? ` ${providerStatus}` : ''})`);
      error.geminiReason = reason;
      error.httpStatus = response.status;
      throw error;
    }
    let answer = safeSlackText((payload?.candidates?.[0]?.content?.parts || [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join(''));
    if (!answer) throw new Error('Gemini returned an empty answer');
    const sources = [...new Map((payload?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map((chunk) => chunk?.web)
      .filter((web) => web?.uri)
      .map((web) => [web.uri, { uri: web.uri, title: safeSlackText(web.title || 'Source') }])).values()]
      .slice(0, 3);
    if (sources.length && !sources.some((source) => answer.includes(source.uri))) {
      answer = safeSlackText(`${answer}\n\n*Sources:* ${sources.map((source) => `<${source.uri}|${source.title}>`).join(' · ')}`);
    }
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

function geminiFailureReply(error) {
  if (error?.message === 'GEMINI_API_KEY is not configured') {
    return 'AI questions are not configured on this server yet. `@Spartans Hub /status` still works.';
  }
  if (error?.name === 'AbortError') {
    return 'The Hub question-answering service timed out. Try again shortly or use `@Spartans Hub /status`.';
  }
  if (error?.geminiReason === 'credential') {
    return 'Gemini rejected the server credential. An administrator must replace `GEMINI_API_KEY` with an active Google AI Studio authorization key.';
  }
  if (error?.geminiReason === 'model') {
    return 'The configured Gemini model is unavailable to this project. An administrator must update `GEMINI_MODEL` or the app default.';
  }
  if (error?.geminiReason === 'quota') {
    return 'The Hub question-answering service has exhausted its Gemini quota. Try again later or use `@Spartans Hub /status`.';
  }
  return 'I could not reach the Hub question-answering service. Try `@Spartans Hub /status`, or ask again shortly.';
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
  } else if (isScoutingAssignmentQuestion(question)) {
    const requestedEventKey = assignmentEventKey(question, snapshot.eventKey);
    const assignmentContext = await fetchScoutingAssignmentsForSlackUser(
      supa,
      event.user,
      requestedEventKey,
      { slack }
    );
    text = formatScoutingAssignments(assignmentContext, question);
  } else {
    try {
      text = await askGeminiAboutHub(question, snapshot, {
        ...dependencies,
        useGoogleSearch: shouldUseGoogleSearch(question)
      });
    } catch (error) {
      console.error('Gemini Hub assistant failed', error?.message || error);
      text = geminiFailureReply(error);
    }
  }
  const response = await slack.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text
  });
  return { ok: !!response?.ok, channel: response?.channel || event.channel, ts: response?.ts || null };
}
