const finite = (value) => Number.isFinite(Number(value));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
};

export function trajectoryMetrics(points, { minConfidence = 0.5 } = {}) {
  const clean = (points || []).filter((point) => finite(point?.t) && finite(point?.x) && finite(point?.y) && (point.confidence ?? 1) >= minConfidence).sort((a, b) => a.t - b.t);
  const speeds = [];
  const accelerations = [];
  const turnRates = [];
  let distance = 0;
  let movingMs = 0;
  let stationaryMs = 0;
  let priorSpeed = null;
  let priorHeading = null;
  for (let i = 1; i < clean.length; i += 1) {
    const previous = clean[i - 1];
    const current = clean[i];
    const dt = (current.t - previous.t) / 1000;
    if (dt <= 0 || dt > 1) continue;
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const segment = Math.hypot(dx, dy);
    const speed = segment / dt;
    distance += segment;
    speeds.push(speed);
    if (speed >= 0.25) movingMs += dt * 1000;
    else stationaryMs += dt * 1000;
    if (priorSpeed != null) accelerations.push(Math.abs(speed - priorSpeed) / dt);
    const heading = Math.atan2(dy, dx);
    if (priorHeading != null && speed >= 0.25) {
      const delta = Math.atan2(Math.sin(heading - priorHeading), Math.cos(heading - priorHeading));
      turnRates.push(Math.abs(delta) / dt);
    }
    priorSpeed = speed;
    priorHeading = heading;
  }
  return {
    sampleCount: clean.length,
    distanceMeters: distance,
    medianSpeedMps: percentile(speeds, 0.5),
    p90SpeedMps: percentile(speeds, 0.9),
    maxSpeedMps: speeds.length ? Math.max(...speeds) : null,
    meanAccelerationMps2: mean(accelerations),
    p90TurnRateRadS: percentile(turnRates, 0.9),
    movingMs,
    stationaryMs,
    coverageMs: movingMs + stationaryMs
  };
}

export function fuseObservations(observations, { dedupeWindowMs = 350 } = {}) {
  const sorted = [...(observations || [])].sort((a, b) => a.started_ms - b.started_ms);
  const fused = [];
  for (const observation of sorted) {
    const duplicate = fused.findLast((candidate) =>
      candidate.observation_type === observation.observation_type &&
      candidate.team_key === observation.team_key &&
      candidate.alliance === observation.alliance &&
      Math.abs(candidate.started_ms - observation.started_ms) <= dedupeWindowMs
    );
    if (!duplicate) fused.push({ ...observation, contributing_view_ids: observation.view_id ? [observation.view_id] : [] });
    else {
      if ((observation.confidence || 0) > (duplicate.confidence || 0)) Object.assign(duplicate, observation);
      if (observation.view_id && !duplicate.contributing_view_ids.includes(observation.view_id)) duplicate.contributing_view_ids.push(observation.view_id);
    }
  }
  return fused;
}

// End of the autonomous period, in match milliseconds. Matches
// vision_runner.py's phase_for_timestamp() default; both are overridable per
// run via config.auto_end_ms, and both must agree or an observation's stored
// phase and its derived auto/teleop split would disagree.
export const DEFAULT_AUTO_END_MS = 15_000;

// 2026 REBUILT field dimensions. Vision homographies use WPILib's fixed field
// frame in metres; the manual auto editor stores alliance-relative percentages.
export const AUTO_FIELD_METERS = Object.freeze({ length: 16.54175, width: 8.0518 });

const pointSegmentDistance = (point, start, end) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
};

function simplifyTrajectory(points, tolerance) {
  if (points.length <= 2) return points;
  let furthestDistance = 0;
  let furthestIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = pointSegmentDistance(points[index], points[0], points.at(-1));
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthestIndex = index;
    }
  }
  if (furthestDistance <= tolerance) return [points[0], points.at(-1)];
  return [
    ...simplifyTrajectory(points.slice(0, furthestIndex + 1), tolerance).slice(0, -1),
    ...simplifyTrajectory(points.slice(furthestIndex), tolerance)
  ];
}

/**
 * Convert one calibrated robot track into the same 0-100, alliance-relative
 * path consumed by RebuiltFieldMap and match_scout_auto_paths.
 *
 * The detector/tracker supplies the geometry; this function deliberately does
 * no generative drawing. It refuses to emit a production candidate when team
 * identity, calibration, auto coverage, continuity, or plausible motion is
 * missing, while returning diagnostics that tell a reviewer what failed.
 */
