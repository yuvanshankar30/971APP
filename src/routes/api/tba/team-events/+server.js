// Server proxy for The Blue Alliance's per-team, per-season event list.
// GET /api/tba/team-events?team_key=frc971&year=2026
// A distinct resource from team-matches (that team's matches, not its list
// of events) and event-teams (an event's roster, not a team's schedule).
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
// Returns events sorted by start date, earliest first.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const teamKey = String(url.searchParams.get('team_key') || '').trim().toLowerCase();
  if (!/^frc\d+$/.test(teamKey)) return json({ success: false, error: 'valid team_key required' }, { status: 400 });

  const rawYear = String(url.searchParams.get('year') || '').trim();
  const year = /^\d{4}$/.test(rawYear) ? rawYear : String(new Date().getFullYear());

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(
      `https://www.thebluealliance.com/api/v3/team/${encodeURIComponent(teamKey)}/events/${encodeURIComponent(year)}/simple`,
      { headers: { 'X-TBA-Auth-Key': authKey } }
    );
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const data = ((await response.json()) || []).sort((a, b) =>
      String(a?.start_date || '').localeCompare(String(b?.start_date || ''))
    );
    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
