import { describe, expect, it } from 'vitest';
import { normalizeMatchScoutEntry, validatePitProblemHandoff } from './matchScoutingSchema.js';
import { scoutDisplayName } from '../scoutNames.js';

const report = {
  form_version: 2, event_key: '2026test', match_key: 'qm1', team_key: '971',
  starting_position: 'center', scout_name: 'Test Scout', preload: false,
  auto_cycles: 0, ball_sources: ['Neutral Zone', 'Preload'],
  teleop_roles: ['Scorer'], balls_scored_band: '137',
  ratings: { 'Shot accuracy': 4, BPS: 3 }, ratings_unknown: [],
  significant_crash: false, teleop_robot_status: 'active', mechanical_break: false
};

describe('match scouting v2', () => {
  it('preserves exact counts, new vocabularies, preload and zero cycles', () => {
    const result = normalizeMatchScoutEntry(report, 'actor');
    expect(result.error).toBeNull();
    expect(result.value).toMatchObject({ balls_scored_min: 137, balls_scored_max: 137,
      balls_scored_average: 137, preload: false, auto_cycles: 0, teleop_roles: ['Scorer'],
      ball_sources: ['Neutral Zone', 'Preload'], ratings: { 'Shot accuracy': 4, BPS: 3 } });
  });
  it('keeps Depot collection and the post-match beached observation', () => {
    const result = normalizeMatchScoutEntry({ ...report, ball_sources: ['Depot'], beached: true }, 'actor');
    expect(result.error).toBeNull();
    expect(result.value).toMatchObject({ ball_sources: ['Depot'], beached: true });
  });
  it('preserves restored ratings and intake observations when saving v2 reports', () => {
    const result = normalizeMatchScoutEntry({ ...report, ratings: { ...report.ratings, Defense: 4, 'Driver awareness': 2, 'Cycle speed': 3, Reliability: 5 }, intake_speed: 3, intake_jammed: true }, 'actor');
    expect(result.error).toBeNull();
    expect(result.value).toMatchObject({ ratings: { ...report.ratings, Defense: 4, 'Driver awareness': 2, 'Cycle speed': 3, Reliability: 5 }, intake_speed: 3, intake_jammed: true });
  });
  it('saves Stopped and continues to read historical status values', () => {
    for (const status of ['active', 'dead', 'stopped', 'brownout', 'unknown']) {
      const result = normalizeMatchScoutEntry({ ...report, teleop_robot_status: status }, 'actor');
      expect(result.error).toBeNull();
      expect(result.value.teleop_robot_status).toBe(status);
    }
  });
  it('accepts ranges and rejects malformed or fractional ball counts', () => {
    expect(normalizeMatchScoutEntry({ ...report, balls_scored_band: '100-150' }).value.balls_scored_average).toBe(125);
    for (const input of ['', 'lots', '150-100', '1.5']) {
      expect(normalizeMatchScoutEntry({ ...report, balls_scored_band: input }).error).toBeTruthy();
    }
  });
  it('requires explicit answers, not truthiness defaults', () => {
    for (const field of ['scout_name', 'preload', 'significant_crash', 'teleop_robot_status', 'mechanical_break']) {
      expect(normalizeMatchScoutEntry({ ...report, [field]: undefined }).error).toBeTruthy();
    }
    expect(normalizeMatchScoutEntry({ ...report, teleop_roles: [] }).error).toBeTruthy();
    expect(normalizeMatchScoutEntry({ ...report, teleop_roles: [], teleop_roles_none: true }).error).toBeNull();
  });
  it('records Unknown separately rather than turning it into a zero rating', () => {
    const result = normalizeMatchScoutEntry({ ...report, ratings: { BPS: 3 }, ratings_unknown: ['Shot accuracy'] });
    expect(result.error).toBeNull();
    expect(result.value.ratings).toEqual({ BPS: 3 });
    expect(result.value.ratings_unknown).toEqual(['Shot accuracy']);
    expect(normalizeMatchScoutEntry({ ...report, ratings: {} }).error).toBeTruthy();
  });
  it('requires a target for a crash and details for an other target', () => {
    expect(normalizeMatchScoutEntry({ ...report, significant_crash: true }).error).toBeTruthy();
    expect(normalizeMatchScoutEntry({ ...report, significant_crash: true, crash_target: 'other' }).error).toBeTruthy();
    expect(normalizeMatchScoutEntry({ ...report, significant_crash: true, crash_target: 'wall' }).error).toBeNull();
  });
  it('requires an ACE description for a mechanical break even when active', () => {
    expect(validatePitProblemHandoff({ ...report, mechanical_break: true })).toMatch(/ACE/);
    expect(validatePitProblemHandoff({ ...report, mechanical_break: true, pit_problem_summary: 'Axle broke' })).toBeNull();
    expect(validatePitProblemHandoff({ ...report, teleop_robot_status: 'dead' })).toMatch(/ACE/);
  });
  it('does not fabricate names from email addresses', () => {
    expect(scoutDisplayName({ full_name: 'Real Name', email: 'x@example.com' })).toBe('Real Name');
    expect(scoutDisplayName({ full_name: 'x@example.com', email: 'x@example.com' })).toBe('Name not set (x@example.com)');
  });
});
