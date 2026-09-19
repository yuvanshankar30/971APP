-- Short-lived, purpose-scoped credentials let an operator trigger queued
-- Slack migrations without weakening the normal admin-only route. Only hashes
-- are stored; successful credentials are consumed exactly once.
CREATE TABLE IF NOT EXISTS public.ace_pit_cleanup_authorizations (
  purpose text PRIMARY KEY,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

ALTER TABLE public.ace_pit_cleanup_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ace_pit_cleanup_authorizations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ace_pit_cleanup_authorizations TO service_role;