export function visionAutoPath(track, {
  autoEndMs = DEFAULT_AUTO_END_MS,
  minConfidence = 0.6,
  minSamples = 8,
  minCoverageMs = 8_000,
  maxGapMs = 1_500,
  maxSpeedMps = 8,
  simplifyToleranceM = 0.12,
  fieldLengthM = AUTO_FIELD_METERS.length,
  fieldWidthM = AUTO_FIELD_METERS.width
} = {}) {
  const alliance = String(track?.alliance || '').toLowerCase();
  const reasons = [];
  if (!track?.team_key) reasons.push('unresolved_team_identity');
  if (!['red', 'blue'].includes(alliance)) reasons.push('unknown_alliance');

  const autoPoints = (track?.trajectory || [])
    .filter((point) => finite(point?.t) && point.t >= 0 && point.t <= autoEndMs)
    .sort((a, b) => a.t - b.t);
  const points = autoPoints.filter((point) =>
    point.calibrated === true && finite(point.x) && finite(point.y) && Number(point.confidence ?? 1) >= minConfidence
  );
  if (autoPoints.length && !points.length) reasons.push('uncalibrated_field_coordinates');
  if (points.length < minSamples) reasons.push('insufficient_samples');

  const coverageMs = points.length > 1 ? points.at(-1).t - points[0].t : 0;
  if (coverageMs < minCoverageMs) reasons.push('insufficient_auto_coverage');
  let largestGapMs = 0;
  let fastestMps = 0;
  for (let index = 1; index < points.length; index += 1) {
    const elapsedMs = points[index].t - points[index - 1].t;
    largestGapMs = Math.max(largestGapMs, elapsedMs);
    if (elapsedMs > 0) {
      fastestMps = Math.max(fastestMps, Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y) / (elapsedMs / 1000));
    }
  }
  if (largestGapMs > maxGapMs) reasons.push('tracking_gap');
  if (fastestMps > maxSpeedMps) reasons.push('implausible_jump');

  const fieldMarginM = 0.5;
  if (points.some((point) => point.x < -fieldMarginM || point.x > fieldLengthM + fieldMarginM || point.y < -fieldMarginM || point.y > fieldWidthM + fieldMarginM)) {
    reasons.push('outside_field');
  }

  const simplified = simplifyTrajectory(points, simplifyToleranceM);
  const path = simplified.map((point) => {
    let x = Math.max(0, Math.min(100, point.x / fieldLengthM * 100));
    let y = Math.max(0, Math.min(100, point.y / fieldWidthM * 100));
    // WPILib's field origin is at the blue wall. Rotate red 180 degrees so
    // both alliances see their own wall on the editor's left.
    if (alliance === 'red') {
      x = 100 - x;
      y = 100 - y;
    }
    return [Number(x.toFixed(3)), Number(y.toFixed(3))];
  });

  return {
    viable: reasons.length === 0,
    reasons: [...new Set(reasons)],
    path,
    sampleCount: points.length,
    sourceSampleCount: autoPoints.length,
    coverageMs,
    largestGapMs,
    fastestMps: Number(fastestMps.toFixed(3))
  };
}

// How far a robot must travel during auto before it counts as having moved.
// Deliberately generous: tracker jitter on a stationary robot is on the order
// of a bounding-box wobble, and calling a working robot "dead" is a much worse
// error than staying quiet. Overridable via config.dead_auto_distance.
const DEAD_AUTO_DISTANCE = 0.75;

function autoTrajectory(track, autoEndMs) {
  return (track?.trajectory || [])
    .filter((point) => finite(point?.t) && finite(point?.x) && finite(point?.y) && point.t < autoEndMs)
    .sort((a, b) => a.t - b.t);
}

/**
 * Where a robot was sitting when auto began, as one of the named start zones
 * calibrated on its view.
 *
 * The zone lookup itself happens in the runner (vision_runner.py's
 * resolve_auto_start_zone), not here, and deliberately so: start-zone polygons
 * are stored normalized 0-1, while a trajectory point is in field units when a
 * homography is calibrated and raw pixels when it isn't. Only the runner holds
 * the frame dimensions and the un-projected pixel centre needed to compare
 * those honestly. This reads the answer it recorded.
 */
