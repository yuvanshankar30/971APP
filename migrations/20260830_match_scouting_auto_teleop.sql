-- Richer match-scout estimates without pretending a human observed an exact
-- count. The readable input stays in auto_points_band for compatibility;
-- parsed numeric columns make aggregation straightforward.

ALTER TABLE public.match_scout_entries
  ADD COLUMN IF NOT EXISTS auto_points_min numeric,
  ADD COLUMN IF NOT EXISTS auto_points_max numeric,
  ADD COLUMN IF NOT EXISTS auto_points_average numeric,
  ADD COLUMN IF NOT EXISTS teleop_roles text[] NOT NULL DEFAULT '{}'::text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'match_scout_entries_auto_points_nonnegative'
  ) THEN
    ALTER TABLE public.match_scout_entries
      ADD CONSTRAINT match_scout_entries_auto_points_nonnegative CHECK (
        (auto_points_min IS NULL OR auto_points_min >= 0)
        AND (auto_points_max IS NULL OR auto_points_max >= 0)
        AND (auto_points_average IS NULL OR auto_points_average >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'match_scout_entries_auto_points_ordered'
  ) THEN
    ALTER TABLE public.match_scout_entries
      ADD CONSTRAINT match_scout_entries_auto_points_ordered CHECK (
        auto_points_min IS NULL OR auto_points_max IS NULL OR auto_points_min <= auto_points_max
      );
  END IF;
END $$;
