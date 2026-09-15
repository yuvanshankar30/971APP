import { describe, expect, it } from 'vitest';
import { evaluateVisionReadiness, formatBytes } from './visionReadiness.js';

const calibratedView = {
  id: 'view-1', field_mask: [[0, 0], [1, 0], [1, 1]],
  goal_zones: [{ label: 'red hub' }], homography: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  start_zones: [{ label: 'center' }]
};

describe('evaluateVisionReadiness', () => {
  it('reports a fully prepared match as ready', () => {
    const result = evaluateVisionReadiness({
      match: { team_roster: { red: ['frc1', 'frc2', 'frc3'], blue: ['frc4', 'frc5', 'frc6'] } },
      views: [calibratedView], modelName: 'detector', modelVersion: 'sha-123', runners: [{ online: true }]
    });
    expect(result.blocking).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('separates hard blockers from shadow-run warnings', () => {
    const result = evaluateVisionReadiness({ match: {}, views: [], modelName: '', modelVersion: '', runners: [] });
    expect(result.blocking.map((check) => check.id)).toEqual(['views', 'model']);
    expect(result.warnings.map((check) => check.id)).toContain('runner');
  });
});

it('formats upload sizes for an operator', () => {
  expect(formatBytes(225 * 1024 * 1024)).toBe('225 MB');
  expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
});
