import { describe, it, expect } from 'vitest';
import {
  summarizeTeamEvents, summarizeTeamPerformance, buildPowerRankings,
  fuelCountFromEvents, deriveMatchTeamRow, summarizeScoutNotes, summarizePitScouting,
  applyPairwiseConsensus, matchRankingsToPairwiseVotes, summarizePairwisePair, summarizeMatchScoutEntries
} from './scoutingStats.js';

function event(overrides) {
  return { match_key: '2026casf_qm1', team_key: 'frc971', event_type: null, event_value: null, ...overrides };
}

describe('summarizeTeamEvents', () => {
  it('counts distinct matches, not events (many events per match)', () => {
    const events = [
      event({ match_key: '2026casf_qm1', event_type: 'phase', event_value: 'begin_auto' }),
      event({ match_key: '2026casf_qm1', event_type: 'phase', event_value: 'end_auto' }),
      event({ match_key: '2026casf_qm2', event_type: 'phase', event_value: 'begin_auto' })
    ];
    expect(summarizeTeamEvents(events).matchesScouted).toBe(2);
  });

  it('averages rank_driving, rank_accuracy, rank_speed independently', () => {
    const events = [
      event({ event_type: 'rank_driving', event_value: '2' }),
      event({ event_type: 'rank_driving', event_value: '3' }),
      event({ event_type: 'rank_accuracy', event_value: '5' }),
      event({ event_type: 'rank_speed', event_value: '1.5' })
    ];
    const s = summarizeTeamEvents(events);
    expect(s.avgDrivingRank).toBeCloseTo(2.5, 5);
    expect(s.avgAccuracy).toBeCloseTo(5, 5);
    expect(s.avgSpeed).toBeCloseTo(1.5, 5);
  });

  it('skips non-numeric event_value instead of corrupting the average (event_value is always stored as text)', () => {
    const events = [
      event({ event_type: 'rank_driving', event_value: '3' }),
      event({ event_type: 'rank_driving', event_value: 'not-a-number' }),
      event({ event_type: 'rank_driving', event_value: null })
    ];
    expect(summarizeTeamEvents(events).avgDrivingRank).toBeCloseTo(3, 5);
  });

  it('returns null (not 0 or NaN) for a metric with zero real observations', () => {
    const s = summarizeTeamEvents([event({ event_type: 'phase', event_value: 'begin_auto' })]);
    expect(s.avgDrivingRank).toBeNull();
    expect(s.avgAccuracy).toBeNull();
    expect(s.avgSpeed).toBeNull();
    expect(s.mostCommonClimb).toBeNull();
  });

  it('finds the most common climb_pos and reports full counts, real tie-break case included', () => {
    const events = [
      event({ event_type: 'climb_pos', event_value: 'L2' }),
      event({ event_type: 'climb_pos', event_value: 'L2' }),
      event({ event_type: 'climb_pos', event_value: 'Failed' })
    ];
    const s = summarizeTeamEvents(events);
    expect(s.mostCommonClimb).toBe('L2');
    expect(s.climbCounts).toEqual({ L2: 2, Failed: 1 });
  });

  it('handles an empty or missing event list without throwing', () => {
    expect(summarizeTeamEvents([])).toEqual({
      matchesScouted: 0,
      avgDrivingRank: null,
      avgAccuracy: null,
      avgSpeed: null,
      mostCommonClimb: null,
      climbCounts: {}
    });
    expect(summarizeTeamEvents(null).matchesScouted).toBe(0);
    expect(summarizeTeamEvents(undefined).matchesScouted).toBe(0);
  });

  it('ignores malformed event rows (null/missing fields) rather than throwing', () => {
    const events = [null, undefined, {}, event({ event_type: 'rank_driving', event_value: '2' })];
    const s = summarizeTeamEvents(events);
    expect(s.avgDrivingRank).toBeCloseTo(2, 5);
  });
});

