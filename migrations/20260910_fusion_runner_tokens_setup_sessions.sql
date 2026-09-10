-- Short-lived browser pairing sessions for first-time Fusion Runner setup.
-- The installer holds poll_secret; the browser URL contains only the session
-- id. This keeps the generated per-machine Runner credential out of the
-- browser and lets setup.py write it directly to the installed add-in.
CREATE TABLE IF NOT EXISTS public.fusion_runner_setup_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_secret text NOT NULL UNIQUE,
  runner_name text NOT NULL,
  runner_token_id uuid REFERENCES public.runner_tokens(id) ON DELETE SET NULL,
  machine_id uuid REFERENCES public.cam_machines(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '10 minutes'),
  completed_at timestamp with time zone,
  consumed_at timestamp with time zone,
  CONSTRAINT fusion_runner_setup_sessions_name_check CHECK (char_length(runner_name) BETWEEN 1 AND 120),
  CONSTRAINT fusion_runner_setup_sessions_completion_check CHECK (
    (completed_at IS NULL AND runner_token_id IS NULL AND machine_id IS NULL)
    OR (completed_at IS NOT NULL AND runner_token_id IS NOT NULL AND machine_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fusion_runner_setup_sessions_expires_idx
  ON public.fusion_runner_setup_sessions (expires_at);

ALTER TABLE public.fusion_runner_setup_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.fusion_runner_setup_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fusion_runner_setup_sessions TO service_role;

DROP POLICY IF EXISTS fusion_runner_setup_sessions_service_all ON public.fusion_runner_setup_sessions;
CREATE POLICY fusion_runner_setup_sessions_service_all ON public.fusion_runner_setup_sessions
  TO service_role USING (true) WITH CHECK (true);

-- Authorization is one transaction so a process failure or duplicate form
-- submit cannot leave an active token detached from its setup session.
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

-- Consume is atomic: two pollers can never receive the same machine token.
CREATE OR REPLACE FUNCTION public.consume_fusion_runner_setup_session(
  requested_session_id uuid,
  requested_poll_secret text
)
RETURNS TABLE (runner_name text, machine_id uuid, token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  token_id uuid;
  configured_machine_id uuid;
  configured_runner_name text;
BEGIN
  SELECT session.runner_token_id, session.machine_id, session.runner_name
    INTO token_id, configured_machine_id, configured_runner_name
  FROM public.fusion_runner_setup_sessions AS session
  WHERE session.id = requested_session_id
    AND session.poll_secret = requested_poll_secret
    AND session.expires_at > now()
    AND session.completed_at IS NOT NULL
    AND session.consumed_at IS NULL
  FOR UPDATE;

  IF token_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.fusion_runner_setup_sessions
  SET consumed_at = now()
  WHERE id = requested_session_id;

  RETURN QUERY
  SELECT configured_runner_name, configured_machine_id, runner_token.token
  FROM public.runner_tokens AS runner_token
  WHERE runner_token.id = token_id AND runner_token.revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_fusion_runner_setup_session(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_fusion_runner_setup_session(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_fusion_runner_setup_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_fusion_runner_setup_session(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
