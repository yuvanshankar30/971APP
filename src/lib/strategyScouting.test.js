import { describe, expect, it } from 'vitest';
import { buildStrategyRows, strategyTotals } from './strategyScouting.js';

describe('strategy scouting overview', () => {
  it('combines every scouting source into one team brief', () => {
    const rows = buildStrategyRows({
      data_events: [
        { team_key: 'frc971', match_key: '2026test_qm1', event_type: 'rank_accuracy', event_value: '4' },
        { team_key: 'frc971', match_key: '2026test_qm1', event_type: 'hub_fuel' }
      ],
      match_entries: [{
        team_key: 'frc971',
        match_key: '2026test_qm1',
        auto_points_band: '20-30',
        auto_points_average: 25,
        balls_scored_average: 75,
        auto_moved: 'ran',
        teleop_roles: ['Scoring']
      }],
      pit_entries: [{ team_key: 'frc971', robot_archetype: 'Shooter' }],
      notes: [{ team_key: 'frc971', notes: 'Fast cycle' }],
      auto_paths: [{ team_key: 'frc971', name: 'Center four-piece' }],
      pit_problems: [{ team_key: 'frc971', resolved: false, severity: 'watch' }]
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teamNumber: '971', autoAverage: 25, autoMobilityRate: 1, coverage: 6 });
    expect(rows[0].performance.avgAccuracy).toBe(4);
    expect(rows[0].matchScoutSummary).toMatchObject({ reportCount: 1, avgBallsScored: 75, roleCounts: { Scoring: 1 } });
    expect(rows[0].autoPaths[0].name).toBe('Center four-piece');
    expect(rows[0].openProblems).toHaveLength(1);
    expect(strategyTotals(rows)).toEqual({ teams: 1, matchReports: 1, pitProfiles: 1, notes: 1, autoPaths: 1, openProblems: 1 });
  });

  it('does not count an unanswered auto result as a failed run', () => {
    const [row] = buildStrategyRows({
      match_entries: [
        { team_key: 'frc971', match_key: '2026test_qm1', auto_moved: 'ran' },
        { team_key: 'frc971', match_key: '2026test_qm2', auto_moved: null }
      ]
    });

    expect(row.autoMobilityRate).toBe(1);
  });

  it('includes every event team before scouts collect data', () => {
    const rows = buildStrategyRows(
      { match_entries: [{ team_key: 'frc971', match_key: '2026test_qm1' }] },
      [{ key: 'frc254' }, { key: 'frc971' }, { key: 'frc1678' }]
    );

    expect(rows.map((row) => row.teamNumber)).toEqual(['254', '971', '1678']);
    expect(rows.find((row) => row.teamKey === 'frc254')).toMatchObject({ coverage: 0, matchEntries: [] });
  });
});
