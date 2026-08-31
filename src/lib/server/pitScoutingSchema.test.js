import { describe, it, expect } from 'vitest';
import {
  PIT_SCOUT_OPTIONAL_COLUMNS,
  buildPitScoutSchema,
  buildPitScoutSelectColumns,
  missingPitScoutOptionalColumn,
  normalizePitScoutRow,
  normalizePitScoutRows,
  pitScoutSchemaWarning,
  selectPitScoutEntries,
  upsertPitScoutEntry
} from './pitScoutingSchema.js';

describe('buildPitScoutSchema', () => {
  it('marks every optional column supported by default', () => {
    const schema = buildPitScoutSchema();
    for (const col of PIT_SCOUT_OPTIONAL_COLUMNS) {
      expect(schema[col]).toBe(true);
    }
  });

  it('marks only the given columns as supported', () => {
    const schema = buildPitScoutSchema(['estimated_bps']);
    expect(schema.estimated_bps).toBe(true);
    expect(schema.climb_options).toBe(false);
  });
});

describe('buildPitScoutSelectColumns', () => {
  it('includes the base columns plus every supported optional column', () => {
    const cols = buildPitScoutSelectColumns(['estimated_bps']);
    expect(cols).toContain('team_key');
    expect(cols).toContain('estimated_bps');
    expect(cols).not.toContain('climb_options');
  });
});

describe('missingPitScoutOptionalColumn', () => {
  it('identifies the missing column from a Postgres "column does not exist" error', () => {
    const error = { message: 'column "estimated_bps" does not exist' };
    expect(missingPitScoutOptionalColumn(error)).toBe('estimated_bps');
  });

  it('identifies the missing column from a PostgREST schema cache error', () => {
    const error = { message: "Could not find the 'climb_options' column of 'pit_scout_entries' in the schema cache" };
    expect(missingPitScoutOptionalColumn(error)).toBe('climb_options');
  });

  it('returns null for an unrelated error', () => {
    const error = { message: 'permission denied for table pit_scout_entries' };
    expect(missingPitScoutOptionalColumn(error)).toBeNull();
  });

  it('returns null for no error', () => {
    expect(missingPitScoutOptionalColumn(null)).toBeNull();
    expect(missingPitScoutOptionalColumn(undefined)).toBeNull();
  });

  it('only matches columns actually in the supported list', () => {
    const error = { message: 'column "some_other_column" does not exist' };
    expect(missingPitScoutOptionalColumn(error, ['estimated_bps'])).toBeNull();
  });
});

describe('normalizePitScoutRow', () => {
  it('fills in defaults for optional columns missing from the row', () => {
    const row = { id: '1', team_key: 'frc971' };
    const normalized = normalizePitScoutRow(row);
    expect(normalized.climb_options).toEqual([]);
    expect(normalized.technical_details).toEqual({});
    expect(normalized.estimated_bps).toBeNull();
    expect(normalized.robot_archetype).toBeNull();
    expect(normalized.additional_notes).toBeNull();
    expect(normalized.scout_name).toBeNull();
  });

  it('preserves a real value already present on the row', () => {
    const row = { id: '1', estimated_bps: 42 };
    expect(normalizePitScoutRow(row).estimated_bps).toBe(42);
  });

  it('forces the default when the column is not supported by the current schema, even if present on the row', () => {
    const row = { id: '1', estimated_bps: 42 };
    const schema = buildPitScoutSchema([]); // nothing supported
    expect(normalizePitScoutRow(row, schema).estimated_bps).toBeNull();
  });

  it('returns null/undefined unchanged for a null row', () => {
    expect(normalizePitScoutRow(null)).toBeNull();
  });

  it('does not share array/object default references across rows (no mutation leakage)', () => {
    const a = normalizePitScoutRow({ id: '1' });
    const b = normalizePitScoutRow({ id: '2' });
    a.climb_options.push('x');
    a.technical_details.drive = 'swerve';
    expect(b.climb_options).toEqual([]);
    expect(b.technical_details).toEqual({});
  });
});

describe('normalizePitScoutRows', () => {
  it('normalizes every row in an array', () => {
    const rows = normalizePitScoutRows([{ id: '1' }, { id: '2' }]);
    expect(rows).toHaveLength(2);
    expect(rows[0].climb_options).toEqual([]);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizePitScoutRows(null)).toEqual([]);
  });
});

describe('pitScoutSchemaWarning', () => {
  it('returns null when every optional column is supported', () => {
    expect(pitScoutSchemaWarning(buildPitScoutSchema())).toBeNull();
  });

  it('lists the missing fields by human-readable name', () => {
    const warning = pitScoutSchemaWarning(buildPitScoutSchema([]));
    expect(warning).toContain('likely breaking component');
    expect(warning).toContain('estimated BPS');
    expect(warning).toContain('robot archetype');
    expect(warning).toContain('additional notes');
    expect(warning).toContain('scout name');
  });
});

// Fake Supabase-like query builder: supports the chained .select()/.upsert()/.single()
// calls these helpers use, and can be told to fail once for a specific column.
function makeFakeDb({ failOnceForColumn } = {}) {
  let failedAlready = false;
  return {
    from(table) {
      return {
        select(columns) {
          if (failOnceForColumn && !failedAlready && columns.includes(failOnceForColumn)) {
            failedAlready = true;
            return Promise.resolve({ data: null, error: { message: `column "${failOnceForColumn}" does not exist` } });
          }
          return Promise.resolve({ data: [{ id: '1', team_key: 'frc971' }], error: null });
        },
        upsert(payload) {
          return {
            select(columns) {
              return {
                single() {
                  if (failOnceForColumn && !failedAlready && columns.includes(failOnceForColumn)) {
                    failedAlready = true;
                    return Promise.resolve({ data: null, error: { message: `column "${failOnceForColumn}" does not exist` } });
                  }
                  return Promise.resolve({ data: { id: '1', ...payload }, error: null });
                }
              };
            }
          };
        }
      };
    }
  };
}

describe('selectPitScoutEntries (graceful degradation on a missing optional column)', () => {
  it('succeeds directly when every optional column exists', async () => {
    const db = makeFakeDb();
    const result = await selectPitScoutEntries(db, (query) => query);
    expect(result.error).toBeNull();
    expect(result.warning).toBeNull();
  });

  it('retries without the offending column and still succeeds, with a warning', async () => {
    const db = makeFakeDb({ failOnceForColumn: 'estimated_bps' });
    const result = await selectPitScoutEntries(db, (query) => query);
    expect(result.error).toBeNull();
    expect(result.warning).toContain('estimated BPS');
  });

  it('gives up and returns the error when it is not a missing-column error', async () => {
    const db = {
      from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }) })
    };
    const result = await selectPitScoutEntries(db, (query) => query);
    expect(result.error).toEqual({ message: 'permission denied' });
  });
});

describe('upsertPitScoutEntry (graceful degradation on a missing optional column)', () => {
  it('retries without the offending column and strips it from the payload', async () => {
    const db = makeFakeDb({ failOnceForColumn: 'estimated_bps' });
    const result = await upsertPitScoutEntry(db, { team_key: 'frc971', estimated_bps: 42 });
    expect(result.error).toBeNull();
    expect(result.warning).toContain('estimated BPS');
  });
});
