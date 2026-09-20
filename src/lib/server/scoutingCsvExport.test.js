import { describe, expect, it } from 'vitest';
import { csvCell, matchScoutingRowsToCsv, pacificDayRangeUtc, scoutingDatasetsToCsv } from './scoutingCsvExport.js';

describe('scouting CSV export', () => {
  it('escapes quotes, commas, newlines, arrays, and objects', () => {
    const csv = scoutingDatasetsToCsv([
      { name: 'notes', rows: [{ event_key: '2026test', team_key: 'frc971', notes: 'Fast, but "fragile"\nCheck chain', tags: ['drive', 'pit'], detail: { urgent: true } }] }
    ]);
    expect(csv).toContain('"Fast, but ""fragile""\nCheck chain"');
    expect(csv).toContain('"[""drive"",""pit""]"');
    expect(csv).toContain('"{""urgent"":true}"');
  });

  it('neutralizes spreadsheet formulas from user-entered cells', () => {
    expect(csvCell('=HYPERLINK("https://bad.example")')).toBe('"\'=HYPERLINK(""https://bad.example"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
  });

  it('keeps datasets distinguishable in one CSV and handles an empty export', () => {
    const csv = scoutingDatasetsToCsv([
      { name: 'data_events', rows: [{ match_key: '2026test_qm1', team_key: 'frc971', event_type: 'climb' }] },
      { name: 'pit_entries', rows: [{ event_key: '2026test', team_key: 'frc254', drivebase_type: 'Swerve' }] }
    ]);
    expect(csv).toContain('"dataset","event_key","match_key","team_key"');
    expect(csv).toContain('"data_events"');
    expect(csv).toContain('"pit_entries"');
    expect(scoutingDatasetsToCsv([])).toBe('\uFEFF"dataset"\r\n');
  });
});

describe('matchScoutingRowsToCsv', () => {
  it('has no dataset column - unlike scoutingDatasetsToCsv, there is only one table here', () => {
    const csv = matchScoutingRowsToCsv([
      { event_key: '2026test', match_key: '2026test_qm1', team_key: 'frc971', crash_or_break: false }
    ]);
    expect(csv).toContain('"event_key","match_key","team_key"');
    expect(csv).not.toContain('dataset');
  });

  it('handles an empty day with no submissions', () => {
    expect(matchScoutingRowsToCsv([])).toBe('\uFEFF\r\n');
  });
});

describe('pacificDayRangeUtc', () => {
  it('spans exactly 24 hours', () => {
    const { start, end } = pacificDayRangeUtc('2026-09-19');
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('starts at Pacific midnight, expressed in UTC (PDT, UTC-7, in September)', () => {
    const { start } = pacificDayRangeUtc('2026-09-19');
    expect(start).toBe('2026-09-19T07:00:00.000Z');
  });

  it('accounts for the winter PST offset (UTC-8), not a hardcoded -7', () => {
    const { start } = pacificDayRangeUtc('2026-01-15');
    expect(start).toBe('2026-01-15T08:00:00.000Z');
  });

  it('rejects a malformed date instead of silently returning garbage', () => {
    expect(() => pacificDayRangeUtc('not-a-date')).toThrow(/YYYY-MM-DD/);
    expect(() => pacificDayRangeUtc('')).toThrow(/YYYY-MM-DD/);
  });
});
