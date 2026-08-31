import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { getSupabase } from '$lib/server/971bot.js';
import { selectPitScoutEntries } from '$lib/server/pitScoutingSchema.js';
import { getServiceAccountAccessToken } from '$lib/server/google_service_account.js';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive'
].join(' ');

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

function writeClient(fallback) {
  try {
    return getSupabase();
  } catch {
    return fallback;
  }
}

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function teamNumber(teamKey) {
  return text(teamKey).replace(/^frc/i, '') || 'Unknown';
}

async function collectEventScouting(db, eventKey) {
  const eventMatch = `${eventKey}_%`;
  const [eventsResult, matchResult, notesResult, problemsResult, pitResult] = await Promise.all([
    db.from('scout_data_events')
      .select('id,match_key,match_number,team_key,phase,event_type,event_value,role,created_at')
      .ilike('match_key', eventMatch)
      .order('created_at', { ascending: true })
      .limit(50000),
    db.from('match_scout_entries')
      .select('*')
      .eq('event_key', eventKey)
      .order('match_key')
      .order('team_key'),
    db.from('scout_notes')
      .select('*')
      .ilike('match_key', eventMatch)
      .order('created_at', { ascending: false })
      .limit(50000),
    db.from('pit_problem_reports')
      .select('id,team_key,match_key,summary,detail,severity,resolved,created_at')
      .eq('event_key', eventKey)
      .order('created_at', { ascending: false }),
    selectPitScoutEntries(db, (query) => query.eq('event_key', eventKey).order('team_key', { ascending: true }))
  ]);

  const failures = [
    eventsResult.error,
    matchResult.error,
    notesResult.error,
    problemsResult.error,
    pitResult.error
  ].filter(Boolean);
  if (failures.length) throw new Error(failures[0].message);

  return {
    data_events: eventsResult.data || [],
    match_entries: matchResult.data || [],
    pit_entries: pitResult.data || [],
    notes: notesResult.data || [],
    pit_problems: problemsResult.data || []
  };
}

function summaryFor(data) {
  const teams = new Map();
  const add = (key, source) => {
    if (!key) return;
    const entry = teams.get(key) || { team_key: key, data_events: 0, match_entries: 0, pit_entries: 0, notes: 0, open_problems: 0 };
    entry[source] += 1;
    teams.set(key, entry);
  };
  for (const row of data.data_events) add(row.team_key, 'data_events');
  for (const row of data.match_entries) add(row.team_key, 'match_entries');
  for (const row of data.pit_entries) add(row.team_key, 'pit_entries');
  for (const row of data.notes) add(row.team_key, 'notes');
  for (const row of data.pit_problems) {
    add(row.team_key, 'open_problems');
    if (row.resolved) teams.get(row.team_key).open_problems -= 1;
  }
  const team_rows = [...teams.values()]
    .map((row) => ({ ...row, total: row.data_events + row.match_entries + row.pit_entries + row.notes }))
    .sort((a, b) => b.total - a.total || Number(teamNumber(a.team_key)) - Number(teamNumber(b.team_key)));
  return {
    teams: team_rows,
    totals: {
      teams: team_rows.length,
      data_events: data.data_events.length,
      match_entries: data.match_entries.length,
      pit_entries: data.pit_entries.length,
      notes: data.notes.length,
      open_problems: data.pit_problems.filter((row) => !row.resolved).length
    }
  };
}

function documentText(eventKey, data, summary) {
  const lines = [
    `Scouting Report: ${eventKey}`,
    `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' })}`,
    '',
    'Coverage',
    `Teams represented: ${summary.totals.teams}`,
    `Data scouting observations: ${summary.totals.data_events}`,
    `Match scouting reports: ${summary.totals.match_entries}`,
    `Pit scouting profiles: ${summary.totals.pit_entries}`,
    `Scout notes: ${summary.totals.notes}`,
    `Open ACE Team problems: ${summary.totals.open_problems}`,
    '',
    'Team Coverage'
  ];
  for (const row of summary.teams) {
    lines.push(`Team ${teamNumber(row.team_key)}: ${row.data_events} data observations, ${row.match_entries} match reports, ${row.pit_entries} pit profiles, ${row.notes} notes${row.open_problems ? `, ${row.open_problems} open ACE problem${row.open_problems === 1 ? '' : 's'}` : ''}`);
  }
  if (data.pit_problems.length) {
    lines.push('', 'ACE Team Problems');
    for (const problem of data.pit_problems) {
      lines.push(`Team ${teamNumber(problem.team_key)}${problem.match_key ? ` (${problem.match_key})` : ''}: ${text(problem.summary)}${problem.resolved ? ' [resolved]' : ' [open]'}`);
    }
  }
  if (data.notes.length) {
    lines.push('', 'Scout Notes');
    for (const note of data.notes) lines.push(`Team ${teamNumber(note.team_key)}${note.match_key ? ` (${note.match_key})` : ''}: ${text(note.notes)}`);
  }
  return lines.join('\n');
}

async function createGoogleDocument({ title, content, email }) {
  if (!env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY) {
    throw new Error('Google Docs export is not configured. Add GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY first.');
  }
  const token = await getServiceAccountAccessToken(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY, GOOGLE_SCOPES);
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const createResponse = await fetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST', headers, body: JSON.stringify({ title })
  });
  const document = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !document.documentId) throw new Error(document?.error?.message || 'Google Docs could not create the report.');

  const writeResponse = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(document.documentId)}:batchUpdate`, {
    method: 'POST', headers,
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] })
  });
  if (!writeResponse.ok) {
    const body = await writeResponse.json().catch(() => ({}));
    throw new Error(body?.error?.message || 'Google Docs could not write the report.');
  }

  const shareResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(document.documentId)}/permissions?sendNotificationEmail=true`, {
    method: 'POST', headers,
    body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email })
  });
  if (!shareResponse.ok) {
    const body = await shareResponse.json().catch(() => ({}));
    throw new Error(body?.error?.message || 'The report was created, but could not be shared with your Google account.');
  }
  return { id: document.documentId, url: `https://docs.google.com/document/d/${document.documentId}/edit` };
}

export async function GET({ request, url }) {
  const auth = clientFor(request);
  const { data: authData } = await auth.auth.getUser();
  if (!authData?.user) return json({ error: 'Unauthorized' }, { status: 401 });
  const eventKey = text(url.searchParams.get('event_key'));
  if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });
  try {
    const data = await collectEventScouting(writeClient(auth), eventKey);
    return json({ success: true, data, summary: summaryFor(data) });
  } catch (error) {
    return json({ error: error.message || 'Unable to load scouting report.' }, { status: 500 });
  }
}

export async function POST({ request }) {
  const auth = clientFor(request);
  const { data: authData } = await auth.auth.getUser();
  const actor = authData?.user;
  if (!actor) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!actor.email) return json({ error: 'Your account needs an email address to receive a Google Doc export.' }, { status: 400 });
  const body = await request.json().catch(() => null);
  const eventKey = text(body?.event_key);
  if (body?.action !== 'export-google-doc' || !eventKey) return json({ error: 'event_key is required' }, { status: 400 });
  try {
    const data = await collectEventScouting(writeClient(auth), eventKey);
    const summary = summaryFor(data);
    const document = await createGoogleDocument({
      title: `Scouting Report - ${eventKey}`,
      content: documentText(eventKey, data, summary),
      email: actor.email
    });
    return json({ success: true, data: document });
  } catch (error) {
    return json({ error: error.message || 'Unable to export scouting report.' }, { status: 500 });
  }
}
