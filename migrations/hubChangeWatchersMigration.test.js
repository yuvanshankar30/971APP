import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./20260928070000_hub_change_watchers.sql', import.meta.url), 'utf8');

describe('Hub change watchers migration', () => {
  let db;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role; create table public.user_profiles (id uuid primary key);');
  });
  afterEach(async () => db.close());

  it('is rerunnable and stores one watch per user', async () => {
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("insert into public.user_profiles (id) values ('00000000-0000-0000-0000-000000000001');");
    await db.exec("insert into public.hub_change_watchers (user_id) values ('00000000-0000-0000-0000-000000000001');");
    const result = await db.query('select count(*)::int as count from public.hub_change_watchers');
    expect(result.rows[0].count).toBe(1);
  });
});
