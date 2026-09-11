import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('./20260911_fusion_turning_parts.sql', import.meta.url),
  'utf8'
);

describe('fusion_turning_parts migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function freshDb() {
    const database = new PGlite();
    await database.exec(`
      do $$ begin
        create role authenticated;
      exception when duplicate_object then null; end $$;
      do $$ begin
        create role service_role;
      exception when duplicate_object then null; end $$;
      create schema if not exists auth;
      create table auth.users (id uuid primary key);
      create function auth.role() returns text language sql as 'select ''authenticated''';
      create schema if not exists public;
      create table public.cam_machines (id uuid primary key default gen_random_uuid(), name text);
      create function public.approved_user() returns boolean language sql as 'select true';
      create function public.can_manage_fusion_stock() returns boolean language sql as 'select true';
      create function public.update_cam_studio_updated_at() returns trigger language plpgsql as $fn$
        begin new.updated_at = now(); return new; end;
      $fn$;
    `);
    return database;
  }

  it('creates the table, columns, and trigger, and stays safe to rerun', async () => {
    db = await freshDb();

    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const columns = await db.query(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'fusion_turning_parts'
      order by ordinal_position
    `);
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      'id', 'name', 'ticket', 'epic', 'quantity', 'cam_type', 'tailstock_length_in',
      'step_file_name', 'created_by', 'created_at', 'updated_at', 'part_id', 'project_id', 'stock_assignment'
    ]);

    const machineColumns = await db.query(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'cam_machines' and column_name = 'can_run_turning'
    `);
    expect(machineColumns.rows).toHaveLength(1);
  });

  it('only accepts spacer or hexShaft as a cam_type', async () => {
    db = await freshDb();
    await db.exec(migrationSql);

    await db.query(
      `insert into public.fusion_turning_parts (name, cam_type) values ('A spacer', 'spacer')`
    );
    await db.query(
      `insert into public.fusion_turning_parts (name, cam_type) values ('A hex shaft', 'hexShaft')`
    );

    await expect(
      db.query(`insert into public.fusion_turning_parts (name, cam_type) values ('Bad kind', 'tube')`)
    ).rejects.toThrow();
  });

  it('defaults quantity to 1 and tailstock_length_in/step_file_name to null', async () => {
    db = await freshDb();
    await db.exec(migrationSql);

    const { rows: [row] } = await db.query(
      `insert into public.fusion_turning_parts (name, cam_type) values ('A spacer', 'spacer')
       returning quantity, tailstock_length_in, step_file_name`
    );
    expect(row.quantity).toBe(1);
    expect(row.tailstock_length_in).toBeNull();
    expect(row.step_file_name).toBeNull();
  });

  it('touches updated_at on update', async () => {
    db = await freshDb();
    await db.exec(migrationSql);

    const { rows: [part] } = await db.query(
      `insert into public.fusion_turning_parts (name, cam_type) values ('A spacer', 'spacer') returning id, updated_at`
    );

    await db.query(`select pg_sleep(0.01)`);
    const { rows: [updated] } = await db.query(
      `update public.fusion_turning_parts set quantity = 2 where id = $1 returning updated_at`,
      [part.id]
    );

    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(part.updated_at).getTime());
  });
});
