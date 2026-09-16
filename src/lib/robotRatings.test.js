import { describe, expect, it } from 'vitest';
import { applyRobotRatings, myRobotRating, rankRobotTeams, summarizeRobotRatings } from './robotRatings.js';

const ratings = [
  { team_key: 'frc971', created_by: 'a', overall_rating: 8, offense_rating: 9, shuttling_rating: 7, driving_rating: 10, defense_rating: null, updated_at: '2026-09-01T00:00:00Z' },
  { team_key: 'frc971', created_by: 'b', overall_rating: 6, offense_rating: null, shuttling_rating: 5, driving_rating: 6, defense_rating: 4, updated_at: '2026-09-02T00:00:00Z' },
  { team_key: 'frc254', created_by: 'a', overall_rating: 10, offense_rating: 10, shuttling_rating: 10, driving_rating: 10, defense_rating: 10, updated_at: '2026-09-01T00:00:00Z' }
];

describe('summarizeRobotRatings', () => {
  it('averages each field independently, ignoring raters who left it blank', () => {
    const summary = summarizeRobotRatings(ratings);
    const team971 = summary.get('frc971');
    expect(team971.raterCount).toBe(2);
    expect(team971.overallAvg).toBe(7); // (8+6)/2
    expect(team971.offenseAvg).toBe(9); // only rater a entered offense
    expect(team971.defenseAvg).toBe(4); // only rater b entered defense
    expect(team971.entries[0].created_by).toBe('b'); // most recently updated first
  });

  it('never lets one team leak into another team summary', () => {
    const summary = summarizeRobotRatings(ratings);
    expect(summary.get('frc254').raterCount).toBe(1);
    expect(summary.get('frc254').overallAvg).toBe(10);
  });
});

describe('applyRobotRatings', () => {
  it('attaches a robotRating summary without mutating any existing team field', () => {
    const teams = [{ key: 'frc971', team_number: 971, scoutPower: 55.5 }, { key: 'frc1678', team_number: 1678, scoutPower: 70 }];
    const result = applyRobotRatings(teams, ratings);
    expect(result[0].scoutPower).toBe(55.5); // untouched
    expect(result[0].robotRating.overallAvg).toBe(7);
    expect(result[1].robotRating.raterCount).toBe(0); // no ratings yet - safe empty summary, not undefined
    expect(result[1].robotRating.overallAvg).toBeNull();
  });
});

describe('rankRobotTeams', () => {
  it('orders rated teams best to worst and leaves unrated teams at the end', () => {
    const teams = [
      { key: 'frc1678', team_number: 1678 },
      { key: 'frc971', team_number: 971 },
      { key: 'frc254', team_number: 254 },
      { key: 'frc604', team_number: 604 }
    ];
    const summary = summarizeRobotRatings(ratings);
    expect(rankRobotTeams(teams, summary).map((team) => team.key)).toEqual(['frc254', 'frc971', 'frc604', 'frc1678']);
  });
});

describe('myRobotRating', () => {
  it('finds the current user\'s own rating for a team, or null if they have not rated it', () => {
    expect(myRobotRating(ratings, 'frc971', 'a')).toMatchObject({ created_by: 'a', overall_rating: 8 });
    expect(myRobotRating(ratings, 'frc971', 'nobody')).toBeNull();
  });
});
