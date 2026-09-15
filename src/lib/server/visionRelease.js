import { summarizeVision } from '$lib/visionAnalytics.js';

export const VALID_CLIMB_POS = new Set(['N/A', 'Failed', 'L1', 'L2', 'L3']);

export function buildVisionReleasePreview({ matchKey, run, observations = [], tracks = [], views = [] }) {
  const reviewed = observations.filter((observation) => ['accepted', 'corrected'].includes(observation.review_status));
  const startZonesByView = Object.fromEntries(views.map((view) => [view.id, view.start_zones || []]));
  const summary = summarizeVision(reviewed, tracks, {
    autoEndMs: Number(run.config?.auto_end_ms) || undefined,
    startZonesByView
  });
  const rows = [];
  const skippedClimbs = [];
  for (const [teamKey, team] of Object.entries(summary.teams)) {
    if (!teamKey) continue;
    if (team.fuelObservations > 0 && Number.isFinite(team.fuelScored)) {
      rows.push({ match_key: matchKey, team_key: teamKey, event_type: 'hub_fuel_override', event_value: String(Math.round(team.fuelScored)) });
    }
    if (team.climb && VALID_CLIMB_POS.has(team.climb)) {
      rows.push({ match_key: matchKey, team_key: teamKey, event_type: 'climb_pos', event_value: team.climb });
    } else if (team.climb) {
      skippedClimbs.push({ team_key: teamKey, value: team.climb });
    }
    if (team.autoClimb && VALID_CLIMB_POS.has(team.autoClimb)) {
      rows.push({ match_key: matchKey, team_key: teamKey, event_type: 'auto_climb_pos', event_value: team.autoClimb });
    } else if (team.autoClimb) {
      skippedClimbs.push({ team_key: teamKey, value: team.autoClimb, field: 'auto_climb_pos' });
    }
    if (typeof team.deadAuto === 'boolean') {
      rows.push({ match_key: matchKey, team_key: teamKey, event_type: 'dead_auto', event_value: String(team.deadAuto) });
    }
    if (team.autoStartPosition) {
      rows.push({ match_key: matchKey, team_key: teamKey, event_type: 'auto_start_position', event_value: team.autoStartPosition });
    }
  }
  return { rows, skippedClimbs, teamCount: Object.keys(summary.teams).length };
}
