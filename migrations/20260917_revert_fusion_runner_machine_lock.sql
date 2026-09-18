-- Direct instruction: revert 20260917_auto_lock_new_fusion_runner_machines.sql.
--
-- That migration made every newly self-registered Fusion Runner machine
-- lock itself to the exact hostname that created it, on the theory that a
-- cam_machines row represents a specific physical computer "wired to" a
-- router. Confirmed live and corrected: the Runner is pure CAM - it opens
-- a STEP file, generates toolpaths, and uploads G-code artifacts; it never
-- operates a physical machine, and nothing about it requires a specific
-- computer. Real routers (New Router, UNC Router) are meant to be CAM-
-- processed by any team member's own installed Runner, not by one
-- permanently hardcoded hostname - confirmed live that a real job queued
-- for New Router was never even offered to a second, legitimately
-- installed Runner, let alone rejected by the authorization check: its own
-- RUNNER_MACHINE_ID (auto-registered to its own new, separate machine row)
-- never included New Router's id in the first place.
--
-- This restores authorize_fusion_runner_setup_session() to never set
-- authorized_runner_id on the machine it creates, and clears every value
-- that migration or its own backfill set on the live table, back to NULL
-- (no restriction) - the same "no restriction until an admin manually
-- locks one down" state every machine was already in before that
-- migration shipped, earlier this same day.
CREATE OR REPLACE FUNCTION public.authorize_fusion_runner_setup_session(
  requested_session_id uuid,
  issued_token text
)
RETURNS TABLE (machine_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  configured_runner_name text;
  configured_machine_id uuid;
  configured_token_id uuid;
BEGIN
  SELECT session.runner_name
    INTO configured_runner_name
  FROM public.fusion_runner_setup_sessions AS session
  WHERE session.id = requested_session_id
    AND session.expires_at > now()
    AND session.completed_at IS NULL
    AND session.consumed_at IS NULL
  FOR UPDATE;

  IF configured_runner_name IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(lower(configured_runner_name)));
  SELECT machine.id
    INTO configured_machine_id
  FROM public.cam_machines AS machine
  WHERE lower(machine.name) = lower(configured_runner_name)
  LIMIT 1;

  IF configured_machine_id IS NULL THEN
    INSERT INTO public.cam_machines (name, enabled)
    VALUES (configured_runner_name, false)
    RETURNING id INTO configured_machine_id;
  END IF;

  INSERT INTO public.runner_tokens (token, name)
  VALUES (issued_token, configured_runner_name)
  RETURNING id INTO configured_token_id;

  UPDATE public.fusion_runner_setup_sessions
  SET runner_token_id = configured_token_id,
      machine_id = configured_machine_id,
      completed_at = now()
  WHERE id = requested_session_id;

  RETURN QUERY SELECT configured_machine_id;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_fusion_runner_setup_session(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_fusion_runner_setup_session(uuid, text) TO service_role;

UPDATE public.cam_machines
SET authorized_runner_id = NULL
WHERE authorized_runner_id IN ('MacBook-Air-6', 'MacBook-Air-9.local', 'MacBook-Air-9.lan', 'Arjuns-MacBook-Air.local');
