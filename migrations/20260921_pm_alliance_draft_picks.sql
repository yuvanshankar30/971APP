CREATE TABLE IF NOT EXISTS public.pm_alliance_draft_picks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  predicted_captain text NOT NULL,
  predicted_pick text NOT NULL,
  pick_round integer NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  correct boolean
);

CREATE INDEX IF NOT EXISTS pm_alliance_draft_picks_event_idx ON public.pm_alliance_draft_picks (event_key, placed_at);

ALTER TABLE public.pm_alliance_draft_picks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pm_alliance_draft_picks TO authenticated;
GRANT ALL ON TABLE public.pm_alliance_draft_picks TO service_role;

DROP POLICY IF EXISTS pm_alliance_draft_picks_select_authenticated ON public.pm_alliance_draft_picks;
CREATE POLICY pm_alliance_draft_picks_select_authenticated ON public.pm_alliance_draft_picks
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS pm_alliance_draft_picks_insert_authenticated ON public.pm_alliance_draft_picks;
CREATE POLICY pm_alliance_draft_picks_insert_authenticated ON public.pm_alliance_draft_picks
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_alliance_draft_picks_update_authenticated ON public.pm_alliance_draft_picks;
CREATE POLICY pm_alliance_draft_picks_update_authenticated ON public.pm_alliance_draft_picks
  FOR UPDATE TO authenticated USING (public.approved_user() AND auth.uid() = user_id AND resolved_at IS NULL)
  WITH CHECK (public.approved_user() AND auth.uid() = user_id AND resolved_at IS NULL);

DROP POLICY IF EXISTS pm_alliance_draft_picks_delete_authenticated ON public.pm_alliance_draft_picks;
CREATE POLICY pm_alliance_draft_picks_delete_authenticated ON public.pm_alliance_draft_picks
  FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = user_id AND resolved_at IS NULL);

DROP POLICY IF EXISTS pm_alliance_draft_picks_service_all ON public.pm_alliance_draft_picks;
CREATE POLICY pm_alliance_draft_picks_service_all ON public.pm_alliance_draft_picks
  TO service_role USING (true) WITH CHECK (true);
