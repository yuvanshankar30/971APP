import { describe, expect, it } from 'vitest';
import { buildVisionReleasePreview } from './visionRelease.js';

describe('buildVisionReleasePreview', () => {
  it('shows exact scouting rows and skipped values without writing', () => {
    const result = buildVisionReleasePreview({
      matchKey: '2026casj_qm1', run: { config: {} }, tracks: [], views: [], observations: [
        { observation_type: 'fuel_scored', team_key: 'frc971', alliance: 'red', started_ms: 1000, value: { count: 2 }, review_status: 'accepted' },
        { observation_type: 'climb_success', team_key: 'frc971', alliance: 'red', started_ms: 120000, value: { level: 'success' }, review_status: 'accepted' },
        { observation_type: 'fuel_scored', team_key: 'frc254', alliance: 'red', started_ms: 2000, value: { count: 9 }, review_status: 'unreviewed' }
      ]
    });
    expect(result.rows).toEqual([{ match_key: '2026casj_qm1', team_key: 'frc971', event_type: 'hub_fuel_override', event_value: '2' }]);
    expect(result.skippedClimbs).toEqual([{ team_key: 'frc971', value: 'success' }]);
  });
});
