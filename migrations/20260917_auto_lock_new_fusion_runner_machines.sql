-- Direct instruction: when someone pairs a new Fusion Runner, it should
-- only ever claim jobs queued for their own computer, never someone
-- else's.
--
-- Real gap found live: authorize_fusion_runner_setup_session() (see
-- 20260910_fusion_runner_tokens_setup_sessions.sql) finds-or-creates a
-- cam_machines row by matching the pairing computer's own hostname
-- case-insensitively, but only ever set authorized_runner_id on machines
-- that already had one manually configured. A brand-new self-registered
-- machine (the normal path for every teammate's own laptop, e.g. a
-- fresh install/setup test) was left with authorized_runner_id left
-- NULL, meaning /api/fusion-runner's claim endpoint (its own
-- authorizedMachineIds filter: "!machine?.authorized_runner_id ||
-- machine.authorized_runner_id === runnerId") would let ANY runner
-- claim its jobs - not just the one it was created for. Confirmed live
-- against the real cam_machines table: "New Router" already has this
-- locked (authorized_runner_id = 'MacBook-Air-6', presumably set by
-- hand), but "UNC Router" and both self-registered personal-laptop
-- machines created through this exact function did not.
--
-- This migration closes the gap going forward only: a brand-new machine
-- now locks itself to the exact hostname that created it, in the same
-- INSERT that creates it, with no separate admin step required.
-- Pre-existing machines are left untouched - CONTRIBUTING.md's own
-- migration guidance is not to guess at data changes to a live table
-- without being certain (in this case, "UNC Router"'s own real runner
-- hostname is unknown from data alone: it has no runner_tokens row at
-- all, meaning it was never paired through this system and may still
-- use an older, separate credential - locking it to a guessed name here
-- would risk locking out its real machine instead of protecting it).
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
    -- Locked to its own hostname from the moment it exists - a
    -- differently-named runner can never claim this machine's jobs
    -- unless an admin later re-points authorized_runner_id by hand
    -- (e.g. the physical machine's hostname genuinely changes).
    INSERT INTO public.cam_machines (name, enabled, authorized_runner_id)
    VALUES (configured_runner_name, false, configured_runner_name)
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
