import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const partsSql = readFileSync(new URL('./20260911_fusion_turning_parts.sql', import.meta.url), 'utf8');
const stockSql = readFileSync(new URL('./20260929_fusion_turning_stock.sql', import.meta.url), 'utf8');

describe('fusion_turning_parts stock migration', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function migratedDb() {
    const database = new PGlite();
    await database.exec(`
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
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
    await database.exec(partsSql);
    await database.exec(stockSql);
    return database;
  }

  it('adds nullable stock columns and stays safe to rerun', async () => {
    db = await migratedDb();
    await db.exec(stockSql);
    const { rows } = await db.query(`
      select column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'fusion_turning_parts' and column_name in ('stock_length_in', 'stock_od_in', 'stock_id_in', 'stock_across_flats_in')
      order by column_name
    `);
    expect(rows).toEqual([
      { column_name: 'stock_across_flats_in', is_nullable: 'YES' },
      { column_name: 'stock_id_in', is_nullable: 'YES' },
      { column_name: 'stock_length_in', is_nullable: 'YES' },
      { column_name: 'stock_od_in', is_nullable: 'YES' }
    ]);
  });

  it('leaves existing-style rows valid, with every stock field null', async () => {
    db = await migratedDb();
    const { rows: [row] } = await db.query(
      `insert into public.fusion_turning_parts (name, cam_type) values ('Old spacer', 'spacer')
       returning stock_length_in, stock_od_in, stock_id_in, stock_across_flats_in`
    );
    expect(row).toEqual({ stock_length_in: null, stock_od_in: null, stock_id_in: null, stock_across_flats_in: null });
  });

  it('accepts real stock and rejects non-positive values or an ID not smaller than the OD', async () => {
    db = await migratedDb();
    await db.query(
      `insert into public.fusion_turning_parts (name, cam_type, stock_od_in, stock_id_in, stock_length_in)
       values ('Tube spacer', 'spacer', 0.5, 0.23, 3)`
    );
    await expect(db.query(
      `insert into public.fusion_turning_parts (name, cam_type, stock_od_in) values ('Bad', 'spacer', 0)`
    )).rejects.toThrow();
    await expect(db.query(
      `insert into public.fusion_turning_parts (name, cam_type, stock_od_in, stock_id_in) values ('Bad', 'spacer', 0.5, 0.5)`
    )).rejects.toThrow();
  });
});

describe('fusion_turning_parts internal shaft migration', () => {
  let db;
  const internalSql = readFileSync(new URL('./20260929_fusion_internal_shaft.sql', import.meta.url), 'utf8');

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function partsDb() {
    const database = new PGlite();
    await database.exec(`
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
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
    await database.exec(partsSql);
    return database;
  }

  it('allows the new type, keeps the old ones, still rejects unknown types, and reruns safely', async () => {
    db = await partsDb();
    await db.query(`insert into public.fusion_turning_parts (name, cam_type) values ('Old hex', 'hexShaft')`);
    await expect(db.query(`insert into public.fusion_turning_parts (name, cam_type) values ('New', 'internalShaft')`)).rejects.toThrow();

    await db.exec(internalSql);
    await db.exec(internalSql);

    for (const kind of ['spacer', 'hexShaft', 'internalShaft']) {
      await db.query(`insert into public.fusion_turning_parts (name, cam_type) values ($1, $2)`, [kind, kind]);
    }
    await expect(db.query(`insert into public.fusion_turning_parts (name, cam_type) values ('Bad', 'tube')`)).rejects.toThrow();
    const { rows } = await db.query(`select count(*)::int as n from public.fusion_turning_parts`);
    expect(rows[0].n).toBe(4);
  });
});
