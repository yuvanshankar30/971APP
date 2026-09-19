-- Slack supports threads only on whole messages, not on individual team rows.
-- One parent per competition therefore keeps every applicable team and all
-- subsequent updates together without cluttering the channel.
-- If the short-lived per-team implementation already created parents, queue
-- those bot messages for deletion before replacing their tracking rows.
INSERT INTO public.ace_pit_slack_legacy_messages (event_key, team_key, channel, message_ts)
SELECT event_key, team_key, channel, root_ts
FROM public.ace_pit_slack_threads
ON CONFLICT (channel, message_ts) DO NOTHING;

DELETE FROM public.ace_pit_slack_threads;

ALTER TABLE public.ace_pit_slack_threads
  DROP CONSTRAINT IF EXISTS ace_pit_slack_threads_pkey;

ALTER TABLE public.ace_pit_slack_threads
  DROP COLUMN IF EXISTS team_key;

ALTER TABLE public.ace_pit_slack_threads
  ADD PRIMARY KEY (event_key);