describe('fuelCountFromEvents', () => {
  it('counts taps', () => {
    const events = [
      event({ event_type: 'shuttle_fuel', event_value: '1' }),
      event({ event_type: 'shuttle_fuel', event_value: '1' }),
      event({ event_type: 'hub_fuel', event_value: '1' })
    ];
    expect(fuelCountFromEvents(events, 'shuttle')).toBe(2);
    expect(fuelCountFromEvents(events, 'hub')).toBe(1);
  });

  it('an override resets the baseline and drops prior taps from the count, without deleting them from the log', () => {
    const events = [
      event({ event_type: 'shuttle_fuel', event_value: '1' }),
      event({ event_type: 'shuttle_fuel', event_value: '1' }),
      event({ event_type: 'shuttle_fuel_override', event_value: '10' })
    ];
    expect(fuelCountFromEvents(events, 'shuttle')).toBe(10);
  });

  it('taps after an override add on top of the new baseline', () => {
    const events = [
      event({ event_type: 'shuttle_fuel_override', event_value: '10' }),
      event({ event_type: 'shuttle_fuel', event_value: '1' })
    ];
    expect(fuelCountFromEvents(events, 'shuttle')).toBe(11);
  });

  it('rejects a negative or non-numeric override rather than corrupting the count', () => {
    const events = [
      event({ event_type: 'shuttle_fuel', event_value: '1' }),
      event({ event_type: 'shuttle_fuel_override', event_value: 'garbage' })
    ];
    expect(fuelCountFromEvents(events, 'shuttle')).toBe(1);
  });

  it('returns 0 for an empty or missing event list', () => {
    expect(fuelCountFromEvents([], 'shuttle')).toBe(0);
    expect(fuelCountFromEvents(null, 'shuttle')).toBe(0);
  });
});

describe('deriveMatchTeamRow', () => {
  it('derives the latest value of each field, not the first', () => {
    const events = [
      event({ event_type: 'climb_pos', event_value: 'L1' }),
      event({ event_type: 'climb_pos', event_value: 'L2' }),
      event({ event_type: 'rank_driving', event_value: '2' }),
      event({ event_type: 'rank_driving', event_value: '3' })
    ];
    const row = deriveMatchTeamRow(events);
    expect(row.finalClimbPos).toBe('L2');
    expect(row.drivingRank).toBe(3);
  });

  it('defaults climb positions to N/A and leaves numeric fields null when never recorded', () => {
    const row = deriveMatchTeamRow([]);
    expect(row.autoClimbPos).toBe('N/A');
    expect(row.finalClimbPos).toBe('N/A');
    expect(row.drivingRank).toBeNull();
    expect(row.accuracy).toBeNull();
    expect(row.speed).toBeNull();
    expect(row.shuttleFuel).toBe(0);
    expect(row.hubFuel).toBe(0);
  });

  it('includes real fuel counts, honoring an override in the middle of the match', () => {
    const events = [
      event({ event_type: 'hub_fuel', event_value: '1' }),
      event({ event_type: 'hub_fuel', event_value: '1' }),
      event({ event_type: 'hub_fuel_override', event_value: '5' }),
      event({ event_type: 'hub_fuel', event_value: '1' })
    ];
    expect(deriveMatchTeamRow(events).hubFuel).toBe(6);
  });

  it('reads dead_auto as a real boolean, not the string "false"', () => {
    expect(deriveMatchTeamRow([event({ event_type: 'dead_auto', event_value: 'true' })]).deadAuto).toBe(true);
    expect(deriveMatchTeamRow([event({ event_type: 'dead_auto', event_value: 'false' })]).deadAuto).toBe(false);
    expect(deriveMatchTeamRow([]).deadAuto).toBe(false);
  });
});

