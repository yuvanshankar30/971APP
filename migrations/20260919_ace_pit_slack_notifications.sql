-- Keep the Slack delivery attached to the durable ACE issue. Re-submitting an
-- edited match report updates the original channel message rather than posting
-- a duplicate; a failed delivery leaves these columns null so the next save
-- retries it.
ALTER TABLE public.pit_problem_reports
  ADD COLUMN IF NOT EXISTS slack_channel text,
  ADD COLUMN IF NOT EXISTS slack_ts text,
  ADD COLUMN IF NOT EXISTS slack_notified_at timestamptz;

CREATE INDEX IF NOT EXISTS pit_problem_reports_unsent_slack_idx
  ON public.pit_problem_reports (created_at)
  WHERE slack_notified_at IS NULL;
