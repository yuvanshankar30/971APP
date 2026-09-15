import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260914_match_scout_beached.sql', import.meta.url),
  'utf8'
);

describe('match scout beached migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('adds a false-by-default beached observation without disturbing existing reports', async () => {
    db = new PGlite();
    await db.exec(`
      create schema if not exists public;
      create table public.match_scout_entries (id bigint primary key);
      insert into public.match_scout_entries (id) values (1);
    `);

    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const column = await db.query(`
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'match_scout_entries'
        and column_name = 'beached'
    `);
    const row = await db.query('select beached from public.match_scout_entries where id = 1');

    expect(column.rows).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);
    expect(row.rows).toEqual([{ beached: false }]);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migrationSql).toMatch(/NOTIFY\s+pgrst\s*,\s*'reload schema'/i);
  });
});
