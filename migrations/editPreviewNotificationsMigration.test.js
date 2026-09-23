import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./20260923_edit_preview_notifications.sql', import.meta.url), 'utf8').split('CREATE EXTENSION')[0];

describe('edit preview notifications migration', () => {
  let db;
  afterEach(async () => { await db?.close(); db = undefined; });

  it('creates the private pending-notification queue idempotently', async () => {
    db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("insert into public.edit_preview_notifications (pr_number, branch_name, slack_channel, slack_thread_ts) values (1, 'gemini-edit/test', 'C1', '1.0')");
    const result = await db.query('select pr_number, status from public.edit_preview_notifications');
    expect(result.rows).toEqual([{ pr_number: 1, status: 'pending' }]);
  });
});
