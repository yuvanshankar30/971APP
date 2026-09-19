// Server proxy for The Blue Alliance's per-team status at ONE event -
// current rank, qual record, and playoff status/alliance in a single call,
// rather than making the Blue Alliance tab derive all of that client-side
// from rankings/alliances/matches separately.
// GET /api/tba/team-event-status?team_key=frc971&event_key=2026cc
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const teamKey = String(url.searchParams.get('team_key') || '').trim().toLowerCase();
  if (!/^frc\d+$/.test(teamKey)) return json({ success: false, error: 'valid team_key required' }, { status: 400 });
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ success: false, error: 'event_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(
      `https://www.thebluealliance.com/api/v3/team/${encodeURIComponent(teamKey)}/event/${encodeURIComponent(eventKey)}/status`,
      { headers: { 'X-TBA-Auth-Key': authKey } }
    );
    if (response.status === 404) return json({ success: true, data: null });
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const data = await response.json();
    return json({ success: true, data: data || null });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
