-- Repair deployments where the match-scout teleop role migration was skipped.
-- This is intentionally rerunnable so it can also refresh PostgREST's schema
-- cache on databases that already have the expected column.

DO $$
BEGIN
  IF to_regclass('public.match_scout_entries') IS NULL THEN
    RAISE EXCEPTION
      'public.match_scout_entries does not exist; run the base match scouting migrations first';
  END IF;
END $$;

ALTER TABLE public.match_scout_entries
  ADD COLUMN IF NOT EXISTS teleop_roles text[];

UPDATE public.match_scout_entries
SET teleop_roles = '{}'::text[]
WHERE teleop_roles IS NULL;

ALTER TABLE public.match_scout_entries
  ALTER COLUMN teleop_roles SET DEFAULT '{}'::text[],
  ALTER COLUMN teleop_roles SET NOT NULL;

COMMENT ON COLUMN public.match_scout_entries.teleop_roles IS
  'Normalized teleoperated roles selected by the match scout.';

NOTIFY pgrst, 'reload schema';
