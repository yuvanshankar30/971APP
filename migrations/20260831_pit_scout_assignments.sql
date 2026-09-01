-- Pit scouting team assignments: which scout is responsible for pit-
-- scouting which competition team, scoped per event (a team number can
-- recur across different events in the same season, so event_key is
-- required here - unlike scout_match_assignments, which already scopes
-- implicitly via its own per-event match_key).
--
-- A dedicated table rather than overloading scout_match_assignments'
-- match_key with a synthetic "pit" sentinel, which would collide across
-- events for any team number that competes more than once in a season.
--
-- RLS mirrors scout_match_assignments' REAL, currently-deployed policy
-- shape (has_permission('DATA_SCOUT_ADMIN'), a service-role bypass) - NOT
-- migrations/20260306_scouting_rls.sql's roster-key-aware functions
-- (has_roster_key_any, can_edit_scout_assignments), which per CONTRIBUTING.md's
-- own warning turned out to have never actually been applied to this
-- database (verified via execute_sql against pg_policy/information_schema
-- before writing this). Pit scouting has no dedicated roster role today
-- either - same situation Quick Scout was in (see computeScoutingAccess's
-- own comment in /api/scout-assignments) - so this reuses DATA_SCOUT_ADMIN,
-- the same permission 'quick' already piggybacks on.

CREATE TABLE IF NOT EXISTS public.scout_pit_assignments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_key text NOT NULL,
  team_key text NOT NULL,
  assigned_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (event_key, team_key)
);

ALTER TABLE public.scout_pit_assignments OWNER TO postgres;

DO $$
BEGIN
  IF to_regclass('public.scout_pit_assignments') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.scout_pit_assignments ENABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scout_pit_assignments TO authenticated';
    EXECUTE 'GRANT ALL ON TABLE public.scout_pit_assignments TO service_role';

    EXECUTE 'DROP POLICY IF EXISTS scout_pit_assignments_select ON public.scout_pit_assignments';
    EXECUTE 'DROP POLICY IF EXISTS scout_pit_assignments_insert ON public.scout_pit_assignments';
    EXECUTE 'DROP POLICY IF EXISTS scout_pit_assignments_update ON public.scout_pit_assignments';
    EXECUTE 'DROP POLICY IF EXISTS scout_pit_assignments_delete ON public.scout_pit_assignments';
    EXECUTE 'DROP POLICY IF EXISTS scout_pit_assignments_service_all ON public.scout_pit_assignments';

    EXECUTE '
      CREATE POLICY scout_pit_assignments_select
      ON public.scout_pit_assignments
      FOR SELECT
      TO authenticated
      USING ((assigned_user = auth.uid()) OR has_permission(''DATA_SCOUT_ADMIN''))
    ';

    EXECUTE '
      CREATE POLICY scout_pit_assignments_insert
      ON public.scout_pit_assignments
      FOR INSERT
      TO authenticated
      WITH CHECK (has_permission(''DATA_SCOUT_ADMIN''))
    ';

    EXECUTE '
      CREATE POLICY scout_pit_assignments_update
      ON public.scout_pit_assignments
      FOR UPDATE
      TO authenticated
      USING (has_permission(''DATA_SCOUT_ADMIN''))
      WITH CHECK (has_permission(''DATA_SCOUT_ADMIN''))
    ';

    EXECUTE '
      CREATE POLICY scout_pit_assignments_delete
      ON public.scout_pit_assignments
      FOR DELETE
      TO authenticated
      USING (has_permission(''DATA_SCOUT_ADMIN''))
    ';

    EXECUTE '
      CREATE POLICY scout_pit_assignments_service_all
      ON public.scout_pit_assignments
      TO service_role
      USING (true)
      WITH CHECK (true)
    ';
  END IF;
END $$;
