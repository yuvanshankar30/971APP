-- Give drawn autonomous routes a human-readable name so scouts can find and
-- reopen them from later reports for the same team and event.
ALTER TABLE public.match_scout_entries
  ADD COLUMN IF NOT EXISTS auto_path_name text;

ALTER TABLE public.match_scout_entries
  DROP CONSTRAINT IF EXISTS match_scout_entries_auto_path_name_length_check;

ALTER TABLE public.match_scout_entries
  ADD CONSTRAINT match_scout_entries_auto_path_name_length_check
  CHECK (auto_path_name IS NULL OR char_length(auto_path_name) <= 120);
