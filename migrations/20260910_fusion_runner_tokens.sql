-- Per-Runner bearer tokens for /api/fusion-runner, minted automatically by
-- setup.py (action=register-runner) so nobody has to ask an admin for the
-- one shared FUSION_RUNNER_TOKEN and paste it in by hand anymore. Direct
-- instruction: a freshly issued token works immediately - no admin
-- approval step, unlike a newly self-registered cam_machines row - so this
-- table exists purely to let one machine's key be revoked later
-- (revoked_at) without invalidating every other Runner, which a single
-- shared secret could never do. FUSION_RUNNER_TOKEN keeps working
-- alongside these; nothing about the legacy shared secret changes.
CREATE TABLE IF NOT EXISTS public.runner_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

ALTER TABLE public.runner_tokens ENABLE ROW LEVEL SECURITY;

-- Tokens are secrets - never exposed to the browser client under any role.
-- Only the service-role key (used exclusively server-side in
-- api/fusion-runner/+server.js) may read or write this table.
DROP POLICY IF EXISTS runner_tokens_service_all ON public.runner_tokens;
CREATE POLICY runner_tokens_service_all ON public.runner_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);
