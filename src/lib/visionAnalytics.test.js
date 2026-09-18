import { describe, expect, it } from 'vitest';
import { AUTO_FIELD_METERS, autoStartPosition, deadAuto, fuseObservations, reconcileVisionSources, reconcileWithReference, summarizeVision, trajectoryMetrics, visionAutoPath } from './visionAnalytics.js';

describe('vision analytics', () => {
  it('derives real-coordinate mobility metrics', () => {
    const metrics = trajectoryMetrics([{ t: 0, x: 0, y: 0 }, { t: 1000, x: 1, y: 0 }, { t: 2000, x: 1, y: 2 }]);
    expect(metrics.distanceMeters).toBe(3);
    expect(metrics.maxSpeedMps).toBe(2);
    expect(metrics.coverageMs).toBe(2000);
  });

  it('deduplicates the same event seen by multiple cameras', () => {
    const fused = fuseObservations([
      { view_id: 'a', team_key: 'frc971', observation_type: 'fuel_scored', started_ms: 1000, confidence: 0.7 },
      { view_id: 'b', team_key: 'frc971', observation_type: 'fuel_scored', started_ms: 1100, confidence: 0.9 }
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].confidence).toBe(0.9);
    expect(fused[0].contributing_view_ids).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('does not merge simultaneous red and blue alliance actions', () => {
    const fused = fuseObservations([
      { alliance: 'red', team_key: null, observation_type: 'fuel_scored', started_ms: 1000, confidence: 0.8 },
      { alliance: 'blue', team_key: null, observation_type: 'fuel_scored', started_ms: 1000, confidence: 0.8 }
    ]);
    expect(fused).toHaveLength(2);
  });

  it('reconciles alliance-only detections before team identity is reviewed', () => {
    const summary = summarizeVision([{ alliance: 'red', team_key: null, observation_type: 'fuel_scored', value: { count: 10 }, started_ms: 1 }], []);
    const flags = reconcileWithReference(summary, { alliances: { red: { teamKeys: [], fuel: 10 }, blue: { teamKeys: [], fuel: 0 } } });
    expect(summary.alliances.red.fuelScored).toBe(10);
    expect(flags).toHaveLength(0);
  });

  it('summarizes team fuel and flags material alliance differences', () => {
    const summary = summarizeVision([{ team_key: 'frc971', observation_type: 'fuel_scored', value: { count: 8 }, started_ms: 1 }], []);
    const flags = reconcileWithReference(summary, { alliances: { red: { teamKeys: ['frc971'], fuel: 20, climbs: 0 }, blue: { teamKeys: [], fuel: 0, climbs: 0 } } });
    expect(summary.teams.frc971.fuelScored).toBe(8);
    expect(flags.some((flag) => flag.metric === 'fuel')).toBe(true);
  });

  it('flags material Qwen disagreements without mixing Qwen into pipeline totals', () => {
    const pipeline = summarizeVision([{ alliance: 'red', observation_type: 'fuel_scored', value: { count: 12 }, started_ms: 1 }], []);
    const qwen = summarizeVision([{ alliance: 'red', observation_type: 'fuel_scored', value: { count: 4 }, started_ms: 1 }], []);
    const flags = reconcileVisionSources(pipeline, qwen);
    expect(flags).toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'qwen_pipeline_fuel', severity: 'critical' })]));
    expect(pipeline.alliances.red.fuelScored).toBe(12);
  });
});

