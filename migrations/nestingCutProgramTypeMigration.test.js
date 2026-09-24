import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const baseMigration = readFileSync(
  new URL('./20260914000000_nesting_system.sql', import.meta.url),
  'utf8'
);
const oldSheetProgramTypeMigration = readFileSync(
  new URL('./20260914000001_nesting_program_type.sql', import.meta.url),
  'utf8'
);
const cutProgramTypeMigration = readFileSync(
  new URL('./20260923_nesting_cut_program_type.sql', import.meta.url),
  'utf8'
);

describe('nesting_cuts program_extension migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function freshDb() {
    const database = new PGlite();
    await database.exec(`
      create schema if not exists auth;
      create table auth.users (id uuid primary key);
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    await database.exec(baseMigration);
    await database.exec(oldSheetProgramTypeMigration);
    return database;
  }

  it('backfills each cut from its sheet, then drops the sheet-level column, and stays rerunnable', async () => {
    db = await freshDb();

    const { rows: [sheet] } = await db.query(`
      insert into nesting_sheets (name, width_in, height_in, program_extension)
      values ('Sheet A', 48, 30, 'tap')
      returning id;
    `);
    const { rows: [cutWithoutOwnType] } = await db.query(`
      insert into nesting_cuts (sheet_id, name) values ('${sheet.id}', 'Cut 1') returning id;
    `);

    await db.exec(cutProgramTypeMigration);
    await db.exec(cutProgramTypeMigration);

    const cutColumn = await db.query(`
      select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'nesting_cuts' and column_name = 'program_extension';
    `);
    expect(cutColumn.rows).toHaveLength(1);

    const sheetColumn = await db.query(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'nesting_sheets' and column_name = 'program_extension';
    `);
    expect(sheetColumn.rows).toHaveLength(0);

    const backfilled = await db.query(`select program_extension from nesting_cuts where id = '${cutWithoutOwnType.id}'`);
    expect(backfilled.rows[0].program_extension).toBe('tap');
  });

  it('leaves an already-set cut type alone instead of overwriting it with the sheet value', async () => {
    db = await freshDb();

    const { rows: [sheet] } = await db.query(`
      insert into nesting_sheets (name, width_in, height_in, program_extension)
      values ('Sheet B', 48, 30, 'ngc')
      returning id;
    `);
    const { rows: [cut] } = await db.query(`
      insert into nesting_cuts (sheet_id, name) values ('${sheet.id}', 'Cut 1') returning id;
    `);
    // Simulate the column already existing with its own value (e.g. a second
    // run after a partial backfill) - the migration must not clobber it.
    await db.exec(`alter table nesting_cuts add column if not exists program_extension text check (program_extension in ('ngc','tap'))`);
    await db.exec(`update nesting_cuts set program_extension = 'tap' where id = '${cut.id}'`);

    await db.exec(cutProgramTypeMigration);

    const result = await db.query(`select program_extension from nesting_cuts where id = '${cut.id}'`);
    expect(result.rows[0].program_extension).toBe('tap');
  });

  it('lets two cuts on the same sheet independently hold different program types', async () => {
    db = await freshDb();

    const { rows: [sheet] } = await db.query(`
      insert into nesting_sheets (name, width_in, height_in) values ('Sheet C', 48, 30) returning id;
    `);
    await db.exec(cutProgramTypeMigration);

    const { rows: [ngcCut] } = await db.query(`
      insert into nesting_cuts (sheet_id, name, program_extension) values ('${sheet.id}', 'Cut 1', 'ngc') returning id;
    `);
    const { rows: [tapCut] } = await db.query(`
      insert into nesting_cuts (sheet_id, name, program_extension) values ('${sheet.id}', 'Cut 2', 'tap') returning id;
    `);

    const result = await db.query(`select id, program_extension from nesting_cuts where sheet_id = '${sheet.id}' order by name`);
    expect(result.rows).toEqual([
      { id: ngcCut.id, program_extension: 'ngc' },
      { id: tapCut.id, program_extension: 'tap' }
    ]);
  });

  it('still rejects mixing .ngc and .tap on the very same cut', async () => {
    db = await freshDb();

    const { rows: [sheet] } = await db.query(`
      insert into nesting_sheets (name, width_in, height_in) values ('Sheet D', 48, 30) returning id;
    `);
    await db.exec(cutProgramTypeMigration);
    const { rows: [cut] } = await db.query(`
      insert into nesting_cuts (sheet_id, name, program_extension) values ('${sheet.id}', 'Cut 1', 'ngc') returning id;
    `);

    await expect(db.exec(`update nesting_cuts set program_extension = 'nope' where id = '${cut.id}'`)).rejects.toThrow();
  });
});
