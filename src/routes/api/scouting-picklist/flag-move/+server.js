import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';

// Advisory-only AI review of a human pick-list drag-reorder move (Picklist
// tab, section 3A of docs/plans/strategy-picklist-improvements.md). Same
// OpenAI Responses API shape as the one other LLM integration in this repo
// (src/routes/api/purchasing/identify-photo/+server.js), just text-only -
// no image, so no size limit or image_url handling needed here.
//
// This never blocks a reorder: the caller applies the move first via the
// existing /api/scouting-picklist reorder action, then calls this endpoint
// to get an opinion. A 503 (key unset/not configured) or any other failure
// here just means "no flag available this time," not an error to surface.
function getClientFromRequest(request) {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
}

function responseText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  return (response?.output || []).flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text')
    .map((content) => content.text || '').join('');
}

function summarizeTeam(team) {
  if (!team) return null;
  const parts = [`Team ${team.teamNumber}`];
  if (Number.isFinite(team.scoutPower)) parts.push(`Scout Power ${team.scoutPower.toFixed(1)}`);
  if (Number.isFinite(team.avgFuel)) parts.push(`avg fuel ${team.avgFuel.toFixed(1)}`);
  if (Number.isFinite(team.avgBallsScored)) parts.push(`avg teleop balls ${team.avgBallsScored.toFixed(1)}`);
  if (team.openProblems) parts.push(`${team.openProblems} open ACE issue(s)`);
  return parts.join(', ');
}

export async function POST({ request }) {
  if (!env.OPENAI_API_KEY) return json({ success: false, error: 'AI flagging is not configured yet.' }, { status: 503 });

  const authSupa = getClientFromRequest(request);
  const { data: auth } = await authSupa.auth.getUser();
  if (!auth?.user?.id) return json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const movedTeam = body?.movedTeam;
  const neighbors = Array.isArray(body?.neighbors) ? body.neighbors.slice(0, 4) : [];
  if (!movedTeam?.teamNumber) return json({ success: false, error: 'movedTeam required' }, { status: 400 });

  const prompt = [
    'A scout just moved a team on an FRC alliance-selection pick list.',
    `Moved: ${summarizeTeam(movedTeam)} (from position ${body?.fromIndex ?? '?'} to ${body?.toIndex ?? '?'}, 1 = first pick).`,
    `Now adjacent to: ${neighbors.map(summarizeTeam).filter(Boolean).join('; ') || 'no other teams nearby'}.`,
    'Based only on the numbers given, does this placement look questionable - e.g. a team with clearly weaker scouted numbers placed above one with clearly stronger numbers, with no other reason implied? Minor differences or roughly similar numbers are NOT worth flagging.',
    'Return JSON only: {"flagged": boolean, "reason": string|null}. reason should be one short sentence naming the specific numbers that look off, or null if not flagged.'
  ].join('\n');

  try {
    const aiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        store: false,
        max_output_tokens: 200,
        text: { format: { type: 'json_object' } },
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
      })
    });
    if (!aiResponse.ok) {
      console.error('Picklist flag-move request failed', aiResponse.status, await aiResponse.text());
      return json({ success: false, error: 'Flagging unavailable right now.' }, { status: 502 });
    }
    let result;
    try { result = JSON.parse(responseText(await aiResponse.json())); }
    catch { return json({ success: false, error: 'Flagging response was unreadable.' }, { status: 502 }); }
    return json({
      success: true,
      flagged: Boolean(result?.flagged),
      reason: result?.flagged && typeof result?.reason === 'string' ? result.reason.trim().slice(0, 300) : null
    });
  } catch (e) {
    return json({ success: false, error: e?.message || 'Internal error' }, { status: 500 });
  }
}
