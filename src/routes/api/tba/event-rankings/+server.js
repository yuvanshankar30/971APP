// Server proxy for The Blue Alliance's event qualification rankings.
// GET /api/tba/event-rankings?event_key=2026cc
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
// Returns: { success:true, data:{ rankings:[...], sort_order_info:[...] } }
// (TBA's own shape - sort_order_info names what each extra_stats/sort_orders
// column in a ranking row actually means, since it varies by game).
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ success: false, error: 'event_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(
      `https://www.thebluealliance.com/api/v3/event/${encodeURIComponent(eventKey)}/rankings`,
      { headers: { 'X-TBA-Auth-Key': authKey } }
    );
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const data = await response.json();
    return json({
      success: true,
      data: {
        rankings: Array.isArray(data?.rankings) ? data.rankings : [],
        sort_order_info: Array.isArray(data?.sort_order_info) ? data.sort_order_info : []
      }
    });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
