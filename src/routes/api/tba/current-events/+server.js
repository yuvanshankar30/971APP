// Server proxy for The Blue Alliance's full event list for a season, trimmed
// down to only events currently relevant to bet on: ones that haven't ended
// yet and start within the next couple of weeks. The prediction market page
// uses this to populate its event picker instead of being locked to a
// single team's events.
// GET /api/tba/current-events?year=2026 (year defaults to the current calendar year)
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
// Returns: { success:true, data:[ { key, name, short_name, start_date,
//   end_date, week, city, state_prov, country, webcasts:[], live:boolean } ] }
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// How far out an event can start and still show up in the picker - wide
// enough to plan ahead for an event that hasn't started, narrow enough that
// the dropdown isn't cluttered with events months away.
const UPCOMING_WINDOW_DAYS = 14;

export async function GET({ url }) {
  const year = Number(url.searchParams.get('year')) || new Date().getFullYear();

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(`https://www.thebluealliance.com/api/v3/events/${encodeURIComponent(year)}`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const events = await response.json();
    const today = new Date().toISOString().slice(0, 10);
    const windowEnd = new Date(Date.now() + UPCOMING_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

    const data = (events || [])
      .filter((event) => event?.start_date && event?.end_date)
      .filter((event) => event.end_date >= today && event.start_date <= windowEnd)
      .map((event) => ({
        key: event.key,
        name: event.name || '',
        short_name: event.short_name || '',
        start_date: event.start_date,
        end_date: event.end_date,
        week: event.week ?? null,
        city: event.city || '',
        state_prov: event.state_prov || '',
        country: event.country || '',
        webcasts: Array.isArray(event.webcasts) ? event.webcasts : [],
        live: event.start_date <= today && today <= event.end_date
      }))
      .sort((a, b) => (a.live === b.live ? a.start_date.localeCompare(b.start_date) : a.live ? -1 : 1));

    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
