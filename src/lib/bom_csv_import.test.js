import { describe, it, expect } from 'vitest';
import { parseCsv, matchCsvColumn, parseBomCsvRows } from './bom_csv_import.js';

describe('parseCsv', () => {
  it('splits a simple comma-separated table into rows of cells', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ]);
  });

  it('keeps commas inside quoted fields intact', () => {
    expect(parseCsv('Name,Description\nBracket,"Left, right, and center"')).toEqual([
      ['Name', 'Description'],
      ['Bracket', 'Left, right, and center']
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsv('Name\n"6"" x 6"" plate"')).toEqual([
      ['Name'],
      ['6" x 6" plate']
    ]);
  });

  it('handles both \\n and \\r\\n line endings', () => {
    expect(parseCsv('a,b\r\n1,2\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4']
    ]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });
});

describe('matchCsvColumn', () => {
  it('matches a header case-insensitively against known aliases', () => {
    expect(matchCsvColumn(['Name', 'Qty'], ['name', 'item name'])).toBe(0);
    expect(matchCsvColumn(['Name', 'Qty'], ['qty', 'quantity'])).toBe(1);
  });

  it('returns -1 when no alias matches', () => {
    expect(matchCsvColumn(['Foo', 'Bar'], ['name'])).toBe(-1);
  });
});

describe('parseBomCsvRows', () => {
  it('parses a well-formed OnShape-style BOM export into row objects', () => {
    const csv = [
      'Name,Part Number,QTY,Material,Vendor,Description',
      'Gearbox Plate,P001,2,6061 Aluminum,,Side plate',
      '18t HTD Pulley,P002,4,,WCP,'
    ].join('\n');

    expect(parseBomCsvRows(csv)).toEqual([
      { part_name: 'Gearbox Plate', part_number: 'P001', quantity: 2, material: '6061 Aluminum', vendor: '', description: 'Side plate' },
      { part_name: '18t HTD Pulley', part_number: 'P002', quantity: 4, material: '', vendor: 'WCP', description: '' }
    ]);
  });

  it('accepts alternate common header wording', () => {
    const csv = 'Item Name,Part No,Quantity\nStandoff,P010,8';
    expect(parseBomCsvRows(csv)).toEqual([
      { part_name: 'Standoff', part_number: 'P010', quantity: 8, material: '', vendor: '', description: '' }
    ]);
  });

  it('defaults quantity to 1 when the column is missing or unparseable', () => {
    const csv = 'Name\nBracket';
    expect(parseBomCsvRows(csv)[0].quantity).toBe(1);
  });

  it('drops rows with no name', () => {
    const csv = 'Name,QTY\nBracket,2\n,5';
    expect(parseBomCsvRows(csv)).toHaveLength(1);
  });

  it('throws when the header has no recognizable name column', () => {
    expect(() => parseBomCsvRows('Foo,Bar\n1,2')).toThrow(/name column/);
  });

  it('throws when there are no data rows at all', () => {
    expect(() => parseBomCsvRows('Name,QTY')).toThrow(/no data rows/);
  });

  it('throws when every data row is missing a name', () => {
    expect(() => parseBomCsvRows('Name,QTY\n,5\n,3')).toThrow(/No usable rows/);
  });
});
