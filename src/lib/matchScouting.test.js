import { describe, expect, it } from 'vitest';
import {
  AUTO_ROBOT_SIZE,
  autoCenterlineIntervals,
  autoRobotCollision,
  canExtendAutoPath,
  continueAutoPath,
  parseAutoPointsEstimate,
  robotBoundsAtAutoPoint
} from './matchScouting.js';

describe('parseAutoPointsEstimate', () => {
  it('keeps an exact count exact', () => {
    expect(parseAutoPointsEstimate('84')).toEqual({
      input: '84', min: 84, max: 84, average: 84, kind: 'exact'
    });
  });

  it('derives the midpoint of a general range', () => {
    expect(parseAutoPointsEstimate(' 80 to 100 ')).toEqual({
      input: '80-100', min: 80, max: 100, average: 90, kind: 'range'
    });
  });

  it('accepts typographic dashes and decimal estimates', () => {
    expect(parseAutoPointsEstimate('12.5–17.5')?.average).toBe(15);
  });

  it('uses an open-ended value as a conservative lower-bound estimate', () => {
    expect(parseAutoPointsEstimate('100+')).toEqual({
      input: '100+', min: 100, max: null, average: 100, kind: 'lower-bound'
    });
  });

  it('accepts approximate notation and commas', () => {
    expect(parseAutoPointsEstimate('~1,000')?.average).toBe(1000);
  });

  it('rejects reversed, negative, excessive, and nonsensical input', () => {
    for (const invalid of ['100-50', '-5', '1001', 'lots', '50ish']) {
      expect(parseAutoPointsEstimate(invalid)).toBeNull();
    }
  });

  it('treats a blank field as an intentionally skipped estimate', () => {
    expect(parseAutoPointsEstimate('')).toBeNull();
    expect(parseAutoPointsEstimate(null)).toBeNull();
  });
});

describe('continueAutoPath', () => {
  it('keeps points from earlier pointer gestures', () => {
    const existingPath = [
      [12, 24],
      [18, 30]
    ];

    expect(continueAutoPath(existingPath, [25, 36])).toEqual([
      [12, 24],
      [18, 30],
      [25, 36]
    ]);
  });

  it('starts a path when no earlier gesture exists', () => {
    expect(continueAutoPath(undefined, [5, 10])).toEqual([[5, 10]]);
  });
});

describe('autonomous robot footprint', () => {
  it('uses a square 29-inch robot footprint', () => {
    const bounds = robotBoundsAtAutoPoint([50, 50]);
    expect(AUTO_ROBOT_SIZE.width).toBeCloseTo(AUTO_ROBOT_SIZE.height, 1);
    expect(bounds.width).toBeCloseTo(AUTO_ROBOT_SIZE.width, 6);
    expect(bounds.height).toBeCloseTo(AUTO_ROBOT_SIZE.height, 6);
  });

  it('rejects robot positions that overlap a hub or protected trench', () => {
    expect(autoRobotCollision([29.2, 50])?.id).toBe('own-hub');
    expect(autoRobotCollision([27.7, 8.5])?.id).toBe('own-top-trench');
  });

  it('does not let a fast path extension jump through a hub', () => {
    const result = canExtendAutoPath([[15, 50]], [45, 50]);
    expect(result.allowed).toBe(false);
    expect(result.collision?.id).toBe('own-hub');
    expect(autoRobotCollision(result.lastSafePoint)).toBeNull();
  });

  it('returns only the portion of a path segment that overlaps a centerline', () => {
    const intervals = autoCenterlineIntervals([40, 30], [60, 30]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0][0]).toBeGreaterThan(0);
    expect(intervals[0][1]).toBeLessThan(1);
  });
});
