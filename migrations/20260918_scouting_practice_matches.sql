-- Practice matches for the active scouting event: TBA never knows about
-- these (they're run before/outside the official schedule), so unlike real
-- matches they need a row of their own before they can be ranked in Match
-- Rankings. One row per practice match, auto-labeled "Practice N".

CREATE TABLE IF NOT EXISTS public.scouting_practice_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  match_key text NOT NULL,
  label text NOT NULL,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scouting_practice_matches_unique_match UNIQUE (event_key, match_key)
);

CREATE INDEX IF NOT EXISTS scouting_practice_matches_event_idx
  ON public.scouting_practice_matches (event_key, created_at ASC);

ALTER TABLE public.scouting_practice_matches ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON TABLE public.scouting_practice_matches TO authenticated;
GRANT ALL ON TABLE public.scouting_practice_matches TO service_role;

-- Same spirit as the shared pick list and match rankings: any approved
-- member can add a practice match for the group to rank.
DROP POLICY IF EXISTS "scouting_practice_matches_select_approved" ON public.scouting_practice_matches;
CREATE POLICY "scouting_practice_matches_select_approved" ON public.scouting_practice_matches
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS "scouting_practice_matches_insert_approved" ON public.scouting_practice_matches;
CREATE POLICY "scouting_practice_matches_insert_approved" ON public.scouting_practice_matches
  FOR INSERT TO authenticated WITH CHECK (public.approved_user());

DROP POLICY IF EXISTS "scouting_practice_matches_service_all" ON public.scouting_practice_matches;
CREATE POLICY "scouting_practice_matches_service_all" ON public.scouting_practice_matches
  TO service_role USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
