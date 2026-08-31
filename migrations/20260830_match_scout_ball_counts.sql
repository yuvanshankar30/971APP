-- Estimated ball count per match report.
--
-- Stored the same way as auto points: the readable bucket a scout picked, plus
-- its parsed bounds, so analytics never has to re-parse display text.
--
-- The buckets are 0-25 through 475-500 in steps of 25, then an open-ended
-- 500+. That top bucket has no maximum, and its average is the lower bound
-- rather than an invented midpoint - a robot that handled "500+" balls has an
-- unknown ceiling, and averaging it against a made-up upper value would bias
-- every aggregate that includes it.
--
-- Deliberately a bucket rather than an exact number: counting balls at a
-- glance during a match is a rough judgement, and an exact field would imply
-- precision nobody watching actually has.

ALTER TABLE public.match_scout_entries
  ADD COLUMN IF NOT EXISTS balls_scored_band text,
  ADD COLUMN IF NOT EXISTS balls_scored_min numeric,
  ADD COLUMN IF NOT EXISTS balls_scored_max numeric,
  ADD COLUMN IF NOT EXISTS balls_scored_average numeric;

COMMENT ON COLUMN public.match_scout_entries.balls_scored_band IS
  'Scout-selected ball-count bucket, e.g. 75-100 or 500+. Parsed bounds live in the _min/_max/_average columns.';
COMMENT ON COLUMN public.match_scout_entries.balls_scored_max IS
  'NULL for the open-ended 500+ bucket, where no upper bound was observed.';
