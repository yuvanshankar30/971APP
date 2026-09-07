import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./20260906_add_tubestock_operation_type.sql', import.meta.url), 'utf8');

describe('AutoCAM operation type migration', () => {
  let db;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS public;
      CREATE TABLE public.cam_machines (
        id integer PRIMARY KEY,
        operation_type text CONSTRAINT cam_machines_operation_type_check
          CHECK (operation_type IN ('turning', 'routing', 'milling'))
      );
      CREATE TABLE public.cam_jobs (
        id integer PRIMARY KEY,
        operation_type text CONSTRAINT cam_jobs_operation_type_check
          CHECK (operation_type IN ('turning', 'routing', 'milling'))
      );
    `);
  });

  afterEach(async () => db.close());

  it('allows tubestock in both checked tables and remains idempotent', async () => {
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("INSERT INTO public.cam_machines VALUES (1, 'tubestock')");
    await db.exec("INSERT INTO public.cam_jobs VALUES (1, 'tubestock')");

    await expect(db.exec("INSERT INTO public.cam_jobs VALUES (2, 'telepathy')")).rejects.toThrow(/check constraint/i);
  });
});
