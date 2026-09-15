import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  const teamKey = String(url.searchParams.get('team_key') || '').trim().toLowerCase();
  if (!/^\d{4}[a-z0-9]+$/i.test(eventKey)) return json({ success: false, error: 'valid event_key required' }, { status: 400 });
  if (!/^frc\d+$/i.test(teamKey)) return json({ success: false, error: 'valid team_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(
      `https://www.thebluealliance.com/api/v3/team/${encodeURIComponent(teamKey)}/media/${eventKey.slice(0, 4)}`,
      { headers: { 'X-TBA-Auth-Key': authKey } }
    );
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });
    return json({ success: true, data: (await response.json()) || [] });
  } catch (error) {
    return json({ success: false, error: error?.message || 'Fetch failed' }, { status: 500 });
  }
}
