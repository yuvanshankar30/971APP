import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./20260906_fusion_queue_efficiency.sql', import.meta.url), 'utf8');

describe('Fusion queue efficiency indexes', () => {
  let db;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE public.cam_jobs (
      id uuid PRIMARY KEY,
      operation_type text NOT NULL,
      status text NOT NULL,
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      claimed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  });

  afterEach(async () => db.close());

  it('creates every index and remains safe to rerun', async () => {
    await db.exec(migration);
    await db.exec(migration);
    const result = await db.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'idx_cam_jobs_fusion_%'
      ORDER BY indexname`);
    expect(result.rows.map((row) => row.indexname)).toEqual([
      'idx_cam_jobs_fusion_active_claimed_at',
      'idx_cam_jobs_fusion_box_tube_created',
      'idx_cam_jobs_fusion_plate_created',
      'idx_cam_jobs_fusion_queued_created'
    ]);
  });
});
