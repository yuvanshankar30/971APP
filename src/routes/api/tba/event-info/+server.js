// Server proxy for The Blue Alliance's own event record (name, dates,
// location, week) - distinct from event-matches/event-teams/event-oprs,
// which all assume the caller already knows those details and just want
// the roster/schedule/stats for one already-identified event.
// GET /api/tba/event-info?event_key=2026cc
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!eventKey) return json({ success: false, error: 'event_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(`https://www.thebluealliance.com/api/v3/event/${encodeURIComponent(eventKey)}`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (response.status === 404) return json({ success: false, error: 'Event not found' }, { status: 404 });
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const row = await response.json();
    return json({
      success: true,
      data: {
        key: row?.key,
        name: row?.name || '',
        short_name: row?.short_name || '',
        event_type_string: row?.event_type_string || '',
        start_date: row?.start_date || '',
        end_date: row?.end_date || '',
        week: row?.week ?? null,
        year: row?.year ?? null,
        city: row?.city || '',
        state_prov: row?.state_prov || '',
        country: row?.country || '',
        website: row?.website || '',
        webcasts: Array.isArray(row?.webcasts) ? row.webcasts : []
      }
    });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
