CREATE TABLE IF NOT EXISTS public.pm_elo_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  match_key text NOT NULL,
  picked_side text NOT NULL CHECK (picked_side IN ('red', 'blue')),
  model_probability numeric NOT NULL,
  elo_delta numeric NOT NULL,
  elo_after numeric NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_key, match_key)
);

CREATE INDEX IF NOT EXISTS pm_elo_history_event_idx ON public.pm_elo_history (event_key, resolved_at);

ALTER TABLE public.pm_elo_history ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pm_elo_history TO authenticated;
GRANT ALL ON TABLE public.pm_elo_history TO service_role;

DROP POLICY IF EXISTS pm_elo_history_select_authenticated ON public.pm_elo_history;
CREATE POLICY pm_elo_history_select_authenticated ON public.pm_elo_history
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS pm_elo_history_insert_authenticated ON public.pm_elo_history;
CREATE POLICY pm_elo_history_insert_authenticated ON public.pm_elo_history
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_elo_history_update_authenticated ON public.pm_elo_history;
CREATE POLICY pm_elo_history_update_authenticated ON public.pm_elo_history
  FOR UPDATE TO authenticated USING (public.approved_user() AND auth.uid() = user_id AND resolved_at IS NULL)
  WITH CHECK (public.approved_user() AND auth.uid() = user_id AND resolved_at IS NULL);

DROP POLICY IF EXISTS pm_elo_history_delete_authenticated ON public.pm_elo_history;
CREATE POLICY pm_elo_history_delete_authenticated ON public.pm_elo_history
  FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = user_id AND resolved_at IS NULL);

DROP POLICY IF EXISTS pm_elo_history_service_all ON public.pm_elo_history;
CREATE POLICY pm_elo_history_service_all ON public.pm_elo_history
  TO service_role USING (true) WITH CHECK (true);
