-- Reusable path files are independent of match reports: scouts can save a
-- drawing immediately, then load it again without submitting a report.
CREATE TABLE IF NOT EXISTS public.match_scout_auto_paths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  team_key text NOT NULL,
  name text NOT NULL,
  alliance text,
  path jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_scout_auto_paths_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT match_scout_auto_paths_alliance_check CHECK (alliance IS NULL OR alliance IN ('red', 'blue')),
  CONSTRAINT match_scout_auto_paths_path_array_check CHECK (jsonb_typeof(path) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS match_scout_auto_paths_owner_name_idx
  ON public.match_scout_auto_paths (event_key, team_key, created_by, lower(name));
CREATE INDEX IF NOT EXISTS match_scout_auto_paths_lookup_idx
  ON public.match_scout_auto_paths (event_key, team_key, updated_at DESC);

ALTER TABLE public.match_scout_auto_paths ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS match_scout_auto_paths_select_authenticated ON public.match_scout_auto_paths;
CREATE POLICY match_scout_auto_paths_select_authenticated ON public.match_scout_auto_paths
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS match_scout_auto_paths_insert_authenticated ON public.match_scout_auto_paths;
CREATE POLICY match_scout_auto_paths_insert_authenticated ON public.match_scout_auto_paths
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS match_scout_auto_paths_modify_authenticated ON public.match_scout_auto_paths;
CREATE POLICY match_scout_auto_paths_modify_authenticated ON public.match_scout_auto_paths
  FOR UPDATE TO authenticated
  USING (public.has_permission('DATA_SCOUT_ADMIN') OR auth.uid() = created_by)
  WITH CHECK (public.has_permission('DATA_SCOUT_ADMIN') OR auth.uid() = created_by);

DROP POLICY IF EXISTS match_scout_auto_paths_delete_authenticated ON public.match_scout_auto_paths;
CREATE POLICY match_scout_auto_paths_delete_authenticated ON public.match_scout_auto_paths
  FOR DELETE TO authenticated
  USING (public.has_permission('DATA_SCOUT_ADMIN') OR auth.uid() = created_by);

DROP POLICY IF EXISTS match_scout_auto_paths_service_all ON public.match_scout_auto_paths;
CREATE POLICY match_scout_auto_paths_service_all ON public.match_scout_auto_paths
  TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.match_scout_auto_paths TO authenticated, service_role;