describe('auto-phase derivations', () => {
  const trackAt = (points, extra = {}) => ({
    team_key: 'frc971', view_id: 'view-1', trajectory: points, ...extra
  });

  it('splits a climb into auto_climb vs teleop climb by its phase', () => {
    const auto = summarizeVision([
      { observation_type: 'climb_success', team_key: 'frc971', alliance: 'red', phase: 'auto', started_ms: 8000, value: { level: 'L1' } }
    ], []);
    expect(auto.teams.frc971.autoClimb).toBe('L1');
    expect(auto.teams.frc971.climb).toBeNull();

    const teleop = summarizeVision([
      { observation_type: 'climb_success', team_key: 'frc971', alliance: 'red', phase: 'endgame', started_ms: 140000, value: { level: 'L3' } }
    ], []);
    expect(teleop.teams.frc971.climb).toBe('L3');
    expect(teleop.teams.frc971.autoClimb).toBeNull();
  });

  it('falls back to the timestamp when an observation carries no phase', () => {
    const summary = summarizeVision([
      { observation_type: 'climb_success', team_key: 'frc971', alliance: 'red', started_ms: 9000, value: { level: 'L1' } }
    ], []);
    expect(summary.teams.frc971.autoClimb).toBe('L1');
  });

  it('honours a run-configured auto window', () => {
    const observations = [{ observation_type: 'climb_success', team_key: 'frc971', alliance: 'red', started_ms: 18000, value: { level: 'L1' } }];
    expect(summarizeVision(observations, []).teams.frc971.climb).toBe('L1');
    expect(summarizeVision(observations, [], { autoEndMs: 20000 }).teams.frc971.autoClimb).toBe('L1');
  });

  it('reports a robot that never moved in auto as dead', () => {
    const still = trackAt([
      { t: 500, x: 4, y: 2 }, { t: 3000, x: 4.01, y: 2.01 }, { t: 12000, x: 4, y: 2 }
    ]);
    expect(deadAuto(still)).toBe(true);
    expect(summarizeVision([], [still]).teams.frc971.deadAuto).toBe(true);
  });

  it('reports a robot that drove in auto as not dead', () => {
    const moved = trackAt([{ t: 500, x: 0, y: 0 }, { t: 8000, x: 5, y: 3 }]);
    expect(deadAuto(moved)).toBe(false);
  });

  it('says nothing when the robot was never seen during auto', () => {
    // "We never saw it" and "we saw it do nothing" are different claims, and
    // only the second is worth releasing.
    expect(deadAuto(trackAt([{ t: 60000, x: 1, y: 1 }, { t: 70000, x: 1, y: 1 }]))).toBeNull();
    expect(deadAuto(trackAt([{ t: 500, x: 1, y: 1 }]))).toBeNull();
    expect(summarizeVision([], [trackAt([{ t: 60000, x: 1, y: 1 }])]).teams.frc971.deadAuto).toBeNull();
  });

  it('lets any view that saw movement overrule a view that lost the robot', () => {
    const blocked = trackAt([{ t: 500, x: 4, y: 2 }, { t: 6000, x: 4, y: 2 }], { view_id: 'view-1' });
    const clear = trackAt([{ t: 500, x: 0, y: 0 }, { t: 6000, x: 6, y: 4 }], { view_id: 'view-2' });
    expect(summarizeVision([], [blocked, clear]).teams.frc971.deadAuto).toBe(false);
    expect(summarizeVision([], [clear, blocked]).teams.frc971.deadAuto).toBe(false);
  });

  it('reads the start zone the runner resolved, and stays silent without one', () => {
    const named = trackAt([{ t: 500, x: 1, y: 1 }], { metrics: { autoStartZone: 'left mound' } });
    expect(autoStartPosition(named)).toBe('left mound');
    expect(summarizeVision([], [named]).teams.frc971.autoStartPosition).toBe('left mound');
    expect(autoStartPosition(trackAt([{ t: 500, x: 1, y: 1 }]))).toBeNull();
    expect(summarizeVision([], [trackAt([{ t: 500, x: 1, y: 1 }])]).teams.frc971.autoStartPosition).toBeNull();
  });

  it('ignores tracks with no resolved team, as everything else does', () => {
    const orphan = { view_id: 'view-1', team_key: null, trajectory: [{ t: 500, x: 4, y: 2 }, { t: 6000, x: 4, y: 2 }], metrics: { autoStartZone: 'center' } };
    expect(summarizeVision([], [orphan]).teams).toEqual({});
  });
});

describe('vision auto paths', () => {
  const denseTrack = (alliance = 'blue') => ({
    team_key: 'frc971', alliance,
    trajectory: Array.from({ length: 13 }, (_, index) => ({
      t: index * 1000,
      x: 1 + index * 0.25,
      y: 2 + (index > 5 ? 1 : 0),
      confidence: 0.9,
      calibrated: true
    }))
  });

  it('converts a calibrated track into the manual editor path format', () => {
    const candidate = visionAutoPath(denseTrack());
    expect(candidate.viable).toBe(true);
    expect(candidate.path.length).toBeGreaterThanOrEqual(3);
    expect(candidate.path[0]).toEqual([
      Number((1 / AUTO_FIELD_METERS.length * 100).toFixed(3)),
      Number((2 / AUTO_FIELD_METERS.width * 100).toFixed(3))
    ]);
  });

  it('rotates red paths into the alliance-relative editor orientation', () => {
    const blue = visionAutoPath(denseTrack('blue'));
    const red = visionAutoPath(denseTrack('red'));
    expect(red.path[0][0]).toBeCloseTo(100 - blue.path[0][0], 3);
    expect(red.path[0][1]).toBeCloseTo(100 - blue.path[0][1], 3);
  });

  it('refuses to publish sparse, uncalibrated, or unidentified tracks', () => {
    const candidate = visionAutoPath({ alliance: 'blue', trajectory: [
      { t: 0, x: 100, y: 200, confidence: 0.9, calibrated: false },
      { t: 12000, x: 200, y: 300, confidence: 0.9, calibrated: false }
    ] });
    expect(candidate.viable).toBe(false);
    expect(candidate.reasons).toEqual(expect.arrayContaining([
      'unresolved_team_identity', 'uncalibrated_field_coordinates', 'insufficient_samples', 'insufficient_auto_coverage'
    ]));
    expect(candidate.path).toEqual([]);
  });

  it('rejects identity swaps that appear as impossible robot motion', () => {
    const track = denseTrack();
    track.trajectory[6].x = 15;
    const candidate = visionAutoPath(track);
    expect(candidate.viable).toBe(false);
    expect(candidate.reasons).toContain('implausible_jump');
  });
});
