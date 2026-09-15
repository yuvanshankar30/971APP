-- Personal, subjective robot ratings (Overall/Offense/Shuttling/Driving/
-- Defense out of 10) plus free-text notes and practice-match strategy notes.
-- One row per (event, team, scout): each scout keeps a single editable
-- rating per team per event rather than an append-only log, same shape as
-- scouting_pairwise_votes. This is a staff-judgment overlay - it feeds a
-- display-only average into Power Rankings and never changes the calculated
-- Scout Power formula.
CREATE TABLE IF NOT EXISTS public.scouting_robot_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  team_key text NOT NULL,
  team_number integer,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  overall_rating smallint NOT NULL,
  offense_rating smallint,
  shuttling_rating smallint,
  driving_rating smallint,
  defense_rating smallint, -- null means "not applicable" for this robot
  notes text,
  strategy_notes text, -- observations specific to practice matches
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scouting_robot_ratings_overall_range CHECK (overall_rating BETWEEN 1 AND 10),
  CONSTRAINT scouting_robot_ratings_offense_range CHECK (offense_rating IS NULL OR offense_rating BETWEEN 1 AND 10),
  CONSTRAINT scouting_robot_ratings_shuttling_range CHECK (shuttling_rating IS NULL OR shuttling_rating BETWEEN 1 AND 10),
  CONSTRAINT scouting_robot_ratings_driving_range CHECK (driving_rating IS NULL OR driving_rating BETWEEN 1 AND 10),
  CONSTRAINT scouting_robot_ratings_defense_range CHECK (defense_rating IS NULL OR defense_rating BETWEEN 1 AND 10),
  UNIQUE (event_key, team_key, created_by)
);

CREATE INDEX IF NOT EXISTS scouting_robot_ratings_event_team_idx
  ON public.scouting_robot_ratings (event_key, team_key);

ALTER TABLE public.scouting_robot_ratings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scouting_robot_ratings TO authenticated;
GRANT ALL ON TABLE public.scouting_robot_ratings TO service_role;

DROP POLICY IF EXISTS scouting_robot_ratings_select_authenticated ON public.scouting_robot_ratings;
CREATE POLICY scouting_robot_ratings_select_authenticated ON public.scouting_robot_ratings
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS scouting_robot_ratings_insert_authenticated ON public.scouting_robot_ratings;
CREATE POLICY scouting_robot_ratings_insert_authenticated ON public.scouting_robot_ratings
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS scouting_robot_ratings_update_authenticated ON public.scouting_robot_ratings;
CREATE POLICY scouting_robot_ratings_update_authenticated ON public.scouting_robot_ratings
  FOR UPDATE TO authenticated
  USING (public.approved_user() AND auth.uid() = created_by)
  WITH CHECK (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS scouting_robot_ratings_delete_authenticated ON public.scouting_robot_ratings;
CREATE POLICY scouting_robot_ratings_delete_authenticated ON public.scouting_robot_ratings
  FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS scouting_robot_ratings_service_all ON public.scouting_robot_ratings;
CREATE POLICY scouting_robot_ratings_service_all ON public.scouting_robot_ratings
  TO service_role USING (true) WITH CHECK (true);
