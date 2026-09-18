-- Shared, post-match best-to-worst robot order for the active scouting event.
--
-- This is deliberately one row per event match, rather than one ranking per
-- scout. The group discussing a match should leave one editable conclusion;
-- changing it replaces the evidence that feeds Power Rankings instead of
-- repeatedly counting the same match.

CREATE TABLE IF NOT EXISTS public.scouting_match_rankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  match_key text NOT NULL,
  ranked_team_keys text[] NOT NULL,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scouting_match_rankings_unique_match UNIQUE (event_key, match_key),
  CONSTRAINT scouting_match_rankings_at_least_two_teams CHECK (cardinality(ranked_team_keys) >= 2)
);

CREATE INDEX IF NOT EXISTS scouting_match_rankings_event_idx
  ON public.scouting_match_rankings (event_key, updated_at DESC);

ALTER TABLE public.scouting_match_rankings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON TABLE public.scouting_match_rankings TO authenticated;
GRANT ALL ON TABLE public.scouting_match_rankings TO service_role;

-- Like the shared pick list, this is the scouting group's collective call at
-- the end of a match. Any approved member may record or correct it.
DROP POLICY IF EXISTS "scouting_match_rankings_select_approved" ON public.scouting_match_rankings;
CREATE POLICY "scouting_match_rankings_select_approved" ON public.scouting_match_rankings
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS "scouting_match_rankings_insert_approved" ON public.scouting_match_rankings;
CREATE POLICY "scouting_match_rankings_insert_approved" ON public.scouting_match_rankings
  FOR INSERT TO authenticated WITH CHECK (public.approved_user());

DROP POLICY IF EXISTS "scouting_match_rankings_update_approved" ON public.scouting_match_rankings;
CREATE POLICY "scouting_match_rankings_update_approved" ON public.scouting_match_rankings
  FOR UPDATE TO authenticated USING (public.approved_user()) WITH CHECK (public.approved_user());

DROP POLICY IF EXISTS "scouting_match_rankings_service_all" ON public.scouting_match_rankings;
CREATE POLICY "scouting_match_rankings_service_all" ON public.scouting_match_rankings
  TO service_role USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
