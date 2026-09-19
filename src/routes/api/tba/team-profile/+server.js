// Server proxy for The Blue Alliance's full team profile.
// GET /api/tba/team-profile?team_key=frc971
// A distinct resource/path from teams-simple (which only returns key/number/
// nickname/name for many teams at once) - this is the fuller record for ONE
// team the Blue Alliance tab's header needs: location, rookie year, website.
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const teamKey = String(url.searchParams.get('team_key') || '').trim().toLowerCase();
  if (!/^frc\d+$/.test(teamKey)) return json({ success: false, error: 'valid team_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(`https://www.thebluealliance.com/api/v3/team/${encodeURIComponent(teamKey)}`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (response.status === 404) return json({ success: false, error: 'Team not found' }, { status: 404 });
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const row = await response.json();
    return json({
      success: true,
      data: {
        key: row?.key,
        team_number: row?.team_number,
        nickname: row?.nickname || '',
        name: row?.name || '',
        city: row?.city || '',
        state_prov: row?.state_prov || '',
        country: row?.country || '',
        rookie_year: row?.rookie_year ?? null,
        website: row?.website || '',
        motto: row?.motto || ''
      }
    });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
