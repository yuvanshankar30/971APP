import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260920093000_prediction_market_system_votes.sql', import.meta.url),
  'utf8'
);

describe('private prediction-market system votes migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('is rerunnable, keeps one vote per match, and denies authenticated reads', async () => {
    db = new PGlite();
    await db.exec('create role authenticated; create role anon; create role service_role;');
    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const privileges = await db.query(`
      select
        has_table_privilege('authenticated', 'public.prediction_market_system_votes', 'SELECT') as authenticated_select,
        has_table_privilege('service_role', 'public.prediction_market_system_votes', 'SELECT') as service_select
    `);
    expect(privileges.rows).toEqual([{ authenticated_select: false, service_select: true }]);

    await db.exec(`insert into public.prediction_market_system_votes (event_key, match_key, side, stake) values ('2026cc','2026cc_qm1','red',100)`);
    await expect(db.exec(`insert into public.prediction_market_system_votes (event_key, match_key, side, stake) values ('2026cc','2026cc_qm1','blue',100)`)).rejects.toThrow();
  });
});
