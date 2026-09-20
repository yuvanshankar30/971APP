-- ACE requested that automated match-scout pit notifications stop entirely.
-- Revoking this server-only tracking table prevents older deployed revisions
-- from posting while the application-level disable rolls out.
REVOKE ALL ON TABLE public.ace_pit_slack_threads FROM service_role;
