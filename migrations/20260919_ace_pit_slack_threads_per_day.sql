-- ACE wants a new thread each new day of a multi-day competition, not one
-- thread spanning the whole event - the thread's own title already reads
-- "<date> Ace Issues" (see acePitThreadTitle), so the thread itself needs
-- to actually roll over with the date instead of staying keyed to the
-- event alone.
ALTER TABLE public.ace_pit_slack_threads
  ADD COLUMN IF NOT EXISTS thread_date date;

UPDATE public.ace_pit_slack_threads
SET thread_date = created_at::date
WHERE thread_date IS NULL;

ALTER TABLE public.ace_pit_slack_threads
  ALTER COLUMN thread_date SET NOT NULL,
  ALTER COLUMN thread_date SET DEFAULT current_date;

ALTER TABLE public.ace_pit_slack_threads
  DROP CONSTRAINT IF EXISTS ace_pit_slack_threads_pkey;

ALTER TABLE public.ace_pit_slack_threads
  ADD PRIMARY KEY (event_key, thread_date);
