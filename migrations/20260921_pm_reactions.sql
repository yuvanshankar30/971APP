CREATE TABLE IF NOT EXISTS public.pm_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pm_reactions_event_idx ON public.pm_reactions (event_key, created_at DESC);

ALTER TABLE public.pm_reactions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pm_reactions TO authenticated;
GRANT ALL ON TABLE public.pm_reactions TO service_role;

DROP POLICY IF EXISTS pm_reactions_select_authenticated ON public.pm_reactions;
CREATE POLICY pm_reactions_select_authenticated ON public.pm_reactions
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS pm_reactions_insert_authenticated ON public.pm_reactions;
CREATE POLICY pm_reactions_insert_authenticated ON public.pm_reactions
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_reactions_update_authenticated ON public.pm_reactions;
DROP POLICY IF EXISTS pm_reactions_delete_authenticated ON public.pm_reactions;

DROP POLICY IF EXISTS pm_reactions_service_all ON public.pm_reactions;
CREATE POLICY pm_reactions_service_all ON public.pm_reactions
  TO service_role USING (true) WITH CHECK (true);
