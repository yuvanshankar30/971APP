import { describe, expect, it } from 'vitest';
import { buildScoutingComparison, visionMatchKeys } from './scoutingComparison.js';

const observation = (extra = {}) => ({ id: 'o', team_key: 'frc971', alliance: 'red', vision_run_id: 'r', phase: 'teleop', observation_type: 'fuel_scored', value: { count: 4 }, started_ms: 20000, ended_ms: 20100, confidence: 0.8, review_status: 'accepted', ...extra });
const data = (observations = [], extra = {}) => ({ manual: { id: 'm', team_key: 'frc971', event_key: '2026test', match_key: '14', balls_scored_band: '100-150', auto_points_band: '500+', auto_cycles: 0, ratings: { Defense: 4, BPS: 3 }, intake_speed: 2, preload: false, teleop_notes: 'Strong defense' }, run: { id: 'r', status: 'complete', config: {} }, observations, tracks: [], ...extra });
const chart = (result, key) => result.charts.find(row => row.key === key);

describe('manual/vision comparison', () => {
  it('matches bare match numbers, local keys and qualified playoff keys', () => {
    expect(visionMatchKeys('2026test', '14')).toContain('2026test_qm14');
    expect(visionMatchKeys('2026test', 'qm14')).toContain('2026test_qm14');
    expect(visionMatchKeys('2026test', '2026test_sf1m2')).toContain('sf1m2');
  });
  it('retains estimate bounds, observed zero, and every manual answer', () => {
    const result = buildScoutingComparison(data([observation()]));
    expect(chart(result, 'teleop-fuel')).toMatchObject({ manual: { value: 125, min: 100, max: 150 }, vision: { value: 4 }, difference: -121 });
    expect(chart(result, 'auto-points')).toMatchObject({ manual: { value: 500, min: 500, max: null }, vision: { value: null } });
    expect(chart(result, 'auto-cycles').manual.value).toBe(0);
    expect(result.answers).toContainEqual(expect.objectContaining({ field: 'preload', manual: 'No' }));
    expect(result.answers).toContainEqual(expect.objectContaining({ field: 'teleop_notes', manual: 'Strong defense' }));
    expect(chart(result, 'rating-Defense').vision.value).toBeNull();
  });
  it('filters team/run identity and never assigns alliance-only observations to the team', () => {
    const result = buildScoutingComparison(data([observation(), observation({ team_key: 'frc254' }), observation({ team_key: null }), observation({ vision_run_id: 'old' })]));
    expect(result.observations).toHaveLength(1);
    expect(chart(result, 'teleop-fuel').vision.value).toBe(4);
  });
  it('defaults to reviewed data and exposes provisional candidates only on request', () => {
    const input = data([observation(), observation({ id: 'u', started_ms: 25000, review_status: 'unreviewed' }), observation({ id: 'x', started_ms: 30000, review_status: 'rejected' })]);
    expect(chart(buildScoutingComparison(input), 'teleop-fuel').vision.value).toBe(4);
    expect(chart(buildScoutingComparison(input, { reviewedOnly: false }), 'teleop-fuel').vision.value).toBe(8);
  });
  it('separates phases using explicit phase or run timing and deduplicates views', () => {
    const result = buildScoutingComparison(data([observation(), observation({ id: 'dup', view_id: 'other', started_ms: 20100 }), observation({ id: 'auto', phase: null, started_ms: 10000, value: { count: 2 } })]));
    expect(chart(result, 'teleop-fuel').vision.value).toBe(4);
    expect(chart(result, 'auto-fuel').vision.value).toBe(2);
  });
  it('keeps unavailable vision distinct from zero and skips uncalibrated track metrics', () => {
    const result = buildScoutingComparison(data([], { tracks: [{ vision_run_id: 'r', team_key: 'frc971', trajectory: [{ t: 0, x: 1, y: 1, calibrated: false }], metrics: { distanceMeters: 900 } }] }));
    expect(chart(result, 'teleop-fuel').vision.value).toBeNull();
    expect(chart(result, 'distanceMeters')).toBeUndefined();
  });
});
