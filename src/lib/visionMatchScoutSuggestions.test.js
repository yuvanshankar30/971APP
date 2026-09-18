import { describe, expect, it } from 'vitest';
import { buildVisionMatchScoutSuggestions } from './visionMatchScoutSuggestions.js';

const densePath = Array.from({ length: 12 }, (_, index) => ({
  t: index * 1000, x: 1 + index * 0.2, y: 2 + index * 0.1, calibrated: true, confidence: 0.9
}));
const track = (extra = {}) => ({
  team_key: 'frc971', alliance: 'blue', trajectory: densePath,
  metrics: { autoStartZone: 'left mound', deadAuto: false, coverageMs: 11000 }, ...extra
});
const observation = (extra = {}) => ({
  id: 'fuel', team_key: 'frc971', alliance: 'blue', review_status: 'accepted',
  observation_type: 'fuel_scored', phase: 'teleop', started_ms: 20_000, value: { count: 4 }, ...extra
});

describe('reviewed vision match-scout suggestions', () => {
  it('offers only objective reviewed evidence, including a viable calibrated auto path', () => {
    const result = buildVisionMatchScoutSuggestions({ run: { config: {} }, teamKey: 'frc971', tracks: [track()], observations: [observation()] });
    expect(result.fields).toMatchObject({
      startingPosition: 'left mound', autoMoved: 'ran', ballsScored: '4', autoPathName: 'Vision-reviewed auto path'
    });
    expect(result.fields.autoPath.length).toBeGreaterThanOrEqual(2);
    expect(result.unavailable).toContain('preload');
    expect(result.unavailable).toContain('ratings');
  });

  it('never includes unreviewed or another team’s observations', () => {
    const result = buildVisionMatchScoutSuggestions({
      teamKey: 'frc971', tracks: [],
      observations: [observation({ review_status: 'unreviewed' }), observation({ id: 'other', team_key: 'frc254', value: { count: 99 } })]
    });
    expect(result.fields.ballsScored).toBeUndefined();
    expect(result.reviewed).toBe(false);
  });

  it('uses stopped rather than dead for a reviewed disabled event and refuses conflicting start zones', () => {
    const result = buildVisionMatchScoutSuggestions({
      teamKey: 'frc971', tracks: [track(), track({ metrics: { autoStartZone: 'right trench', deadAuto: true } })],
      observations: [observation({ observation_type: 'disabled', value: {}, started_ms: 30_000 })]
    });
    expect(result.fields.teleopRobotStatus).toBe('stopped');
    expect(result.fields.startingPosition).toBeUndefined();
    expect(result.fields.autoMoved).toBe('ran');
  });

  it('does not turn auto fuel into points or teleop balls', () => {
    const result = buildVisionMatchScoutSuggestions({
      teamKey: 'frc971', tracks: [], observations: [observation({ phase: 'auto', started_ms: 5000, value: { count: 7 } })]
    });
    expect(result.fields.autoPoints).toBeUndefined();
    expect(result.fields.ballsScored).toBeUndefined();
  });
});
