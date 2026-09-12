-- Extends the vision scouting system (see migrations/20260828_vision_system.sql
-- and docs/guides/scoutingvision.md) with three additions:
--   1. Slack alerting opt-in (user_profiles.vision_notify) + seeding the two
--      requested initial recipients.
--   2. A reviewed-result "release" bridge: marks a run as released and keeps
--      an audit trail of exactly which scout_data_events rows it produced,
--      without ever mutating or deleting the original vision evidence.
--   3. Runner fleet visibility: a heartbeat table so a dashboard can show
--      whether a GPU runner is actually online, not just infer it from
--      "jobs stopped moving."

-- --- 1. Vision alert opt-in --------------------------------------------

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS vision_notify boolean NOT NULL DEFAULT false;

-- Best-effort name match, same "not a reliable FK, skip gracefully if it
-- doesn't match" stance src/lib/server/slack_notifications.js already uses
-- for parts.requester - full_name is free text, not a unique key.
UPDATE public.user_profiles
SET vision_notify = true
WHERE full_name ILIKE 'Yuvan Shankar' OR full_name ILIKE 'Arin Rao';

-- --- 2. Reviewed-result release bridge -----------------------------------

ALTER TABLE public.vision_runs
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.vision_release_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vision_run_id uuid NOT NULL REFERENCES public.vision_runs(id) ON DELETE CASCADE,
  released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  scout_data_event_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  team_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vision_release_log_run_idx ON public.vision_release_log(vision_run_id);

-- --- 3. Runner fleet visibility -------------------------------------------

CREATE TABLE IF NOT EXISTS public.vision_runners (
  runner_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  model_path text,
  current_run_id uuid REFERENCES public.vision_runs(id) ON DELETE SET NULL,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- --- RLS -------------------------------------------------------------------
-- Both new tables are read-only from the authenticated side (any approved
-- user sees them on the event dashboard, same as the rest of Vision
-- Scouting) - all writes come from service_role: the runner's own heartbeat
-- call, and api/vision's release-run action (which checks VISION_RELEASE
-- itself before ever reaching the service client, the same "app-level gate,
-- then a privileged write" shape already used for
-- notifyManufacturingRequestById etc., since a release additionally needs to
-- write to scout_data_events - a table this project's reviewers don't
-- otherwise have INSERT rights on, and shouldn't need to for this one
-- explicit, permission-gated action).
ALTER TABLE public.vision_release_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vision_runners ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['vision_release_log', 'vision_runners']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS vision_fleet_read ON public.%I', table_name);
    EXECUTE format('CREATE POLICY vision_fleet_read ON public.%I FOR SELECT TO authenticated USING (true)', table_name);
    EXECUTE format('DROP POLICY IF EXISTS vision_fleet_service ON public.%I', table_name);
    EXECUTE format('CREATE POLICY vision_fleet_service ON public.%I TO service_role USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', table_name);
  END LOOP;
END $$;
