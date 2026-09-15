-- Pre-scouting assignments are distinct from event pit-scouting assignments:
-- administrators may seed a small manual team list before an event roster is
-- published, and those assignments must not bleed into the pit workflow.
CREATE TABLE IF NOT EXISTS public.scout_prescout_assignments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_key text NOT NULL,
  team_key text NOT NULL,
  assigned_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (event_key, team_key)
);

ALTER TABLE public.scout_prescout_assignments OWNER TO postgres;
ALTER TABLE public.scout_prescout_assignments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scout_prescout_assignments TO authenticated;
GRANT ALL ON TABLE public.scout_prescout_assignments TO service_role;

DROP POLICY IF EXISTS scout_prescout_assignments_select ON public.scout_prescout_assignments;
DROP POLICY IF EXISTS scout_prescout_assignments_insert ON public.scout_prescout_assignments;
DROP POLICY IF EXISTS scout_prescout_assignments_update ON public.scout_prescout_assignments;
DROP POLICY IF EXISTS scout_prescout_assignments_delete ON public.scout_prescout_assignments;
DROP POLICY IF EXISTS scout_prescout_assignments_service_all ON public.scout_prescout_assignments;

CREATE POLICY scout_prescout_assignments_select ON public.scout_prescout_assignments
  FOR SELECT TO authenticated
  USING ((assigned_user = auth.uid()) OR has_permission('DATA_SCOUT_ADMIN'));

CREATE POLICY scout_prescout_assignments_insert ON public.scout_prescout_assignments
  FOR INSERT TO authenticated
  WITH CHECK (has_permission('DATA_SCOUT_ADMIN'));

CREATE POLICY scout_prescout_assignments_update ON public.scout_prescout_assignments
  FOR UPDATE TO authenticated
  USING (has_permission('DATA_SCOUT_ADMIN'))
  WITH CHECK (has_permission('DATA_SCOUT_ADMIN'));

CREATE POLICY scout_prescout_assignments_delete ON public.scout_prescout_assignments
  FOR DELETE TO authenticated
  USING (has_permission('DATA_SCOUT_ADMIN'));

CREATE POLICY scout_prescout_assignments_service_all ON public.scout_prescout_assignments
  TO service_role
  USING (true)
  WITH CHECK (true);