describe('power rankings', () => {
  it('summarizes every structured match scouting field used by downstream views', () => {
    const summary = summarizeMatchScoutEntries([
      {
        match_key: '2026casf_qm1', auto_points_average: 40, balls_scored_average: 75,
        driver_skill: 4, intake_speed: 3, auto_moved: 'ran', auto_collision: true,
        intake_jammed: false, crash_or_break: false, robot_disabled: 'no',
        ratings: { 'Shot accuracy': 5, 'Cycle speed': 4, Reliability: 3 },
        teleop_roles: ['Scoring', 'Defense'], ball_sources: ['source']
      },
      {
        match_key: '2026casf_qm2', auto_points_band: '20-30', balls_scored_band: '25-50',
        driver_skill: 2, intake_speed: 1, auto_moved: 'did-not-run', auto_collision: false,
        intake_jammed: true, crash_or_break: false, robot_disabled: 'no',
        ratings: { 'Shot accuracy': 3, 'Cycle speed': 2, Reliability: 1 },
        teleop_roles: ['Scoring'], ball_sources: ['source', 'floor']
      }
    ]);

    expect(summary).toMatchObject({
      reportCount: 2,
      matchesScouted: 2,
      avgAutoPoints: 32.5,
      avgBallsScored: 56.25,
      avgDriverSkill: 3,
      avgIntakeSpeed: 2,
      autoRunRate: 0.5,
      collisionRate: 0.5,
      incidentRate: 0.5,
      roleCounts: { Scoring: 2, Defense: 1 },
      ballSourceCounts: { source: 2, floor: 1 }
    });
    expect(summary.ratingAverages).toMatchObject({ 'Shot accuracy': 4, 'Cycle speed': 3, Reliability: 2 });
  });

  it('uses match scouting evidence in rankings when event taps are absent', () => {
    const teams = [{ key: 'frc1' }, { key: 'frc2' }];
    const matchEntries = [
      { team_key: 'frc1', match_key: 'm1', balls_scored_average: 25, driver_skill: 2, ratings: { Reliability: 2 } },
      { team_key: 'frc2', match_key: 'm1', balls_scored_average: 100, driver_skill: 5, ratings: { Reliability: 5 } }
    ];

    const ranked = buildPowerRankings(teams, [], [], { matchEntries });

    expect(ranked.find((row) => row.key === 'frc2').powerRank).toBe(1);
    expect(ranked.find((row) => row.key === 'frc2').matchScoutSummary.reportCount).toBe(1);
    expect(ranked.find((row) => row.key === 'frc2').scoutPower).toBeGreaterThan(
      ranked.find((row) => row.key === 'frc1').scoutPower
    );
  });

  it('aggregates fuel and climb results by match', () => {
    const events = [
      event({ event_type: 'hub_fuel' }),
      event({ event_type: 'hub_fuel' }),
      event({ event_type: 'climb_pos', event_value: 'L2' }),
      event({ match_key: '2026casf_qm2', event_type: 'hub_fuel' }),
      event({ match_key: '2026casf_qm2', event_type: 'climb_pos', event_value: 'Failed' })
    ];
    const summary = summarizeTeamPerformance(events);
    expect(summary.avgFuel).toBe(1.5);
    expect(summary.avgClimbLevel).toBe(1);
    expect(summary.climbSuccessRate).toBe(0.5);
  });

  it('ranks combined local scouting metrics without treating missing data as zero', () => {
    const teams = [
      { key: 'frc1', epa: 10 },
      { key: 'frc2', epa: 20 },
      { key: 'frc3', epa: null }
    ];
    const events = [
      event({ team_key: 'frc1', event_type: 'rank_driving', event_value: '1' }),
      event({ team_key: 'frc2', event_type: 'rank_driving', event_value: '3' }),
      event({ team_key: 'frc3', event_type: 'rank_driving', event_value: '2' })
    ];
    const ranked = buildPowerRankings(teams, events);
    expect(ranked.find((row) => row.key === 'frc2').powerRank).toBe(1);
    expect(ranked.find((row) => row.key === 'frc3').scoutPower).toBeCloseTo(50, 5);
    expect(ranked.find((row) => row.key === 'frc3').scoutPower).not.toBe(0);
  });

  it('uses explicit note impact while keeping neutral notes review-only', () => {
    const notes = [
      { team_key: 'frc1', ranking_impact: -2 },
      { team_key: 'frc1', ranking_impact: 0 },
      { team_key: 'frc2', ranking_impact: 2 }
    ];
    const ranked = buildPowerRankings([{ key: 'frc1' }, { key: 'frc2' }], [], notes);

    expect(ranked.find((row) => row.key === 'frc2').powerRank).toBe(1);
    expect(ranked.find((row) => row.key === 'frc1').noteSummary.noteCount).toBe(2);
    expect(ranked.find((row) => row.key === 'frc1').noteSummary.scoredNoteCount).toBe(1);
    expect(summarizeScoutNotes([{ ranking_impact: 0 }]).impactScore).toBeNull();
  });

  it('blends note impact at 15 percent when performance data exists', () => {
    const teams = [{ key: 'frc1' }, { key: 'frc2' }];
    const events = [
      event({ team_key: 'frc1', event_type: 'rank_driving', event_value: '3' }),
      event({ team_key: 'frc2', event_type: 'rank_driving', event_value: '1' })
    ];
    const ranked = buildPowerRankings(teams, events, [
      { team_key: 'frc1', ranking_impact: -2 },
      { team_key: 'frc2', ranking_impact: 2 }
    ]);

    expect(ranked.find((row) => row.key === 'frc1').scoutPower).toBeCloseTo(52.156863, 5);
    expect(ranked.find((row) => row.key === 'frc2').scoutPower).toBeCloseTo(47.843137, 5);
  });

  it('feeds pit-reported reliability (not the broader pit capability blend) and TBA OPR into Scout Power at 7.5% each', () => {
    const teams = [{ key: 'frc1', team_number: 1 }, { key: 'frc2', team_number: 2 }];
    // frc1: strong climb, weak reliability. frc2: no climb, strong
    // reliability. The old 15%-weighted blended pitScore (climb-heavy)
    // ranks frc1's pit capability well above frc2's - if Scout Power were
    // still using that blend, frc1 would win despite its worse reliability.
    // The new formula uses reliability alone, so frc2 (also given the
    // higher OPR) must win instead.
    const pitEntries = [
      { team_key: 'frc1', climb_options: ['L3'], technical_details: { overall_reliability_rating: 1 } },
      { team_key: 'frc2', climb_options: ['No Climb'], technical_details: { overall_reliability_rating: 10 } }
    ];
    const oprByTeamNumber = new Map([[1, { opr: 10 }], [2, { opr: 50 }]]);
    const ranked = buildPowerRankings(teams, [], [], { pitEntries, oprByTeamNumber });
    const first = ranked.find((row) => row.key === 'frc1');
    const second = ranked.find((row) => row.key === 'frc2');
    expect(first.pitSummary.pitScore).toBeGreaterThan(second.pitSummary.pitScore); // old blend would favor frc1
    expect(second.scoutPower).toBeGreaterThan(first.scoutPower); // new formula correctly favors frc2 instead
    expect(first.scoutPower).toBeCloseTo((10 + 0) / 2, 5);
    expect(second.scoutPower).toBeCloseTo((100 + 100) / 2, 5);
  });

  it('uses pit capability and unresolved problems without scoring prose or archetype labels', () => {
    const teams = [{ key: 'frc1' }, { key: 'frc2' }];
    const pitEntries = [
      {
        team_key: 'frc1', robot_archetype: 'Shooter', additional_notes: 'Fast repair access',
        climb_options: ['No Climb'], technical_details: { overall_reliability_rating: 4 }
      },
      {
        team_key: 'frc2', robot_archetype: 'Hybrid', additional_notes: '',
        climb_options: ['L3'], technical_details: { overall_reliability_rating: 10 }
      }
    ];
    const problemReports = [{ team_key: 'frc1', severity: 'urgent', resolved: false }];
    const ranked = buildPowerRankings(teams, [], [], { pitEntries, problemReports });
    const first = ranked.find((row) => row.key === 'frc1');
    const second = ranked.find((row) => row.key === 'frc2');

    expect(second.powerRank).toBe(1);
    expect(first.pitSummary.openProblemCount).toBe(1);
    expect(first.pitSummary.robotArchetype).toBe('Shooter');
    expect(first.pitSummary.hasAdditionalNotes).toBe(true);
    expect(second.pitSummary.pitScore).toBeGreaterThan(first.pitSummary.pitScore);
  });

  it('does not let resolved pit problems reduce a team score', () => {
    const summary = summarizePitScouting(
      { climb_options: ['L2'] },
      [{ severity: 'urgent', resolved: true }],
      null
    );
    expect(summary.openProblemCount).toBe(0);
    expect(summary.problemPenalty).toBe(0);
    expect(summary.pitScore).toBe(summary.capabilityScore);
  });

  it('caps a self-reported reliability of 10 to 7 when the team has an open ACE flag', () => {
    const flagged = summarizePitScouting(
      { technical_details: { overall_reliability_rating: 10 } },
      [{ severity: 'urgent', resolved: false }]
    );
    expect(flagged.rawReliability).toBe(10);
    expect(flagged.reliabilityScore).toBe(70); // capped to 7, then scaled x10

    const unflagged = summarizePitScouting({ technical_details: { overall_reliability_rating: 10 } }, []);
    expect(unflagged.reliabilityScore).toBe(100); // no open flag - self-report stands
  });

  it('never raises reliability toward the cap - a lower self-report with an open flag is untouched', () => {
    const summary = summarizePitScouting(
      { technical_details: { overall_reliability_rating: 4 } },
      [{ severity: 'watch', resolved: false }]
    );
    expect(summary.reliabilityScore).toBe(40);
  });

  it('resolves the ACE flag before capping - a resolved-only problem list leaves reliability alone', () => {
    const summary = summarizePitScouting(
      { technical_details: { overall_reliability_rating: 10 } },
      [{ severity: 'urgent', resolved: true }]
    );
    expect(summary.reliabilityScore).toBe(100);
  });

  it('builds an event-relative star profile from match scouting and OPR, without inventing missing observations', () => {
    const teams = [{ key: 'frc1', team_number: 1 }, { key: 'frc2', team_number: 2 }];
    const matchEntries = [
      { team_key: 'frc1', match_key: 'm1', driver_skill: 1 },
      { team_key: 'frc2', match_key: 'm1', driver_skill: 3 }
    ];
    const oprByTeamNumber = new Map([[1, { opr: 20 }], [2, { opr: 40 }]]);
    const ranked = buildPowerRankings(teams, [], [], { matchEntries, oprByTeamNumber });
    const first = ranked.find((row) => row.key === 'frc1').starProfile;
    const second = ranked.find((row) => row.key === 'frc2').starProfile;
    expect(first.find((axis) => axis.key === 'driving').value).toBe(0);
    expect(second.find((axis) => axis.key === 'driving').value).toBe(100);
    expect(first.find((axis) => axis.key === 'opr').value).toBe(0);
    expect(second.find((axis) => axis.key === 'opr').value).toBe(100);
    // Nobody reported an auto estimate for either team - the axis reflects
    // that honestly rather than defaulting to a fake middle value.
    expect(first.find((axis) => axis.key === 'auto').value).toBeNull();
  });
});

