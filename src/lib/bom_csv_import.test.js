import { describe, it, expect } from 'vitest';
import { parseCsv, matchCsvColumn, parseBomCsvRows, classifyManualBomRow, classifyManualBomRows, parseThicknessInches } from './bom_csv_import.js';

describe('parseThicknessInches', () => {
  it('parses a plain decimal', () => {
    expect(parseThicknessInches('0.0625')).toBeCloseTo(0.0625);
  });

  it('parses a simple fraction', () => {
    expect(parseThicknessInches('1/16')).toBeCloseTo(0.0625);
  });

  it('strips a trailing inch mark or unit word', () => {
    expect(parseThicknessInches('0.25"')).toBeCloseTo(0.25);
    expect(parseThicknessInches('0.25 in')).toBeCloseTo(0.25);
    expect(parseThicknessInches('1/4 inches')).toBeCloseTo(0.25);
  });

  it('returns null for blank, zero, or unparseable input', () => {
    expect(parseThicknessInches('')).toBeNull();
    expect(parseThicknessInches(null)).toBeNull();
    expect(parseThicknessInches('0')).toBeNull();
    expect(parseThicknessInches('thick')).toBeNull();
  });
});

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
      { part_name: 'Gearbox Plate', part_number: 'P001', quantity: 2, material: '6061 Aluminum', vendor: '', description: 'Side plate', thickness: null },
      { part_name: '18t HTD Pulley', part_number: 'P002', quantity: 4, material: '', vendor: 'WCP', description: '', thickness: null }
    ]);
  });

  it('accepts alternate common header wording', () => {
    const csv = 'Item Name,Part No,Quantity\nStandoff,P010,8';
    expect(parseBomCsvRows(csv)).toEqual([
      { part_name: 'Standoff', part_number: 'P010', quantity: 8, material: '', vendor: '', description: '', thickness: null }
    ]);
  });

  it('parses an optional thickness column into inches', () => {
    const csv = 'Name,Thickness\nGearbox Plate,1/16\nSide Panel,0.25"';
    const rows = parseBomCsvRows(csv);
    expect(rows[0].thickness).toBeCloseTo(0.0625);
    expect(rows[1].thickness).toBeCloseTo(0.25);
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

  it('drops OnShape placeholder bodies named SOLID/COMPOUND (with or without a numeric suffix)', () => {
    const csv = 'Name,QTY\nBracket,2\nSOLID,1\nSOLID_1,1\nCOMPOUND,1\nCOMPOUND_2,1';
    expect(parseBomCsvRows(csv)).toEqual([
      { part_name: 'Bracket', part_number: '', quantity: 2, material: '', vendor: '', description: '', thickness: null }
    ]);
  });

  it('throws when every data row is a SOLID/COMPOUND placeholder', () => {
    expect(() => parseBomCsvRows('Name,QTY\nSOLID,1\nCOMPOUND,1')).toThrow(/No usable rows/);
  });

  it('drops OnShape feature-name placeholder bodies (Chamfer1, Boss-Extrude1, ...)', () => {
    const csv = 'Name,QTY\nBracket,2\nChamfer1,1\nBoss-Extrude1,1\nFillet1,1';
    expect(parseBomCsvRows(csv)).toEqual([
      { part_name: 'Bracket', part_number: '', quantity: 2, material: '', vendor: '', description: '', thickness: null }
    ]);
  });
});

