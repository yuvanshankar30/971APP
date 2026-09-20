-- Reverses 20260919_disable_ace_pit_slack_notifications.sql: ACE has since
-- asked for automated pit notifications back, now aimed at a new channel
-- (#2026-ace-pit-bot) with one thread per competition and every report/
-- edit/resolution as its own reply in that thread, rather than the old
-- per-team-thread design in the #2026-chezy-ace-strat-pit channel.
GRANT ALL ON TABLE public.ace_pit_slack_threads TO service_role;
