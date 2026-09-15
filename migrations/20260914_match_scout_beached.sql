-- Preserve whether a robot became beached during the match as a structured
-- post-match observation. A non-null false default keeps all historical
-- reports readable and makes corrections an ordinary upsert.
ALTER TABLE public.match_scout_entries
  ADD COLUMN IF NOT EXISTS beached boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.match_scout_entries.beached IS
  'Whether the robot became beached during the scouted match.';

NOTIFY pgrst, 'reload schema';
