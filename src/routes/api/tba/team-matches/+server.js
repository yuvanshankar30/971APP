// Server proxy for The Blue Alliance's per-team match history.
// GET /api/tba/team-matches?team_key=frc971&year=2026
// Unlike /api/tba/event-matches (scoped to one event), this returns a
// team's matches across every event they played that season - the "cross-
// event match history" the Strategy/Picklist feature request asked for, so
// a team's recent form isn't hidden just because it happened at a
// different event than the one currently active.
// Hides the TBA_API_KEY from the browser; uses server env var TBA_API_KEY.
// Returns: { success:true, data:[ { key, event_key, match_number, comp_level, alliances:{...} } ] }
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

const COMP_LEVEL_ORDER = { pm: 0, qm: 1, ef: 2, qf: 3, sf: 4, f: 5 };

export async function GET({ url }) {
  const teamKey = String(url.searchParams.get('team_key') || '').trim().toLowerCase();
  if (!/^frc\d+$/i.test(teamKey)) return json({ success: false, error: 'valid team_key required' }, { status: 400 });

  const rawYear = String(url.searchParams.get('year') || '').trim();
  const year = /^\d{4}$/.test(rawYear) ? rawYear : String(new Date().getFullYear());

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  try {
    const response = await fetch(
      `https://www.thebluealliance.com/api/v3/team/${encodeURIComponent(teamKey)}/matches/${encodeURIComponent(year)}`,
      { headers: { 'X-TBA-Auth-Key': authKey } }
    );
    if (!response.ok) return json({ success: false, error: `TBA upstream error ${response.status}` }, { status: 502 });

    const data = ((await response.json()) || []).sort((a, b) => {
      const eventDelta = String(a?.event_key || '').localeCompare(String(b?.event_key || ''));
      if (eventDelta !== 0) return eventDelta;
      const levelDelta =
        (COMP_LEVEL_ORDER[String(a?.comp_level || '').toLowerCase()] ?? 99) -
        (COMP_LEVEL_ORDER[String(b?.comp_level || '').toLowerCase()] ?? 99);
      if (levelDelta !== 0) return levelDelta;
      const setDelta = (a?.set_number || 0) - (b?.set_number || 0);
      if (setDelta !== 0) return setDelta;
      return (a?.match_number || 0) - (b?.match_number || 0);
    });

    return json({ success: true, data });
  } catch (error) {
    return json({ success: false, error: error?.message || 'Fetch failed' }, { status: 500 });
  }
}
