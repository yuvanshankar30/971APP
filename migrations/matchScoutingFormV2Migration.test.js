import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

describe('match scouting v2 migration', () => {
  it('is additive, idempotent, and preserves historical reports', async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE TABLE public.scouting_settings (id integer PRIMARY KEY); CREATE TABLE public.match_scout_entries (id integer PRIMARY KEY, ratings jsonb); INSERT INTO public.match_scout_entries VALUES (1, \'{"Cycle speed":4}\');');
      const sql = readFileSync(new URL('./20260913_match_scouting_form_v2.sql', import.meta.url), 'utf8');
      await db.exec(sql);
      await db.exec(sql);
      const { rows } = await db.query('SELECT form_version, ratings, preload, significant_crash, mechanical_break FROM public.match_scout_entries WHERE id=1');
      expect(rows[0]).toEqual({ form_version: 1, ratings: { 'Cycle speed': 4 }, preload: null, significant_crash: null, mechanical_break: null });
      await expect(db.exec('UPDATE public.match_scout_entries SET auto_cycles=-1')).rejects.toThrow();
      await expect(db.exec("UPDATE public.match_scout_entries SET teleop_robot_status='bogus'")).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