export function autoStartPosition(track) {
  return track?.metrics?.autoStartZone || null;
}

/**
 * Whether a robot did nothing during auto. Distinguishes "measurably did not
 * move" from "we never saw it", because those mean very different things to a
 * strategist and only the first is worth releasing.
 *
 * Distance is summed within a single trajectory, so it needs no coordinate
 * conversion - but the threshold's units follow whatever space that trajectory
 * is in. The default suits calibrated field units; on an uncalibrated
 * (pixel-space) view any real motion dwarfs it, which errs toward reporting a
 * robot as having moved. That is the safe direction: calling a working robot
 * dead is a much worse error than staying quiet.
 */
export function deadAuto(track, { autoEndMs = DEFAULT_AUTO_END_MS, minDistance = DEAD_AUTO_DISTANCE } = {}) {
  const points = autoTrajectory(track, autoEndMs);
  if (points.length < 2) return null;
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    distance += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return distance < minDistance;
}

export function summarizeVision(observations, tracks, options = {}) {
  const autoEndMs = Number(options.autoEndMs) || DEFAULT_AUTO_END_MS;
  const fused = fuseObservations(observations);
  const teams = {};
  const alliances = {
    red: { fuelScored: 0, fuelShots: 0, climbs: 0 },
    blue: { fuelScored: 0, fuelShots: 0, climbs: 0 }
  };
  const ensure = (teamKey) => teams[teamKey] ||= {
    fuelScored: 0, fuelObservations: 0, fuelShots: 0, fuelShotObservations: 0,
    climb: null, autoClimb: null,
    observations: 0, mobility: null, autoStartPosition: null, deadAuto: null
  };
  for (const observation of fused) {
    if (!observation.team_key) {
      const alliance = alliances[observation.alliance];
      if (alliance && observation.observation_type === 'fuel_scored') alliance.fuelScored += Number(observation.value?.count) || 1;
      if (alliance && observation.observation_type === 'fuel_shot') alliance.fuelShots += Number(observation.value?.count) || 1;
      if (alliance && observation.observation_type === 'climb_success') alliance.climbs += 1;
      continue;
    }
    const team = ensure(observation.team_key);
    team.observations += 1;
    if (observation.observation_type === 'fuel_scored') {
      team.fuelScored += Number(observation.value?.count) || 1;
      team.fuelObservations += 1;
    }
    if (observation.observation_type === 'fuel_shot') {
      team.fuelShots += Number(observation.value?.count) || 1;
      team.fuelShotObservations += 1;
    }
    if (observation.observation_type === 'climb_success') {
      // A climb during auto is a different scouting field from a teleop one
      // (auto_climb_pos vs climb_pos), and the runner already knows which is
      // which - the phase was being computed and then discarded here.
      const level = observation.value?.level || 'success';
      const inAuto = observation.phase === 'auto'
        || (!observation.phase && Number(observation.started_ms) < autoEndMs);
      if (inAuto) team.autoClimb = level;
      else team.climb = level;
    }
  }
  for (const track of tracks || []) {
    if (!track.team_key) continue;
    const team = ensure(track.team_key);
    const metrics = track.metrics && Object.keys(track.metrics).length ? track.metrics : trajectoryMetrics(track.trajectory);
    if (!team.mobility || (metrics.coverageMs || 0) > (team.mobility.coverageMs || 0)) team.mobility = metrics;

    const startPosition = autoStartPosition(track);
    if (startPosition && !team.autoStartPosition) team.autoStartPosition = startPosition;

    const dead = deadAuto(track, { autoEndMs });
    // Any view that saw the robot move settles it - one camera losing the
    // robot behind a truss shouldn't report a working robot as dead.
    if (dead === false) team.deadAuto = false;
    else if (dead === true && team.deadAuto == null) team.deadAuto = true;
  }
  return { teams, alliances, fusedObservations: fused };
}

/**
 * Orbit-style second opinion: apportion the official alliance fuel total by
 * each robot's observed share of shots. This is review evidence, never a
 * value that is released to scouting automatically.
 */
