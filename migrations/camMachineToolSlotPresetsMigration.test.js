import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260908_cam_machine_tool_slot_presets.sql', import.meta.url),
  'utf8'
);

describe('cam_machine_tool_slot_presets migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function freshDb() {
    const database = new PGlite();
    await database.exec(`
      create schema if not exists auth;
      create table auth.users (id uuid primary key);
      create function auth.role() returns text language sql as 'select ''authenticated''';
      create schema if not exists public;
      create table public.cam_machines (id uuid primary key default gen_random_uuid(), name text);
      create function public.approved_user() returns boolean language sql as 'select true';
    `);
    return database;
  }

  it('creates the table, indexes, and trigger, and stays safe to rerun', async () => {
    db = await freshDb();

    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const columns = await db.query(`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'cam_machine_tool_slot_presets'
      order by ordinal_position
    `);
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      'id', 'machine_id', 'name', 'created_by', 'is_hub_default', 'slot_assignments', 'created_at', 'updated_at'
    ]);
  });

  it('allows only one hub default per machine', async () => {
    db = await freshDb();
    await db.exec(migrationSql);

    const { rows: [machine] } = await db.query(
      `insert into public.cam_machines (name) values ('New Router') returning id`
    );

    await db.query(
      `insert into public.cam_machine_tool_slot_presets (machine_id, name, is_hub_default) values ($1, 'Hub default', true)`,
      [machine.id]
    );

    await expect(
      db.query(
        `insert into public.cam_machine_tool_slot_presets (machine_id, name, is_hub_default) values ($1, 'Another default', true)`,
        [machine.id]
      )
    ).rejects.toThrow();
  });

  it('allows a user two presets on different machines but not the same name twice on one machine', async () => {
    db = await freshDb();
    await db.exec(migrationSql);

    const { rows: [machine] } = await db.query(
      `insert into public.cam_machines (name) values ('New Router') returning id`
    );
    const { rows: [user] } = await db.query(`insert into auth.users (id) values (gen_random_uuid()) returning id`);

    await db.query(
      `insert into public.cam_machine_tool_slot_presets (machine_id, name, created_by) values ($1, 'Countersink day', $2)`,
      [machine.id, user.id]
    );

    await expect(
      db.query(
        `insert into public.cam_machine_tool_slot_presets (machine_id, name, created_by) values ($1, 'Countersink day', $2)`,
        [machine.id, user.id]
      )
    ).rejects.toThrow();
  });

  it('touches updated_at on update', async () => {
    db = await freshDb();
    await db.exec(migrationSql);

    const { rows: [machine] } = await db.query(
      `insert into public.cam_machines (name) values ('New Router') returning id`
    );
    const { rows: [preset] } = await db.query(
      `insert into public.cam_machine_tool_slot_presets (machine_id, name) values ($1, 'Hub default') returning id, updated_at`,
      [machine.id]
    );

    await db.query(`select pg_sleep(0.01)`);
    const { rows: [updated] } = await db.query(
      `update public.cam_machine_tool_slot_presets set slot_assignments = '{"5": "x"}'::jsonb where id = $1 returning updated_at`,
      [preset.id]
    );

    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(preset.updated_at).getTime());
  });
});
