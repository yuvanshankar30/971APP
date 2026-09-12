import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260912_match_scout_teleop_roles_repair.sql', import.meta.url),
  'utf8'
);

describe('match scout teleop roles repair migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('backfills existing rows, enforces the array contract, and is rerunnable', async () => {
    db = new PGlite();
    await db.exec(`
      create schema if not exists public;
      create table public.match_scout_entries (id bigint primary key);
      insert into public.match_scout_entries (id) values (1);
    `);

    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const column = await db.query(`
      select data_type, udt_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'match_scout_entries'
        and column_name = 'teleop_roles'
    `);
    const row = await db.query(`
      select teleop_roles
      from public.match_scout_entries
      where id = 1
    `);

    expect(column.rows).toEqual([
      {
        data_type: 'ARRAY',
        udt_name: '_text',
        is_nullable: 'NO',
        column_default: "'{}'::text[]"
      }
    ]);
    expect(row.rows).toEqual([{ teleop_roles: [] }]);
  });

  it('fails clearly when the base match scouting table is missing', async () => {
    db = new PGlite();

    await expect(db.exec(migrationSql)).rejects.toThrow(
      'public.match_scout_entries does not exist; run the base match scouting migrations first'
    );
  });

  it('explicitly reloads the PostgREST schema cache', () => {
    expect(migrationSql).toMatch(/NOTIFY\s+pgrst\s*,\s*'reload schema'/i);
  });
});
