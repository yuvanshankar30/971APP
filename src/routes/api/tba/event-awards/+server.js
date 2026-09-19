// Server proxy for The Blue Alliance's event awards list.
// GET /api/tba/event-awards?event_key=2026cc
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
// Returns: { success:true, data:[ { name, award_type, recipient_list:[{team_key, awardee}] } ] }
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ success: false, error: 'event_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(
      `https://www.thebluealliance.com/api/v3/event/${encodeURIComponent(eventKey)}/awards`,
      { headers: { 'X-TBA-Auth-Key': authKey } }
    );
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const data = await response.json();
    return json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
