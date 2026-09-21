import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const observationSql = read('./20260920090000_vision_observation_types.sql');
const sourcesSql = read('./20260920091000_vision_video_sources.sql');
const approvalSql = read('./20260920092000_vision_model_approval_gate.sql');

describe('vision issue migrations', () => {
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function freshDb() {
    const database = new PGlite();
    await database.exec(`
      create role authenticated;
      create role service_role;
      create schema auth;
      create table auth.users (id uuid primary key);
      create table public.vision_matches (id uuid primary key);
      create table public.vision_observations (
        id uuid primary key,
        observation_type text not null check (observation_type in ('fuel_scored'))
      );
    `);
    return database;
  }

  it('adds the new observation vocabulary and remains rerunnable', async () => {
    db = await freshDb();
    await db.exec(observationSql);
    await db.exec(observationSql);
    await db.exec(`insert into public.vision_observations (id, observation_type) values ('00000000-0000-0000-0000-000000000001', 'fuel_shot')`);
    await expect(db.exec(`insert into public.vision_observations (id, observation_type) values ('00000000-0000-0000-0000-000000000002', 'nonsense')`)).rejects.toThrow();
  });

  it('creates video source and approval tables with enforced safety flags', async () => {
    db = await freshDb();
    await db.exec(sourcesSql);
    await db.exec(sourcesSql);
    await db.exec(approvalSql);
    await db.exec(approvalSql);
    const tables = await db.query(`select table_name from information_schema.tables where table_schema='public' and table_name like 'vision_%' order by table_name`);
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'vision_event_policies', 'vision_model_approvals', 'vision_video_sources'
    ]));
    await expect(db.exec(`insert into public.vision_video_sources (vision_match_id, provider, external_id, url, review_only, calibrated) values ('00000000-0000-0000-0000-000000000010','youtube','x','https://example.test',false,false)`)).rejects.toThrow();
  });
});