describe('classifyManualBomRow', () => {
  function row(overrides = {}) {
    return { part_name: '', part_number: '', quantity: 1, material: '', vendor: '', description: '', ...overrides };
  }

  it('classifies as COTS when a vendor is present', () => {
    expect(classifyManualBomRow(row({ part_name: '18t HTD Pulley', vendor: 'WCP' }))).toEqual({ part_type: 'COTS', workflow: 'purchase' });
  });

  it('classifies a screw or bolt as a COTS kit item (stocked, not purchased) even with no vendor', () => {
    expect(classifyManualBomRow(row({ part_name: '#10-32 socket head screw' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'M4 bolt' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('classifies a nut as a COTS kit item even with no vendor', () => {
    expect(classifyManualBomRow(row({ part_name: '10-32 nylock nut' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('classifies an SDS-branded part as a COTS kit item even with no vendor', () => {
    expect(classifyManualBomRow(row({ part_name: 'SDS MK5n Top Assembly (A)' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'SDS MK5 Turret Assembly' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'SDS MK5 Molded Wheel' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('classifies a socket head cap screw as a COTS kit item', () => {
    expect(classifyManualBomRow(row({ part_name: 'Socket Head Cap Screw 1/4-20' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('classifies a spring as a COTS kit item even with no vendor', () => {
    expect(classifyManualBomRow(row({ part_name: '9657K285_Compression Spring' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('classifies a PCB as a COTS kit item even with no vendor', () => {
    expect(classifyManualBomRow(row({ part_name: 'Custom PCB' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('classifies motors, gears, and electrical/control-system COTS as kit items', () => {
    expect(classifyManualBomRow(row({ part_name: 'Kraken X60 Brushless Motor' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: '20T Gear' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'roboRIO 2.0' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'Pigeon 2.0' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'CANivore' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: '120A Breaker' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'Battery' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
    expect(classifyManualBomRow(row({ part_name: 'PDP' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('does not let "gearbox" (a real manufactured plate part) match the gear keyword', () => {
    expect(classifyManualBomRow(row({ part_name: 'pivot gearbox plate' }))).toEqual({ part_type: 'manufactured', workflow: 'router' });
  });

  it('classifies chain as a COTS kit item', () => {
    expect(classifyManualBomRow(row({ part_name: '53 links #35 chain' }))).toEqual({ part_type: 'COTS', workflow: 'kit' });
  });

  it('classifies foam as manufactured/router', () => {
    expect(classifyManualBomRow(row({ part_name: 'Bumper Foam' }))).toEqual({ part_type: 'manufactured', workflow: 'router' });
    expect(classifyManualBomRow(row({ part_name: 'Pad', material: 'Pool Noodle Foam' }))).toEqual({ part_type: 'manufactured', workflow: 'router' });
  });

  it('classifies a plate with no vendor as manufactured/router', () => {
    expect(classifyManualBomRow(row({ part_name: 'pivot gearbox plate' }))).toEqual({ part_type: 'manufactured', workflow: 'router' });
  });

  it('classifies a spacer with no vendor as manufactured/3d-print', () => {
    expect(classifyManualBomRow(row({ part_name: 'maxspline spacer' }))).toEqual({ part_type: 'manufactured', workflow: '3d-print' });
  });

  it('classifies a shaft or standoff with no vendor as manufactured/lathe', () => {
    expect(classifyManualBomRow(row({ part_name: '2in hex shaft' }))).toEqual({ part_type: 'manufactured', workflow: 'lathe' });
    expect(classifyManualBomRow(row({ part_name: 'M3 standoff' }))).toEqual({ part_type: 'manufactured', workflow: 'lathe' });
  });

  it('classifies nylon/PLA/ABS material as manufactured/3d-print', () => {
    expect(classifyManualBomRow(row({ part_name: 'Chamfer1', material: 'Nylon' }))).toEqual({ part_type: 'manufactured', workflow: '3d-print' });
  });

  it('falls back to manufactured/mill for anything else with no vendor', () => {
    expect(classifyManualBomRow(row({ part_name: 'gearbox side bracket', material: 'Aluminum' }))).toEqual({ part_type: 'manufactured', workflow: 'mill' });
  });

  it('does not let a plate/spacer/shaft name override a real vendor tag', () => {
    // Direct instruction ordering: vendor presence is COTS regardless of
    // what the name would otherwise suggest.
    expect(classifyManualBomRow(row({ part_name: 'WCP spacer kit', vendor: 'WCP' }))).toEqual({ part_type: 'COTS', workflow: 'purchase' });
  });
});

describe('classifyManualBomRows', () => {
  it('merges classification fields onto each row without losing the original fields', () => {
    const rows = [
      { part_name: 'pivot plate', part_number: '-', quantity: 2, material: '', vendor: '', description: '' },
      { part_name: '18t HTD Pulley', part_number: 'P002', quantity: 4, material: '', vendor: 'WCP', description: '' }
    ];
    const result = classifyManualBomRows(rows);
    expect(result[0]).toEqual({ ...rows[0], part_type: 'manufactured', workflow: 'router' });
    expect(result[1]).toEqual({ ...rows[1], part_type: 'COTS', workflow: 'purchase' });
  });
});
