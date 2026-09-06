import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260906_user_theme_preference.sql', import.meta.url),
  'utf8'
);

describe('user theme preference migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('adds a non-null modern theme preference and remains safe to rerun', async () => {
    db = new PGlite();
    await db.exec(`
      create schema if not exists public;
      create table public.user_profiles (id uuid primary key);
    `);

    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const result = await db.query(`
      select column_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_profiles'
        and column_name = 'theme_preference'
    `);

    expect(result.rows).toEqual([
      {
        column_name: 'theme_preference',
        is_nullable: 'NO',
        column_default: "'modern'::text"
      }
    ]);
  });

  it('explicitly reloads the PostgREST schema cache', () => {
    expect(migrationSql).toMatch(/NOTIFY\s+pgrst\s*,\s*'reload schema'/i);
  });
});
