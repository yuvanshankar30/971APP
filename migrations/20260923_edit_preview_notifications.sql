CREATE TABLE IF NOT EXISTS public.edit_preview_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_number integer NOT NULL,
  branch_name text NOT NULL,
  slack_channel text NOT NULL,
  slack_thread_ts text NOT NULL,
  workflow_run_id bigint,
  workflow_dispatched_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'workflow_dispatched', 'workflow_running', 'dispatch_failed', 'sent', 'failed', 'timed_out')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

CREATE INDEX IF NOT EXISTS edit_preview_notifications_pending_idx
  ON public.edit_preview_notifications (created_at)
  WHERE notified_at IS NULL;

ALTER TABLE public.edit_preview_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.edit_preview_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.edit_preview_notifications TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.invoke_edit_preview_notifications_cron()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  app_url text;
  cron_token text;
  request_id bigint;
BEGIN
  SELECT decrypted_secret INTO app_url
  FROM vault.decrypted_secrets
  WHERE name = 'planner_notifications_app_url'
  ORDER BY created_at DESC
  LIMIT 1;

  SELECT decrypted_secret INTO cron_token
  FROM vault.decrypted_secrets
  WHERE name = 'planner_notifications_cron_token'
  ORDER BY created_at DESC
  LIMIT 1;

  app_url := regexp_replace(COALESCE(trim(app_url), ''), '/+$', '');
  cron_token := trim(COALESCE(cron_token, ''));
  IF app_url = '' OR cron_token = '' THEN RETURN NULL; END IF;

  SELECT net.http_post(
    url := app_url || '/api/notifications/edit-preview',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cron_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) INTO request_id;
  RETURN request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_edit_preview_notifications_cron() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edit_preview_notifications_cron() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'edit-preview-notifications-2m') THEN
    PERFORM cron.unschedule('edit-preview-notifications-2m');
  END IF;
END;
$$;

SELECT cron.schedule('edit-preview-notifications-2m', '*/2 * * * *', $$SELECT public.invoke_edit_preview_notifications_cron();$$);
