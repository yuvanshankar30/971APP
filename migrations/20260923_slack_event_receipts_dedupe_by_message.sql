-- Real, severe production bug found while investigating a Slack spam
-- report: something upstream was redelivering the SAME message with a
-- DIFFERENT event_id each time - confirmed directly in production, where
-- one real message (one channel_id + event_ts pair) had up to 42 separate
-- "completed" rows, each with a distinct event_id, spanning 8+ hours
-- before this was caught. claimSlackEvent() (src/lib/server/
-- slack_event_receipts.js) only ever deduplicated on event_id (the
-- table's primary key), so every redelivery under a fresh event_id sailed
-- through as "new" and got its own Slack reply posted - the bot spamming
-- the same answer repeatedly.
--
-- Fix: a second uniqueness constraint on the actual message identity
-- (channel_id, event_ts), not just event_id. claimSlackEvent()'s existing
-- generic "any 23505 unique-violation means already claimed" handling
-- picks this up with no application code changes needed - it just needed
-- a second thing to collide on. Partial (WHERE both columns are set) so
-- receipts that never had a real Slack message identity attached don't
-- participate in this constraint.

-- One-time cleanup so the constraint below can be added: keep only the
-- earliest-received row per real message. Safe to rerun - a rerun either
-- finds nothing left to delete, or the index creation below is already a
-- no-op via IF NOT EXISTS.
DELETE FROM public.slack_event_receipts a
USING public.slack_event_receipts b
WHERE a.channel_id IS NOT NULL
  AND a.event_ts IS NOT NULL
  AND a.channel_id = b.channel_id
  AND a.event_ts = b.event_ts
  AND (a.received_at, a.event_id) > (b.received_at, b.event_id);

CREATE UNIQUE INDEX IF NOT EXISTS slack_event_receipts_message_identity_idx
  ON public.slack_event_receipts (channel_id, event_ts)
  WHERE channel_id IS NOT NULL AND event_ts IS NOT NULL;
