import { describe, expect, it } from 'vitest';
import { buildStrategyRows, strategyTotals } from './strategyScouting.js';

describe('strategy scouting overview', () => {
  it('combines every scouting source into one team brief', () => {
    const rows = buildStrategyRows({
      data_events: [
        { team_key: 'frc971', match_key: '2026test_qm1', event_type: 'rank_accuracy', event_value: '4' },
        { team_key: 'frc971', match_key: '2026test_qm1', event_type: 'hub_fuel' }
      ],
      match_entries: [{ team_key: 'frc971', auto_points_estimate: '20-30', auto_moved: 'ran' }],
      pit_entries: [{ team_key: 'frc971', robot_archetype: 'Shooter' }],
      notes: [{ team_key: 'frc971', notes: 'Fast cycle' }],
      auto_paths: [{ team_key: 'frc971', name: 'Center four-piece' }],
      pit_problems: [{ team_key: 'frc971', resolved: false, severity: 'watch' }]
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teamNumber: '971', autoAverage: 25, autoMobilityRate: 1, coverage: 6 });
    expect(rows[0].performance.avgAccuracy).toBe(4);
    expect(rows[0].autoPaths[0].name).toBe('Center four-piece');
    expect(rows[0].openProblems).toHaveLength(1);
    expect(strategyTotals(rows)).toEqual({ teams: 1, matchReports: 1, pitProfiles: 1, notes: 1, autoPaths: 1, openProblems: 1 });
  });
});
