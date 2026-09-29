-- Change Leads may opt into direct notifications when a Slack /edit request
-- opens a real, unmerged PR. The server re-checks REQUEST_CODE_CHANGES at
-- delivery time; this table is only the subscription, never an authorization.
CREATE TABLE IF NOT EXISTS public.hub_change_watchers (
  user_id uuid PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.hub_change_watchers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hub_change_watchers FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.hub_change_watchers TO service_role;
