import { describe, expect, it } from 'vitest';
import { normalizeRobotRating } from './robotRatingSchema.js';

describe('normalizeRobotRating', () => {
  it('normalizes a full rating, defaulting team_number from the team key', () => {
    const { value, error } = normalizeRobotRating({
      event_key: ' 2026casj ',
      team_key: '971',
      overall_rating: 8.4,
      auto_rating: 6,
      offense_rating: 9,
      shuttling_rating: 7,
      driving_rating: 10,
      defense_rating: '',
      notes: '  Fast cycles, clean auto  ',
      strategy_notes: 'Ran defense on us in practice match 3'
    }, 'user-1');

    expect(error).toBeNull();
    expect(value).toMatchObject({
      event_key: '2026casj',
      team_key: 'frc971',
      team_number: 971,
      overall_rating: 8, // rounded
      auto_rating: 6,
      offense_rating: 9,
      shuttling_rating: 7,
      driving_rating: 10,
      defense_rating: null, // blank means "not applicable"
      notes: 'Fast cycles, clean auto',
      strategy_notes: 'Ran defense on us in practice match 3',
      created_by: 'user-1'
    });
  });

  it('treats a blank auto_rating as "not entered" like the other optional fields', () => {
    const { value, error } = normalizeRobotRating({ event_key: 'x', team_key: '971', overall_rating: 5, auto_rating: '' }, 'user-1');
    expect(error).toBeNull();
    expect(value.auto_rating).toBeNull();
  });

  it('requires event_key, a valid team_key, and an authenticated scout', () => {
    expect(normalizeRobotRating({ team_key: '971', overall_rating: 5 }, 'user-1').error).toMatch(/event_key/);
    expect(normalizeRobotRating({ event_key: 'x', team_key: 'bad', overall_rating: 5 }, 'user-1').error).toMatch(/valid team/);
    expect(normalizeRobotRating({ event_key: 'x', team_key: '971', overall_rating: 5 }, null).error).toMatch(/authenticated/);
  });

  it('requires overall_rating within 1-10 and rejects it entirely blank', () => {
    expect(normalizeRobotRating({ event_key: 'x', team_key: '971' }, 'user-1').error).toMatch(/overall_rating/);
    expect(normalizeRobotRating({ event_key: 'x', team_key: '971', overall_rating: 0 }, 'user-1').error).toMatch(/overall_rating/);
    expect(normalizeRobotRating({ event_key: 'x', team_key: '971', overall_rating: 11 }, 'user-1').error).toMatch(/overall_rating/);
  });

  it('rejects an out-of-range optional rating instead of silently clamping it', () => {
    const { error } = normalizeRobotRating({
      event_key: 'x', team_key: '971', overall_rating: 5, defense_rating: 15
    }, 'user-1');
    expect(error).toMatch(/defense_rating/);

    expect(normalizeRobotRating({ event_key: 'x', team_key: '971', overall_rating: 5, auto_rating: 0 }, 'user-1').error).toMatch(/auto_rating/);
    expect(normalizeRobotRating({ event_key: 'x', team_key: '971', overall_rating: 5, auto_rating: 11 }, 'user-1').error).toMatch(/auto_rating/);
  });
});
