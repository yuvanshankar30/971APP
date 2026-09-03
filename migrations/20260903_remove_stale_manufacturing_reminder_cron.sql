-- The stale manufacturing reminder endpoint was intentionally removed: leads
-- receive the new-request notification, but no automatic two-day or later
-- follow-up DMs. Unschedule every old pg_cron invocation by its URL rather
-- than relying on a guessed historical job name.
DO $$
DECLARE
  stale_job record;
BEGIN
  FOR stale_job IN
    SELECT jobname
    FROM cron.job
    WHERE command LIKE '%/api/notifications/manufacturing-stale-requests%'
  LOOP
    PERFORM cron.unschedule(stale_job.jobname);
  END LOOP;
END $$;
