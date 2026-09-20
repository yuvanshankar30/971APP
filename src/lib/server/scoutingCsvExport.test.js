import { describe, expect, it } from 'vitest';
import { csvCell, scoutingDatasetsToCsv } from './scoutingCsvExport.js';

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
