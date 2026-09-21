-- Slack retries event callbacks when acknowledgements are slow or interrupted.
-- Persist receipts so duplicate app_mention deliveries cannot create duplicate
-- replies when Cloud Run uses multiple instances or restarts between attempts.
CREATE TABLE IF NOT EXISTS public.slack_event_receipts (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  channel_id text,
  event_ts text,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS slack_event_receipts_status_updated_idx
  ON public.slack_event_receipts (status, updated_at);

ALTER TABLE public.slack_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.slack_event_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.slack_event_receipts TO service_role;
