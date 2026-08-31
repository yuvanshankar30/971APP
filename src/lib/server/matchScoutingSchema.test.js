import { describe, expect, it } from 'vitest';
import {
  RATING_FIELDS,
  normalizeAutoPathFile,
  normalizeAutoPath,
  normalizeMatchScoutEntry,
  normalizePitProblemReport,
  normalizeRatings,
  normalizeTeamKey,
  requiresPitProblemReport,
  validatePitProblemHandoff
} from './matchScoutingSchema.js';

describe('normalizeTeamKey', () => {
  it('accepts the forms a scout or a query string actually supplies', () => {
    expect(normalizeTeamKey('971')).toBe('frc971');
    expect(normalizeTeamKey('frc971')).toBe('frc971');
    expect(normalizeTeamKey('  FRC971 ')).toBe('frc971');
  });

  it('rejects anything that is not a team number', () => {
    for (const bad of ['', null, undefined, 'frc', 'abc', 'frc97a', '123456', '-1']) {
      expect(normalizeTeamKey(bad)).toBeNull();
    }
  });
});

describe('normalizeAutoPath', () => {
  it('clamps points to the 0-100 diagram percentages', () => {
    expect(normalizeAutoPath([[-5, 120], [50, 50]])).toEqual([[0, 100], [50, 50]]);
  });

  it('drops malformed points instead of storing NaN', () => {
    expect(normalizeAutoPath([[1, 2], ['a', 3], [4], null, [5, 6]])).toEqual([[1, 2], [5, 6]]);
    expect(normalizeAutoPath('nope')).toEqual([]);
  });

  it('caps a long freehand path while keeping both endpoints', () => {
    // A pointermove-per-sample path over 15s is thousands of points; the
    // drawing is only read back as a shape.
    const long = Array.from({ length: 5000 }, (_, i) => [i % 100, (i * 7) % 100]);
    const result = normalizeAutoPath(long);
    expect(result.length).toBe(400);
    expect(result[0]).toEqual(long[0]);
    expect(result[result.length - 1]).toEqual(long[long.length - 1]);
  });

  it('leaves a short path untouched', () => {
    const short = [[1, 1], [2, 2], [3, 3]];
    expect(normalizeAutoPath(short)).toEqual(short);
  });
});

describe('normalizeRatings', () => {
  it('keeps only known fields, clamped to 1-5', () => {
    const ratings = normalizeRatings({
      'Shot accuracy': 3, Defense: 9, 'Not a field': 5, Reliability: -2
    });
    expect(ratings).toEqual({ 'Shot accuracy': 3, Defense: 5 });
  });

  it('treats 0 as unrated rather than a score of zero', () => {
    expect(normalizeRatings(Object.fromEntries(RATING_FIELDS.map((f) => [f, 0])))).toEqual({});
  });

  it('tolerates junk', () => {
    expect(normalizeRatings(null)).toEqual({});
    expect(normalizeRatings([1, 2])).toEqual({});
    expect(normalizeRatings({ Defense: 'good' })).toEqual({});
  });
});

describe('normalizeMatchScoutEntry', () => {
  const base = { event_key: '2026casj', match_key: 'qm12', team_key: '971' };

  it('requires the identifying keys', () => {
    expect(normalizeMatchScoutEntry({ ...base, event_key: '' }).error).toMatch(/event_key/);
    expect(normalizeMatchScoutEntry({ ...base, match_key: '' }).error).toMatch(/match_key/);
    expect(normalizeMatchScoutEntry({ ...base, team_key: 'nope' }).error).toMatch(/team_key/);
  });

  it('normalizes a full submission and stamps the author', () => {
    const { value } = normalizeMatchScoutEntry({
      ...base,
      alliance: 'blue',
      starting_position: 'center',
      auto_start_zone: 'wing',
      auto_points_estimate: '80-100',
      ball_sources: ['wing', 'wing', 'floor'],
      auto_collision: true,
      auto_collision_notes: 'Bumped 254 near center',
      auto_path_name: 'Center four-piece',
      auto_path: [[10, 10], [20, 20]],
      ratings: { Defense: 4 },
      teleop_roles: ['Scoring', 'Defense', 'Defense', 'made-up role'],
      intake_speed: 2,
      intake_jammed: true,
      crash_or_break: true,
      card: 'yellow',
      driver_skill: 4
    }, 'user-1');
    expect(value.team_key).toBe('frc971');
    expect(value.alliance).toBe('blue');
    expect(value.ball_sources).toEqual(['wing', 'floor']); // deduped
    expect(value.auto_points_band).toBe('80-100');
    expect(value.auto_points_min).toBe(80);
    expect(value.auto_points_max).toBe(100);
    expect(value.auto_points_average).toBe(90);
    expect(value.auto_collision).toBe(true);
    expect(value.auto_collision_notes).toBe('Bumped 254 near center');
    expect(value.auto_path_name).toBe('Center four-piece');
    expect(value.teleop_roles).toEqual(['Scoring', 'Defense']);
    expect(value.intake_speed).toBe(2);
    expect(value.intake_jammed).toBe(true);
    expect(value.crash_or_break).toBe(true);
    expect(value.created_by).toBe('user-1');
  });

  it('drops values outside the known vocabularies rather than storing them', () => {
    // A renamed UI option should surface as missing data, not silently widen
    // the schema with a value nothing else understands.
    const { value } = normalizeMatchScoutEntry({
      ...base,
      alliance: 'green',
      starting_position: 'somewhere else',
      card: 'blue',
      ball_sources: ['wing', 'unknown-source']
    });
    expect(value.alliance).toBeNull();
    expect(value.starting_position).toBeNull();
    expect(value.card).toBeNull();
    expect(value.ball_sources).toEqual(['wing']);
  });

  it('rejects malformed point estimates rather than saving ambiguous text', () => {
    expect(normalizeMatchScoutEntry({ ...base, auto_points_estimate: 'a bunch' }).error).toMatch(/Auto points/);
    expect(normalizeMatchScoutEntry({ ...base, auto_points_estimate: '100-50' }).error).toMatch(/Auto points/);
  });

  it('keeps older point-band clients compatible while deriving an average', () => {
    const { value } = normalizeMatchScoutEntry({ ...base, auto_points_band: '6-10' });
    expect(value.auto_points_band).toBe('6-10');
    expect(value.auto_points_average).toBe(8);
  });

  it('clamps driver skill and treats junk as unrated', () => {
    expect(normalizeMatchScoutEntry({ ...base, driver_skill: 99 }).value.driver_skill).toBe(5);
    expect(normalizeMatchScoutEntry({ ...base, driver_skill: -3 }).value.driver_skill).toBe(0);
    expect(normalizeMatchScoutEntry({ ...base, driver_skill: 'great' }).value.driver_skill).toBeNull();
  });

  it('only accepts a literal true for crash_or_break', () => {
    expect(normalizeMatchScoutEntry({ ...base, crash_or_break: 'yes' }).value.crash_or_break).toBe(false);
    expect(normalizeMatchScoutEntry(base).value.crash_or_break).toBe(false);
  });

  it('clamps intake speed to the 1-3 scouting scale and defaults booleans safely', () => {
    expect(normalizeMatchScoutEntry({ ...base, intake_speed: 9 }).value.intake_speed).toBe(3);
    expect(normalizeMatchScoutEntry({ ...base, intake_speed: 0 }).value.intake_speed).toBe(1);
    expect(normalizeMatchScoutEntry({ ...base, intake_speed: 'fast' }).value.intake_speed).toBeNull();
    expect(normalizeMatchScoutEntry({ ...base, auto_collision: 'yes', intake_jammed: 'yes' }).value)
      .toMatchObject({ auto_collision: false, intake_jammed: false });
  });

  it('caps long free text instead of rejecting the whole report', () => {
    const { value } = normalizeMatchScoutEntry({ ...base, post_notes: 'x'.repeat(10_000) });
    expect(value.post_notes.length).toBe(4000);
    expect(normalizeMatchScoutEntry({ ...base, auto_path_name: 'x'.repeat(300) }).value.auto_path_name.length).toBe(120);
  });
});

