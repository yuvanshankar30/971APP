-- Human pairwise preferences for Power Rankings. One scout gets one current
-- vote per event/team pair; changing their mind updates that row instead of
-- double-counting them. These votes are a separate consensus signal and do
-- not alter the calculated Scout Power formula.

CREATE TABLE IF NOT EXISTS public.scouting_pairwise_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  team_a_key text NOT NULL,
  team_b_key text NOT NULL,
  winner_team_key text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scouting_pairwise_votes_distinct_teams CHECK (team_a_key <> team_b_key),
  CONSTRAINT scouting_pairwise_votes_winner_in_pair CHECK (
    winner_team_key = team_a_key OR winner_team_key = team_b_key
  ),
  UNIQUE (event_key, team_a_key, team_b_key, created_by)
);

CREATE INDEX IF NOT EXISTS scouting_pairwise_votes_event_idx
  ON public.scouting_pairwise_votes (event_key, updated_at DESC);

ALTER TABLE public.scouting_pairwise_votes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scouting_pairwise_votes TO authenticated;
GRANT ALL ON TABLE public.scouting_pairwise_votes TO service_role;

DROP POLICY IF EXISTS scouting_pairwise_votes_select_authenticated ON public.scouting_pairwise_votes;
CREATE POLICY scouting_pairwise_votes_select_authenticated ON public.scouting_pairwise_votes
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS scouting_pairwise_votes_insert_authenticated ON public.scouting_pairwise_votes;
CREATE POLICY scouting_pairwise_votes_insert_authenticated ON public.scouting_pairwise_votes
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS scouting_pairwise_votes_update_authenticated ON public.scouting_pairwise_votes;
CREATE POLICY scouting_pairwise_votes_update_authenticated ON public.scouting_pairwise_votes
  FOR UPDATE TO authenticated
  USING (public.approved_user() AND auth.uid() = created_by)
  WITH CHECK (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS scouting_pairwise_votes_delete_authenticated ON public.scouting_pairwise_votes;
CREATE POLICY scouting_pairwise_votes_delete_authenticated ON public.scouting_pairwise_votes
  FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS scouting_pairwise_votes_service_all ON public.scouting_pairwise_votes;
CREATE POLICY scouting_pairwise_votes_service_all ON public.scouting_pairwise_votes
  TO service_role USING (true) WITH CHECK (true);
