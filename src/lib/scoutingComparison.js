import { parseAutoPointsEstimate, MATCH_FORM_RATING_FIELDS, MATCH_OPTIONAL_RATING_FIELDS } from './matchScouting.js';
import { fuseObservations, DEFAULT_AUTO_END_MS, autoStartPosition } from './visionAnalytics.js';

export function visionMatchKeys(eventKey, matchKey) {
  const original = String(matchKey || '').trim();
  const local = original.startsWith(`${eventKey}_`) ? original.slice(eventKey.length + 1) : original;
  const canonical = /^\d+$/.test(local) ? `qm${Number(local)}` : local;
  return [...new Set([original, local, canonical, `${eventKey}_${canonical}`, `${eventKey}_${local}`])];
}

const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const scalar = value => value == null || value === '' ? 'Not recorded' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.length ? value.map(scalar).join(', ') : 'None recorded' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const humanize = value => value.replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
const datum = (value, label = null, min = null, max = null) => ({ value: number(value), label: label || (number(value) == null ? 'Not measured' : String(value)), min, max });
function estimate(raw, fallback) {
  const parsed = parseAutoPointsEstimate(raw);
  return parsed ? datum(parsed.average, parsed.input, parsed.min, parsed.max) : datum(fallback);
}

// Manual ratings are judgements, not proxies for unmeasured vision quantities.
export function buildScoutingComparison(data, { reviewedOnly = true } = {}) {
  const manual = data?.manual || {};
  const run = data?.run;
  const teamObservations = (data?.observations || []).filter(row => row.team_key === manual.team_key && row.vision_run_id === run?.id);
  const eligible = teamObservations.filter(row => reviewedOnly ? ['accepted', 'corrected'].includes(row.review_status) : !['rejected', 'unobservable'].includes(row.review_status));
  const observations = fuseObservations(eligible);
  const tracks = (data?.tracks || []).filter(row => row.team_key === manual.team_key && row.vision_run_id === run?.id);
  const autoEnd = number(run?.config?.auto_end_ms) ?? DEFAULT_AUTO_END_MS;
  const isAuto = row => row.phase ? row.phase === 'auto' : number(row.started_ms) != null && row.started_ms < autoEnd;
  const fuel = observations.filter(row => row.observation_type === 'fuel_scored');
  const fuelCount = rows => rows.reduce((sum, row) => sum + Math.max(0, number(row.value?.count) ?? 1), 0);
  // No fuel detections is missing evidence, not a measured score of zero.
  const count = rows => rows.length ? datum(fuelCount(rows)) : datum(null, 'No matching detections');
  const charts = [
    { key: 'teleop-fuel', title: 'Teleop balls scored', unit: 'balls', manual: estimate(manual.balls_scored_band, manual.balls_scored_average), vision: count(fuel.filter(row => !isAuto(row))), note: 'Manual ranges use their midpoint; “+” values use the lower bound. Vision shows attributed score candidates, not official scores.' },
    { key: 'auto-points', title: 'Autonomous points estimate', unit: 'points', manual: estimate(manual.auto_points_band, manual.auto_points_average), vision: datum(null, 'Not measured'), note: 'Ball counts are not converted into points: vision does not measure all autonomous scoring.' },
    { key: 'auto-fuel', title: 'Autonomous balls scored', unit: 'balls', manual: datum(null, 'Not collected in this form'), vision: count(fuel.filter(isAuto)) },
    { key: 'auto-cycles', title: 'Autonomous cycles', unit: 'cycles', manual: datum(manual.auto_cycles), vision: datum(null) }
  ];
  for (const field of [...new Set([...MATCH_FORM_RATING_FIELDS, ...MATCH_OPTIONAL_RATING_FIELDS, ...Object.keys(manual.ratings || {})])]) {
    charts.push({ key: `rating-${field}`, title: field, unit: 'rating / 5', scale: 5,
      manual: datum(manual.ratings_unknown?.includes(field) ? null : manual.ratings?.[field], manual.ratings_unknown?.includes(field) ? 'Unjudged' : null), vision: datum(null, 'Not rated by vision') });
  }
  charts.push({ key: 'intake', title: 'Intake speed', unit: 'rating / 3', scale: 3, manual: datum(manual.intake_speed), vision: datum(null, 'Not rated by vision') });
  for (const type of [...new Set(observations.map(row => row.observation_type))].sort()) {
    charts.push({ key: `event-${type}`, title: `Vision: ${humanize(type)} events`, unit: 'events', manual: datum(null, 'Not counted in this form'), vision: datum(observations.filter(row => row.observation_type === type).length) });
  }
  const calibrated = tracks.filter(track => track.trajectory?.length && track.trajectory.every(point => point.calibrated === true));
  const bestTrack = calibrated.sort((a, b) => (number(b.metrics?.coverageMs) ?? 0) - (number(a.metrics?.coverageMs) ?? 0))[0];
  for (const [key, title, unit] of [['distanceMeters', 'Tracked distance', 'metres'], ['medianSpeedMps', 'Median robot speed', 'm/s'], ['p90SpeedMps', '90th percentile robot speed', 'm/s'], ['coverageMs', 'Tracked motion coverage', 'seconds']]) {
    if (bestTrack && number(bestTrack.metrics?.[key]) != null) charts.push({ key, title, unit, manual: datum(null, 'Not measured by manual form'), vision: datum(bestTrack.metrics[key] / (key === 'coverageMs' ? 1000 : 1)) });
  }
  for (const chart of charts) chart.difference = chart.manual.value != null && chart.vision.value != null ? chart.vision.value - chart.manual.value : null;
  const startZones = [...new Set(tracks.map(autoStartPosition).filter(Boolean))];
  const disabled = observations.filter(row => row.observation_type === 'disabled');
  const excluded = new Set(['id', 'created_by', 'created_at', 'updated_at', 'form_version', 'event_key', 'match_key', 'team_key', 'scout_name']);
  const answers = Object.entries(manual).filter(([key]) => !excluded.has(key)).map(([key, value]) => ({ field: key, label: humanize(key), manual: scalar(value), vision: key === 'starting_position' || key === 'auto_start_zone' ? scalar(startZones.length ? startZones : null) : key === 'teleop_robot_status' || key === 'robot_disabled' ? disabled.length ? 'Disabled event observed (does not distinguish dead from stopped)' : 'No disabled event observed' : 'Not measured in the same format' }));
  for (const [index, problem] of (data?.pitProblems || []).entries()) {
    answers.push({ field: `pit-summary-${index}`, label: `ACE Team problem${problem.resolved ? ' (resolved)' : ''}`, manual: scalar(problem.summary), vision: 'Not collected in the same format' });
    answers.push({ field: `pit-detail-${index}`, label: 'ACE Team detail', manual: scalar(problem.detail), vision: 'Not collected in the same format' });
  }
  return { charts, answers, observations, tracks, counts: { total: teamObservations.length, included: eligible.length, fused: observations.length, unreviewed: teamObservations.filter(row => !['accepted', 'corrected', 'rejected', 'unobservable'].includes(row.review_status)).length }, hasVision: Boolean(run && (teamObservations.length || tracks.length)), reviewedOnly };
}
