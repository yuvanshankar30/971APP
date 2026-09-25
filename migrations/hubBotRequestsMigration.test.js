import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./20260925_hub_bot_requests.sql', import.meta.url),
  'utf8'
);

describe('Hub bot requests log migration', () => {
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

  it('is rerunnable and accepts a real request log row', async () => {
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(`
      insert into public.hub_bot_requests
        (slack_user_id, channel_id, thread_ts, event_ts, request_type, question, outcome, duration_ms, response_ts)
      values
        ('U123', 'C456', '1700000000.000100', '1700000000.000100', 'edit', '/edit rename the app', 'ok', 4200, '1700000000.000200');
    `);
    const result = await db.query('select request_type, outcome from public.hub_bot_requests');
    expect(result.rows).toEqual([{ request_type: 'edit', outcome: 'ok' }]);
  });

  it('rejects an invalid outcome value and enables row-level security', async () => {
    await db.exec(migration);
    await expect(db.exec(`
      insert into public.hub_bot_requests (request_type, outcome)
      values ('edit', 'mystery');
    `)).rejects.toThrow(/check constraint/i);

    const result = await db.query(`
      select relrowsecurity
      from pg_class
      where oid = 'public.hub_bot_requests'::regclass
    `);
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  it('allows logging an error outcome with its message', async () => {
    await db.exec(migration);
    await db.exec(`
      insert into public.hub_bot_requests (request_type, outcome, error_message)
      values ('edit', 'error', 'Gemini did not finish drafting this change within the tool-call round limit');
    `);
    const result = await db.query('select error_message from public.hub_bot_requests');
    expect(result.rows[0].error_message).toMatch(/tool-call round limit/);
  });
});
