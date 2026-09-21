CREATE TABLE IF NOT EXISTS public.pm_elo_ratings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  elo numeric NOT NULL DEFAULT 1000,
  events_participated integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pm_elo_ratings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pm_elo_ratings TO authenticated;
GRANT ALL ON TABLE public.pm_elo_ratings TO service_role;

DROP POLICY IF EXISTS pm_elo_ratings_select_authenticated ON public.pm_elo_ratings;
CREATE POLICY pm_elo_ratings_select_authenticated ON public.pm_elo_ratings
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS pm_elo_ratings_insert_authenticated ON public.pm_elo_ratings;
CREATE POLICY pm_elo_ratings_insert_authenticated ON public.pm_elo_ratings
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_elo_ratings_update_authenticated ON public.pm_elo_ratings;
CREATE POLICY pm_elo_ratings_update_authenticated ON public.pm_elo_ratings
  FOR UPDATE TO authenticated USING (public.approved_user() AND auth.uid() = user_id)
  WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_elo_ratings_delete_authenticated ON public.pm_elo_ratings;
CREATE POLICY pm_elo_ratings_delete_authenticated ON public.pm_elo_ratings
  FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_elo_ratings_service_all ON public.pm_elo_ratings;
CREATE POLICY pm_elo_ratings_service_all ON public.pm_elo_ratings
  TO service_role USING (true) WITH CHECK (true);