describe('normalizeAutoPathFile', () => {
  const base = { event_key: '2026casj', team_key: '971', name: 'Center four-piece', path: [[1, 2], [3, 4]] };

  it('normalizes a reusable path independently of a match report', () => {
    expect(normalizeAutoPathFile({ ...base, alliance: 'blue' }, 'user-1').value).toMatchObject({
      event_key: '2026casj', team_key: 'frc971', name: 'Center four-piece',
      alliance: 'blue', path: [[1, 2], [3, 4]], created_by: 'user-1'
    });
  });

  it('requires a name and an actual drawn path', () => {
    expect(normalizeAutoPathFile({ ...base, name: '' }).error).toMatch(/name/);
    expect(normalizeAutoPathFile({ ...base, path: [[1, 2]] }).error).toMatch(/Draw a path/);
  });
});

describe('pit problem handoff requirement', () => {
  it('requires a description when a robot is disabled or dies', () => {
    expect(requiresPitProblemReport('disabled')).toBe(true);
    expect(requiresPitProblemReport('died')).toBe(true);
    expect(validatePitProblemHandoff({ robot_disabled: 'disabled', pit_problem_summary: '' })).toMatch(/Describe/);
  });

  it('keeps notes and voluntary handoffs optional for an active robot', () => {
    expect(requiresPitProblemReport('no')).toBe(false);
    expect(validatePitProblemHandoff({ robot_disabled: 'no' })).toBeNull();
    expect(validatePitProblemHandoff({ robot_disabled: 'no', report_pit_problem: true })).toMatch(/Describe/);
  });
});

describe('normalizePitProblemReport', () => {
  const base = { event_key: '2026casj', team_key: '971' };

  it('requires an event and a real team', () => {
    expect(normalizePitProblemReport({ ...base, event_key: '' }).error).toMatch(/event_key/);
    expect(normalizePitProblemReport({ ...base, team_key: '' }).error).toMatch(/team_key/);
  });

  it('falls back to a usable summary rather than storing an empty report', () => {
    expect(normalizePitProblemReport(base).value.summary).toBe('Mechanical issue flagged after match');
  });

  it('derives urgency from what was observed, overriding the client', () => {
    // A robot that died is urgent whatever the form submitted.
    for (const state of ['died', 'disabled']) {
      const { value } = normalizePitProblemReport({ ...base, robot_disabled: state, severity: 'watch' });
      expect(value.severity).toBe('urgent');
    }
  });

  it('honours a valid requested severity when nothing worse was observed', () => {
    expect(normalizePitProblemReport({ ...base, severity: 'urgent' }).value.severity).toBe('urgent');
    expect(normalizePitProblemReport({ ...base, severity: 'watch' }).value.severity).toBe('watch');
    expect(normalizePitProblemReport({ ...base, severity: 'catastrophic' }).value.severity).toBe('watch');
  });

  it('always creates the report unresolved and attributed', () => {
    const { value } = normalizePitProblemReport({ ...base, resolved: true }, 'user-9');
    expect(value.resolved).toBe(false);
    expect(value.created_by).toBe('user-9');
    expect(value.source).toBe('Match scout');
  });
});
