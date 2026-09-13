-- Additive: historical reports retain their original ratings and vocabulary.
ALTER TABLE public.match_scout_entries
  ADD COLUMN IF NOT EXISTS form_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS scout_name text,
  ADD COLUMN IF NOT EXISTS preload boolean,
  ADD COLUMN IF NOT EXISTS auto_cycles integer CHECK (auto_cycles BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS teleop_roles_none boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ratings_unknown text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS significant_crash boolean,
  ADD COLUMN IF NOT EXISTS crash_target text CHECK (crash_target IN ('robot', 'wall', 'field element', 'other')),
  ADD COLUMN IF NOT EXISTS crash_details text,
  ADD COLUMN IF NOT EXISTS teleop_robot_status text CHECK (teleop_robot_status IN ('active', 'dead', 'brownout', 'unknown')),
  ADD COLUMN IF NOT EXISTS mechanical_break boolean;

-- Photos use the existing pit-scout-photos bucket (same privacy policy as pit photos).
ALTER TABLE public.scouting_settings
  ADD COLUMN IF NOT EXISTS start_position_photos jsonb NOT NULL DEFAULT '{}';
