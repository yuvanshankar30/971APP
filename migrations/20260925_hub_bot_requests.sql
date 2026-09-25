-- Durable log of every "@Spartans Hub" mention the bot actually handles -
-- direct instruction, motivated by a real /edit failure ("Gemini did not
-- finish drafting this change within the tool-call round limit") that was
-- only diagnosable at all by cross-referencing a Slack screenshot against
-- raw Cloud Run stdout logs by hand. This table gives that same picture a
-- permanent, queryable home instead: what was asked, by whom, what kind of
-- request it was classified as, whether it succeeded, and how long it took.
CREATE TABLE IF NOT EXISTS public.hub_bot_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_user_id text,
  channel_id text,
  thread_ts text,
  event_ts text,
  -- One of the branches handleHubAppMention's own question-classifier
  -- predicates recognize (see classifyBotRequestType in
  -- hub_bot_request_log.js) - kept as free text, not an enum, since new
  -- request kinds are added by adding a predicate, not a migration.
  request_type text NOT NULL,
  question text,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'error')),
  error_message text,
  duration_ms integer,
  response_ts text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hub_bot_requests_created_at_idx
  ON public.hub_bot_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS hub_bot_requests_type_outcome_idx
  ON public.hub_bot_requests (request_type, outcome);

ALTER TABLE public.hub_bot_requests ENABLE ROW LEVEL SECURITY;
-- Server-only, same as slack_event_receipts: written by the webhook handler
-- using the service-role client, never read or written by the client bundle.
REVOKE ALL ON TABLE public.hub_bot_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.hub_bot_requests TO service_role;
