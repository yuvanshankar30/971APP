import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260910_fusion_runner_tokens_setup_sessions.sql', import.meta.url),
  'utf8'
);

describe('fusion_runner_setup_sessions migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function freshDb() {
    const database = new PGlite();
    await database.exec(`
      create role service_role;
      create role anon;
      create role authenticated;
      create schema if not exists public;
      create table public.runner_tokens (
        id uuid primary key default gen_random_uuid(),
        token text not null unique,
        name text,
        revoked_at timestamptz
      );
      create table public.cam_machines (
        id uuid primary key default gen_random_uuid(),
        name text not null unique,
        enabled boolean not null default true
      );
    `);
    return database;
  }

  it('is rerunnable and consumes completed credentials exactly once', async () => {
    db = await freshDb();
    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const machine = await db.query(`insert into public.cam_machines (name) values ('router-host') returning id`);
    const token = await db.query(`insert into public.runner_tokens (token, name) values ('frt_machine', 'router-host') returning id`);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    await db.query(`
      insert into public.fusion_runner_setup_sessions
        (id, poll_secret, runner_name, runner_token_id, machine_id, completed_at)
      values ($1, 'poll-secret', 'router-host', $2, $3, now())
    `, [sessionId, token.rows[0].id, machine.rows[0].id]);

    const first = await db.query(
      `select * from public.consume_fusion_runner_setup_session($1, 'poll-secret')`,
      [sessionId]
    );
    const second = await db.query(
      `select * from public.consume_fusion_runner_setup_session($1, 'poll-secret')`,
      [sessionId]
    );
    expect(first.rows).toEqual([{ runner_name: 'router-host', machine_id: machine.rows[0].id, token: 'frt_machine' }]);
    expect(second.rows).toEqual([]);
  });

  it('does not consume with the wrong installer secret', async () => {
    db = await freshDb();
    await db.exec(migrationSql);
    const result = await db.query(
      `select * from public.consume_fusion_runner_setup_session('11111111-1111-4111-8111-111111111111', 'wrong')`
    );
    expect(result.rows).toEqual([]);
  });

  it('atomically creates the disabled machine, token, and completed session', async () => {
    db = await freshDb();
    await db.exec(migrationSql);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    await db.query(`
      insert into public.fusion_runner_setup_sessions (id, poll_secret, runner_name)
      values ($1, 'poll-secret', 'router-host')
    `, [sessionId]);

    const authorized = await db.query(
      `select * from public.authorize_fusion_runner_setup_session($1, 'frt_machine')`,
      [sessionId]
    );
    expect(authorized.rows).toHaveLength(1);
    const machine = await db.query(`select name, enabled from public.cam_machines`);
    expect(machine.rows).toEqual([{ name: 'router-host', enabled: false }]);
    const consumed = await db.query(
      `select * from public.consume_fusion_runner_setup_session($1, 'poll-secret')`,
      [sessionId]
    );
    expect(consumed.rows[0]).toMatchObject({ runner_name: 'router-host', token: 'frt_machine' });
  });
});
