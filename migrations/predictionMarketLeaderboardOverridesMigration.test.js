import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260920103000_prediction_market_leaderboard_overrides.sql', import.meta.url),
  'utf8'
);

describe('prediction-market leaderboard overrides migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('is rerunnable, private, and seeds Arin Rao with the requested record', async () => {
    db = new PGlite();
    await db.exec(`
      create role authenticated;
      create role anon;
      create role service_role;
      create table public.user_profiles (id uuid primary key, full_name text);
      insert into public.user_profiles values ('11111111-1111-4111-8111-111111111111', 'Arin Rao');
    `);
    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const seeded = await db.query(`
      select event_key, balance, losses
      from public.prediction_market_leaderboard_overrides
      where participant_id = '11111111-1111-4111-8111-111111111111'
    `);
    expect(seeded.rows).toEqual([{ event_key: '*', balance: '3000', losses: 5 }]);

    const privileges = await db.query(`
      select
        has_table_privilege('authenticated', 'public.prediction_market_leaderboard_overrides', 'SELECT') as authenticated_select,
        has_table_privilege('service_role', 'public.prediction_market_leaderboard_overrides', 'SELECT') as service_select
    `);
    expect(privileges.rows).toEqual([{ authenticated_select: false, service_select: true }]);
  });
});
