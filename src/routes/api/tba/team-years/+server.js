// Server proxy for The Blue Alliance's per-team season history.
// GET /api/tba/team-years?team_key=frc971
// Powers the Blue Alliance tab's year picker (every season a team has
// competed in, past and present) - a distinct resource from team-matches
// (one season's matches) and team-events (one season's event list).
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const teamKey = String(url.searchParams.get('team_key') || '').trim().toLowerCase();
  if (!/^frc\d+$/.test(teamKey)) return json({ success: false, error: 'valid team_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(
      `https://www.thebluealliance.com/api/v3/team/${encodeURIComponent(teamKey)}/years_participated`,
      { headers: { 'X-TBA-Auth-Key': authKey } }
    );
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const years = (await response.json()) || [];
    return json({ success: true, data: [...years].sort((a, b) => b - a) });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