describe('human pairwise consensus', () => {
  const teams = [
    { key: 'frc1', team_number: 1, scoutPower: 80, powerRank: 1 },
    { key: 'frc2', team_number: 2, scoutPower: 60, powerRank: 2 },
    { key: 'frc3', team_number: 3, scoutPower: 40, powerRank: 3 }
  ];

  it('summarizes the selected pair in selector order', () => {
    const summary = summarizePairwisePair([
      { team_a_key: 'frc1', team_b_key: 'frc2', winner_team_key: 'frc2' },
      { team_a_key: 'frc1', team_b_key: 'frc2', winner_team_key: 'frc1' },
      { team_a_key: 'frc1', team_b_key: 'frc3', winner_team_key: 'frc1' }
    ], 'frc2', 'frc1');
    expect(summary).toMatchObject({ voteCount: 2, firstWins: 1, secondWins: 1, leaderKey: null });
    expect(summary.firstShare).toBe(0.5);
  });

  it('derives all direct comparisons from a shared best-to-worst match ranking', () => {
    const votes = matchRankingsToPairwiseVotes([
      { match_key: '2026test_qm1', ranked_team_keys: ['frc4414', 'frc254', 'frc2910'] }
    ]);
    expect(votes).toEqual([
      expect.objectContaining({ team_a_key: 'frc4414', team_b_key: 'frc254', winner_team_key: 'frc4414' }),
      expect.objectContaining({ team_a_key: 'frc4414', team_b_key: 'frc2910', winner_team_key: 'frc4414' }),
      expect.objectContaining({ team_a_key: 'frc254', team_b_key: 'frc2910', winner_team_key: 'frc254' })
    ]);
  });

  it('uses indirect match evidence in the human consensus order', () => {
    const votes = matchRankingsToPairwiseVotes([
      { ranked_team_keys: ['frc2', 'frc3'] },
      { ranked_team_keys: ['frc1', 'frc2'] }
    ]);
    const consensus = applyPairwiseConsensus(teams, votes);
    expect(consensus.find((team) => team.key === 'frc1').humanRank).toBe(1);
    expect(consensus.find((team) => team.key === 'frc2').humanRank).toBe(2);
    expect(consensus.find((team) => team.key === 'frc3').humanRank).toBe(3);
  });

  it('creates a separate human rank without altering calculated Scout Power', () => {
    const consensus = applyPairwiseConsensus(teams, [
      { team_a_key: 'frc1', team_b_key: 'frc2', winner_team_key: 'frc2' },
      { team_a_key: 'frc2', team_b_key: 'frc3', winner_team_key: 'frc2' },
      { team_a_key: 'frc1', team_b_key: 'frc3', winner_team_key: 'frc3' }
    ]);
    const second = consensus.find((row) => row.key === 'frc2');
    expect(second.humanRank).toBe(1);
    expect(second.humanWinRate).toBe(1);
    expect(second.scoutPower).toBe(60);
    expect(second.powerRank).toBe(2);
  });

  it('flags a strong human/calculated disagreement for review', () => {
    const consensus = applyPairwiseConsensus(teams, [
      { team_a_key: 'frc1', team_b_key: 'frc2', winner_team_key: 'frc2' },
      { team_a_key: 'frc1', team_b_key: 'frc2', winner_team_key: 'frc2' },
      { team_a_key: 'frc1', team_b_key: 'frc2', winner_team_key: 'frc1' }
    ]);
    expect(consensus.find((row) => row.key === 'frc1').reviewFlag).toBe(true);
    expect(consensus.find((row) => row.key === 'frc2').consensusSummary.reviewCount).toBe(1);
    expect(consensus.find((row) => row.key === 'frc3').reviewFlag).toBe(false);
  });

  it('does not flag a single vote or a weak majority', () => {
    const consensus = applyPairwiseConsensus(teams, [
      { team_a_key: 'frc1', team_b_key: 'frc2', winner_team_key: 'frc2' },
      { team_a_key: 'frc1', team_b_key: 'frc3', winner_team_key: 'frc1' },
      { team_a_key: 'frc1', team_b_key: 'frc3', winner_team_key: 'frc3' }
    ]);
    expect(consensus.every((row) => !row.reviewFlag)).toBe(true);
  });
});
