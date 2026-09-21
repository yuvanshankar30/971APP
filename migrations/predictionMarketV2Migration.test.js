import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrations = [
  '20260921_pm_elo_ratings.sql',
  '20260921_pm_elo_history.sql',
  '20260921_pm_match_picks.sql',
  '20260921_pm_alliance_draft_picks.sql',
  '20260921_pm_friends.sql',
  '20260921_pm_reactions.sql'
].map((file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'));

describe('prediction market v2 migrations', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('creates every contract table idempotently and preserves its unique rows', async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key);
      create role authenticated;
      create role service_role;
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      create function public.approved_user() returns boolean language sql as $$ select true $$;
    `);
    for (const migration of migrations) await db.exec(migration);
    for (const migration of migrations) await db.exec(migration);

    const tables = await db.query(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'pm_%'
      order by table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'pm_alliance_draft_picks',
      'pm_elo_history',
      'pm_elo_ratings',
      'pm_friends',
      'pm_match_picks',
      'pm_reactions'
    ]);

    await db.exec(`
      insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
      insert into public.pm_match_picks (user_id, event_key, match_key, side)
        values ('00000000-0000-0000-0000-000000000001', '2026cc', '2026cc_qm1', 'red');
      insert into public.pm_elo_history (user_id, event_key, match_key, picked_side, model_probability, elo_delta, elo_after)
        values ('00000000-0000-0000-0000-000000000001', '2026cc', '2026cc_qm1', 'red', .75, 8, 1008);
      insert into public.pm_friends (user_id, friend_id, status)
        values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'pending');
    `);

    await expect(db.exec(`
      insert into public.pm_match_picks (user_id, event_key, match_key, side)
      values ('00000000-0000-0000-0000-000000000001', '2026cc', '2026cc_qm1', 'blue')
    `)).rejects.toThrow();
    await expect(db.exec(`
      insert into public.pm_elo_history (user_id, event_key, match_key, picked_side, model_probability, elo_delta, elo_after)
      values ('00000000-0000-0000-0000-000000000001', '2026cc', '2026cc_qm1', 'blue', .25, -8, 1000)
    `)).rejects.toThrow();
    await expect(db.exec(`
      insert into public.pm_friends (user_id, friend_id, status)
      values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'pending')
    `)).rejects.toThrow();
  });
});
