-- Preserve the name of the scout/contact who can answer follow-up questions.
ALTER TABLE public.pit_scout_entries
  ADD COLUMN IF NOT EXISTS scout_name text;

ALTER TABLE public.pit_scout_entries
  DROP CONSTRAINT IF EXISTS pit_scout_entries_scout_name_length_check;

ALTER TABLE public.pit_scout_entries
  ADD CONSTRAINT pit_scout_entries_scout_name_length_check
  CHECK (scout_name IS NULL OR char_length(scout_name) <= 120);