export function estimateFuelFromShots(summary, reference) {
  const estimates = {};
  for (const alliance of ['red', 'blue']) {
    const teamKeys = reference?.alliances?.[alliance]?.teamKeys || [];
    const officialFuel = Number(reference?.alliances?.[alliance]?.fuel);
    if (!Number.isFinite(officialFuel)) continue;
    const allianceOnlyShots = Number(summary?.alliances?.[alliance]?.fuelShots || 0);
    const attributedShots = teamKeys.reduce((sum, key) => sum + Number(summary?.teams?.[key]?.fuelShots || 0), 0);
    const totalShots = attributedShots + allianceOnlyShots;
    if (totalShots <= 0) continue;
    for (const teamKey of teamKeys) {
      const shotCount = Number(summary?.teams?.[teamKey]?.fuelShots || 0);
      estimates[teamKey] = {
        alliance,
        shotCount,
        allianceShotCount: totalShots,
        shotShare: shotCount / totalShots,
        estimatedScored: officialFuel * shotCount / totalShots,
        directScored: Number(summary?.teams?.[teamKey]?.fuelScored || 0),
        officialAllianceFuel: officialFuel
      };
    }
  }
  return estimates;
}

export function teamVisionAnalytics(tracks = [], observations = [], { defenseMeters = 2, sampleToleranceMs = 250 } = {}) {
  const output = {};
  const calibrated = tracks.filter((track) => track.team_key && track.trajectory?.some((point) => point.calibrated));
  for (const track of calibrated) {
    const result = output[track.team_key] ||= {
      calibrated: true, provenance: { trackIds: [], observationIds: [] },
      distanceMeters: 0, maxSpeedMps: null, meanAccelerationMps2: null,
      p90TurnRateRadS: null, defenseProximitySeconds: 0,
      cycleTimeSeconds: null, timeToFirstScoreSeconds: null
    };
    result.provenance.trackIds.push(track.id || track.track_key || null);
    const metrics = trajectoryMetrics(track.trajectory);
    result.distanceMeters += metrics.distanceMeters || 0;
    result.maxSpeedMps = Math.max(result.maxSpeedMps || 0, metrics.maxSpeedMps || 0);
    result.meanAccelerationMps2 = Math.max(result.meanAccelerationMps2 || 0, metrics.meanAccelerationMps2 || 0);
    result.p90TurnRateRadS = Math.max(result.p90TurnRateRadS || 0, metrics.p90TurnRateRadS || 0);
    let nearbySamples = 0;
    const points = track.trajectory.filter((point) => point.calibrated);
    for (const point of points) {
      const defended = calibrated.some((opponent) => opponent.alliance && track.alliance && opponent.alliance !== track.alliance
        && opponent.trajectory.some((candidate) => candidate.calibrated
          && Math.abs(candidate.t - point.t) <= sampleToleranceMs
          && Math.hypot(candidate.x - point.x, candidate.y - point.y) <= defenseMeters));
      if (defended) nearbySamples += 1;
    }
    const coverageSeconds = (points.at(-1)?.t - points[0]?.t) / 1000;
    if (points.length > 1 && Number.isFinite(coverageSeconds)) result.defenseProximitySeconds += coverageSeconds * nearbySamples / points.length;
  }
  for (const [teamKey, result] of Object.entries(output)) {
    const scores = observations
      .filter((observation) => observation.team_key === teamKey && observation.observation_type === 'fuel_scored'
        && !['rejected', 'unobservable'].includes(observation.review_status))
      .sort((left, right) => left.started_ms - right.started_ms);
    result.provenance.observationIds = scores.map((observation) => observation.id).filter(Boolean);
    if (scores.length) result.timeToFirstScoreSeconds = scores[0].started_ms / 1000;
    if (scores.length > 1) {
      const intervals = scores.slice(1).map((score, index) => (score.started_ms - scores[index].started_ms) / 1000).sort((a, b) => a - b);
      result.cycleTimeSeconds = percentile(intervals, 0.5);
    }
  }
  return output;
}

