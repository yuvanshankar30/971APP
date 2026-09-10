import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260910_fusion_runner_tokens.sql', import.meta.url),
  'utf8'
);

describe('runner_tokens migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function freshDb() {
    const database = new PGlite();
    await database.exec(`
      create role service_role;
      create schema if not exists public;
    `);
    return database;
  }

  it('creates the table and stays safe to rerun', async () => {
    db = await freshDb();

    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const columns = await db.query(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'runner_tokens'
      order by ordinal_position
    `);
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      'id', 'token', 'name', 'created_at', 'revoked_at'
    ]);
  });

  it('rejects a duplicate token', async () => {
    db = await freshDb();
    await db.exec(migrationSql);

    await db.query(`insert into public.runner_tokens (token) values ('frt_a')`);

    await expect(
      db.query(`insert into public.runner_tokens (token) values ('frt_a')`)
    ).rejects.toThrow();
  });
});
