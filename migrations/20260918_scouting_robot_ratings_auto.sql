-- Add an optional Auto (autonomous) rating alongside the existing
-- Overall/Offense/Shuttling/Driving/Defense out-of-10 categories.

ALTER TABLE public.scouting_robot_ratings
  ADD COLUMN IF NOT EXISTS auto_rating smallint;

ALTER TABLE public.scouting_robot_ratings
  DROP CONSTRAINT IF EXISTS scouting_robot_ratings_auto_range;
ALTER TABLE public.scouting_robot_ratings
  ADD CONSTRAINT scouting_robot_ratings_auto_range CHECK (auto_rating IS NULL OR auto_rating BETWEEN 1 AND 10);

NOTIFY pgrst, 'reload schema';
