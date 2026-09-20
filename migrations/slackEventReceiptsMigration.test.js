import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./20260919230000_slack_app_mention_receipts.sql', import.meta.url),
  'utf8'
);

describe('Slack event receipts migration', () => {
  let db;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
    `);
  });

  afterEach(async () => db.close());

  it('is rerunnable and enforces one receipt per Slack event', async () => {
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(`
      insert into public.slack_event_receipts (event_id, event_type)
      values ('Ev-one', 'app_mention');
    `);
    await expect(db.exec(`
      insert into public.slack_event_receipts (event_id, event_type)
      values ('Ev-one', 'app_mention');
    `)).rejects.toThrow(/unique|duplicate/i);
  });

  it('rejects invalid processing states and enables row-level security', async () => {
    await db.exec(migration);
    await expect(db.exec(`
      insert into public.slack_event_receipts (event_id, event_type, status)
      values ('Ev-bad', 'app_mention', 'mystery');
    `)).rejects.toThrow(/check constraint/i);

    const result = await db.query(`
      select relrowsecurity
      from pg_class
      where oid = 'public.slack_event_receipts'::regclass
    `);
    expect(result.rows[0].relrowsecurity).toBe(true);
  });
});
