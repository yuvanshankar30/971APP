-- Additional structured observations requested by match scouts.
ALTER TABLE public.match_scout_entries
  ADD COLUMN IF NOT EXISTS auto_collision boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_collision_notes text,
  ADD COLUMN IF NOT EXISTS intake_speed integer,
  ADD COLUMN IF NOT EXISTS intake_jammed boolean NOT NULL DEFAULT false;

ALTER TABLE public.match_scout_entries
  DROP CONSTRAINT IF EXISTS match_scout_entries_auto_collision_notes_length_check,
  DROP CONSTRAINT IF EXISTS match_scout_entries_intake_speed_check;

ALTER TABLE public.match_scout_entries
  ADD CONSTRAINT match_scout_entries_auto_collision_notes_length_check
    CHECK (auto_collision_notes IS NULL OR char_length(auto_collision_notes) <= 500),
  ADD CONSTRAINT match_scout_entries_intake_speed_check
    CHECK (intake_speed IS NULL OR intake_speed BETWEEN 1 AND 3);
