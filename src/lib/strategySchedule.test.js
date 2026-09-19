import { describe, expect, it } from 'vitest';
import { buildStrategySchedule, teamAlliance } from './strategySchedule.js';

const team = 'frc971';
const match = (number, extra = {}) => ({
  key: `2026test_qm${number}`, comp_level: 'qm', match_number: number,
  predicted_time: 1_800_000_000 + number * 600,
  alliances: { red: { team_keys: [team, 'frc1', 'frc2'] }, blue: { team_keys: ['frc3', 'frc4', 'frc5'] } },
  ...extra
});

describe('strategy schedule', () => {
  it('identifies the selected team alliance', () => {
    expect(teamAlliance(match(1), team)).toBe('red');
    expect(teamAlliance(match(1, { alliances: { red: { team_keys: [] }, blue: { team_keys: [team] } } }), team)).toBe('blue');
  });

  it('counts future matches chronologically and shows the next match at the top', () => {
    const schedule = buildStrategySchedule([match(3), match(1), match(2)], team);
    expect(schedule.realUpcoming.map((entry) => entry.match_number)).toEqual([1, 2, 3]);
    expect(schedule.upcoming.map((entry) => entry.match.match_number)).toEqual([1, 2, 3]);
    expect(schedule.upcoming.map((entry) => entry.matchesAway)).toEqual([0, 1, 2]);
  });

  it('does not let a practice match change the real match-away count', () => {
    const schedule = buildStrategySchedule([match(1), match(2), match(99, { is_test_market: true, predicted_time: null })], team);
    expect(schedule.upcoming.map((entry) => entry.matchesAway)).toEqual([0, 1, null]);
  });

  it('keeps played matches separate and newest-first', () => {
    const schedule = buildStrategySchedule([match(2, { actual_time: 1_800_001_200 }), match(1, { actual_time: 1_800_000_600 })], team);
    expect(schedule.upcoming).toEqual([]);
    expect(schedule.played.map((entry) => entry.match.match_number)).toEqual([2, 1]);
  });
});