export function reconcileWithReference(summary, reference, thresholds = {}) {
  const fuelAbsolute = thresholds.fuelAbsolute ?? 3;
  const fuelPercent = thresholds.fuelPercent ?? 0.15;
  const discrepancies = [];
  const shotEstimates = estimateFuelFromShots(summary, reference);
  for (const alliance of ['red', 'blue']) {
    const teamKeys = reference?.alliances?.[alliance]?.teamKeys || [];
    const visionFuel = (summary.alliances?.[alliance]?.fuelScored || 0) + teamKeys.reduce((sum, key) => sum + (summary.teams[key]?.fuelScored || 0), 0);
    const referenceFuel = reference?.alliances?.[alliance]?.fuel;
    if (finite(referenceFuel)) {
      const difference = Math.abs(visionFuel - Number(referenceFuel));
      const percent = difference / Math.max(1, Number(referenceFuel));
      if (difference > fuelAbsolute && percent > fuelPercent) discrepancies.push({
        alliance, metric: 'fuel', vision_value: visionFuel, reference_value: Number(referenceFuel),
        absolute_difference: difference, percent_difference: percent,
        severity: percent >= 0.35 ? 'critical' : 'warning',
        reason: 'Vision alliance fuel differs materially from the official match breakdown.'
      });
    }
    for (const teamKey of teamKeys) {
      const estimate = shotEstimates[teamKey];
      if (!estimate || estimate.shotCount <= 0) continue;
      const direct = estimate.directScored;
      const difference = Math.abs(direct - estimate.estimatedScored);
      const percent = difference / Math.max(1, estimate.estimatedScored);
      if (difference > fuelAbsolute && percent > fuelPercent) discrepancies.push({
        team_key: teamKey, alliance, metric: 'fuel_attribution',
        vision_value: direct, reference_value: estimate.estimatedScored,
        absolute_difference: difference, percent_difference: percent,
        severity: percent >= 0.35 ? 'critical' : 'warning',
        reason: 'Direct goal-entry attribution differs materially from the shot-share estimate.',
        evidence: estimate
      });
    }
    const visionClimbs = (summary.alliances?.[alliance]?.climbs || 0) + teamKeys.filter((key) => summary.teams[key]?.climb).length;
    const referenceClimbs = reference?.alliances?.[alliance]?.climbs;
    if (finite(referenceClimbs) && visionClimbs !== Number(referenceClimbs)) discrepancies.push({
      alliance, metric: 'climb_count', vision_value: visionClimbs, reference_value: Number(referenceClimbs),
      absolute_difference: Math.abs(visionClimbs - Number(referenceClimbs)), percent_difference: null,
      severity: 'critical', reason: 'Vision and the official breakdown disagree on successful climbs.'
    });
  }
  return discrepancies;
}

export function reconcileVisionSources(primary, qwen, thresholds = {}) {
  const fuelAbsolute = thresholds.sourceFuelAbsolute ?? 3;
  const discrepancies = [];
  for (const alliance of ['red', 'blue']) {
    const primaryFuel = Number(primary?.alliances?.[alliance]?.fuelScored || 0);
    const qwenFuel = Number(qwen?.alliances?.[alliance]?.fuelScored || 0);
    const fuelDifference = Math.abs(primaryFuel - qwenFuel);
    if (fuelDifference > fuelAbsolute) discrepancies.push({
      alliance, metric: 'qwen_pipeline_fuel', vision_value: { pipeline: primaryFuel, qwen: qwenFuel },
      reference_value: null, absolute_difference: fuelDifference,
      percent_difference: fuelDifference / Math.max(1, primaryFuel),
      severity: fuelDifference >= Math.max(8, primaryFuel * 0.35) ? 'critical' : 'warning',
      reason: 'Qwen and the deterministic vision pipeline disagree materially on scored fuel.',
      evidence: { sources: ['qwen3_vl', 'classical_cv'] }
    });
    const primaryClimbs = Number(primary?.alliances?.[alliance]?.climbs || 0);
    const qwenClimbs = Number(qwen?.alliances?.[alliance]?.climbs || 0);
    if (primaryClimbs !== qwenClimbs) discrepancies.push({
      alliance, metric: 'qwen_pipeline_climb_count', vision_value: { pipeline: primaryClimbs, qwen: qwenClimbs },
      reference_value: null, absolute_difference: Math.abs(primaryClimbs - qwenClimbs),
      percent_difference: null, severity: 'critical',
      reason: 'Qwen and the deterministic vision pipeline disagree on completed climbs.',
      evidence: { sources: ['qwen3_vl', 'yolo'] }
    });
  }
  return discrepancies;
}
