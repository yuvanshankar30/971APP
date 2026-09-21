-- Site-wide settings, single row. Same pattern as scouting_settings
-- (20260224_scouting_settings.sql) - a small table for the one global
-- toggle we have right now, rather than a per-user preference.
--
-- competition_mode: shows/hides the competition-only home page surfaces
-- (Your Scouting Assignments, Your Pre-Scouting Assignments, and the
-- Latest/Current/Upcoming match card) for every signed-in user. Direct
-- instruction: default it OFF here, since Chezy Champs just ended and
-- there's no active event right now - an admin turns it back on from the
-- Admin panel once the next competition starts.
CREATE TABLE IF NOT EXISTS public.hub_settings (
  id integer PRIMARY KEY,
  competition_mode boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hub_settings_single_row CHECK (id = 1)
);

INSERT INTO public.hub_settings (id, competition_mode)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON TABLE public.hub_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hub_settings TO service_role;

ALTER TABLE public.hub_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hub_settings_select_authenticated" ON public.hub_settings
  FOR SELECT TO authenticated USING (true);

-- Only whoever can see the Admin panel can flip competition_mode - matches
-- permissions.js's own VIEW_ADMIN_PANEL grant (role = 'admin', the
-- superuser escape hatch, or general_role = 'lead'), so a lead who sees the
-- toggle in the UI can actually save it rather than hitting a silent RLS
-- rejection.
CREATE POLICY "hub_settings_update_admin" ON public.hub_settings
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND (role = 'admin' OR general_role = 'lead')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND (role = 'admin' OR general_role = 'lead')));
