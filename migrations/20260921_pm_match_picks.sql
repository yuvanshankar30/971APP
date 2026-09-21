CREATE TABLE IF NOT EXISTS public.pm_match_picks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  match_key text NOT NULL,
  side text NOT NULL CHECK (side IN ('red', 'blue')),
  picked_at timestamptz NOT NULL DEFAULT now(),
  locked boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, event_key, match_key)
);

CREATE INDEX IF NOT EXISTS pm_match_picks_event_match_idx ON public.pm_match_picks (event_key, match_key);

ALTER TABLE public.pm_match_picks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pm_match_picks TO authenticated;
GRANT ALL ON TABLE public.pm_match_picks TO service_role;

DROP POLICY IF EXISTS pm_match_picks_select_authenticated ON public.pm_match_picks;
CREATE POLICY pm_match_picks_select_authenticated ON public.pm_match_picks
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS pm_match_picks_insert_authenticated ON public.pm_match_picks;
CREATE POLICY pm_match_picks_insert_authenticated ON public.pm_match_picks
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_match_picks_update_authenticated ON public.pm_match_picks;
CREATE POLICY pm_match_picks_update_authenticated ON public.pm_match_picks
  FOR UPDATE TO authenticated USING (public.approved_user() AND auth.uid() = user_id AND locked = false)
  WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_match_picks_delete_authenticated ON public.pm_match_picks;
CREATE POLICY pm_match_picks_delete_authenticated ON public.pm_match_picks
  FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = user_id AND locked = false);

DROP POLICY IF EXISTS pm_match_picks_service_all ON public.pm_match_picks;
CREATE POLICY pm_match_picks_service_all ON public.pm_match_picks
  TO service_role USING (true) WITH CHECK (true);
