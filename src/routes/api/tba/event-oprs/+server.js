// Server proxy for The Blue Alliance's per-team power ratings at an event.
// GET /api/tba/event-oprs?event_key=2026arc
// Replaces the old /api/statbotics/team-epas route: api.statbotics.io was
// returning HTTP 500 on every query (see GitHub issue #80) - a live
// upstream outage, not a request-shape issue. TBA's own OPR/DPR/CCWM plus
// its rankings endpoint are the closest official replacement and don't
// depend on a third-party service.
//
// TBA's real endpoints return parallel dicts keyed by team key, not an
// array of rows (confirmed live: GET /event/{key}/oprs -> {oprs:{frcNNNN:n},
// dprs:{...}, ccwms:{...}}; GET /event/{key}/rankings -> {rankings:[{team_key,
// rank, record:{wins,losses,ties}}]}) - reshaped here into the same
// array-of-rows-keyed-by-bare-team-number shape the old Statbotics route
// returned, so existing consumers (datascout, /scouting) only need their
// fetch URL changed, not their Map-building logic.
//
// TBA has no auto/teleop/endgame power-rating breakdown the way Statbotics
// EPA did - auto_epa/teleop_epa/endgame_epa are intentionally always null
// here rather than guessed at from score_breakdown; consumers already
// null-guard these fields.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ url }) {
  const eventKey = url.searchParams.get('event_key');
  if (!eventKey) return json({ success: false, error: 'event_key required' }, { status: 400 });

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return json({ success: false, error: 'Server missing TBA_API_KEY' }, { status: 500 });

  const headers = { 'X-TBA-Auth-Key': authKey };
  const base = `https://www.thebluealliance.com/api/v3/event/${encodeURIComponent(eventKey)}`;

  try {
    const [oprsResp, rankingsResp] = await Promise.all([
      fetch(`${base}/oprs`, { headers }),
      fetch(`${base}/rankings`, { headers })
    ]);

    if (!oprsResp.ok && !rankingsResp.ok) {
      return json({ success: false, error: `TBA upstream errors ${oprsResp.status}/${rankingsResp.status}` }, { status: 502 });
    }

    const oprsData = oprsResp.ok ? (await oprsResp.json()) || {} : {};
    const oprs = oprsData.oprs || {};

    // Either half may exist before the other during an event. Preserve ranks
    // when OPR has not been calculated yet, and preserve OPR during a transient
    // rankings failure.
    let rankingRows = [];
    if (rankingsResp.ok) {
      const rankingsData = (await rankingsResp.json()) || {};
      rankingRows = rankingsData.rankings || [];
    }
    const rankingByTeamKey = new Map(rankingRows.map((r) => [r.team_key, r]));

    const teamKeys = new Set([...Object.keys(oprs), ...rankingRows.map((row) => row.team_key).filter(Boolean)]);
    const data = [...teamKeys].map((teamKey) => {
      const teamNumber = Number(String(teamKey).replace(/^frc/i, ''));
      const ranking = rankingByTeamKey.get(teamKey);
      return {
        team: Number.isFinite(teamNumber) ? teamNumber : teamKey,
        team_name: '',
        rank: ranking?.rank ?? null,
        epa: oprs[teamKey] ?? null,
        auto_epa: null,
        teleop_epa: null,
        endgame_epa: null,
        wins: ranking?.record?.wins ?? 0,
        losses: ranking?.record?.losses ?? 0,
        ties: ranking?.record?.ties ?? 0
      };
    });

    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: e.message || 'Fetch failed' }, { status: 500 });
  }
}
