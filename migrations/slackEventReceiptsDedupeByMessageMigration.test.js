import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const baseMigration = readFileSync(
  new URL('./20260919230000_slack_app_mention_receipts.sql', import.meta.url),
  'utf8'
);
const dedupeMigration = readFileSync(
  new URL('./20260923_slack_event_receipts_dedupe_by_message.sql', import.meta.url),
  'utf8'
);

describe('Slack event receipts dedupe-by-message migration', () => {
  let db;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    await db.exec(baseMigration);
  });

  afterEach(async () => db.close());

  it('is rerunnable and rejects a second receipt for the same real message even with a different event_id', async () => {
    await db.exec(dedupeMigration);
    await db.exec(dedupeMigration);

    await db.exec(`
      insert into public.slack_event_receipts (event_id, event_type, channel_id, event_ts)
      values ('Ev-first', 'app_mention', 'C123', '1700000000.000100');
    `);
    // The real bug: same channel_id + event_ts (the actual Slack message),
    // but a brand new event_id - this is exactly what a redelivery with a
    // fresh event_id looks like, and used to sail through as "new."
    await expect(db.exec(`
      insert into public.slack_event_receipts (event_id, event_type, channel_id, event_ts)
      values ('Ev-second-redelivery', 'app_mention', 'C123', '1700000000.000100');
    `)).rejects.toThrow(/unique|duplicate/i);
  });

  it('still allows different real messages, and repeated receipts with no message identity attached', async () => {
    await db.exec(dedupeMigration);

    await db.exec(`
      insert into public.slack_event_receipts (event_id, event_type, channel_id, event_ts)
      values ('Ev-a', 'app_mention', 'C123', '1700000000.000100');
      insert into public.slack_event_receipts (event_id, event_type, channel_id, event_ts)
      values ('Ev-b', 'app_mention', 'C123', '1700000000.000200');
      insert into public.slack_event_receipts (event_id, event_type, channel_id, event_ts)
      values ('Ev-c', 'app_mention', 'C456', '1700000000.000100');
    `);
    // Two receipts with no channel_id/event_ts at all - the partial index
    // (WHERE both columns are set) must not block these.
    await db.exec(`
      insert into public.slack_event_receipts (event_id, event_type)
      values ('Ev-no-identity-1', 'app_mention');
      insert into public.slack_event_receipts (event_id, event_type)
      values ('Ev-no-identity-2', 'app_mention');
    `);
    const result = await db.query('select count(*)::int as n from public.slack_event_receipts');
    expect(result.rows[0].n).toBe(5);
  });

  it('cleans up pre-existing duplicates (the real production shape: many event_ids, one message) down to the earliest row', async () => {
    await db.exec(`
      insert into public.slack_event_receipts (event_id, event_type, channel_id, event_ts, received_at)
      values
        ('Ev-dup-1', 'app_mention', 'C123', '1700000000.000100', '2026-01-01T00:00:00Z'),
        ('Ev-dup-2', 'app_mention', 'C123', '1700000000.000100', '2026-01-01T00:00:10Z'),
        ('Ev-dup-3', 'app_mention', 'C123', '1700000000.000100', '2026-01-01T00:00:20Z');
    `);
    await db.exec(dedupeMigration);
    const result = await db.query('select event_id from public.slack_event_receipts');
    expect(result.rows).toEqual([{ event_id: 'Ev-dup-1' }]);
  });
});
