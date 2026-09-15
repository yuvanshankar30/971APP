-- A friendly, play-money prediction market on match outcomes: scouts wager
-- on which alliance wins an upcoming match. One editable row per (event,
-- match, scout) until the match locks. Resolution (payout/winning_side) is
-- computed server-side with a pari-mutuel split once TBA reports a result -
-- see src/lib/predictionMarket.js. No real money changes hands; the
-- eventual leaderboard prize is a physical one (candy), decided by whoever
-- ends an event with the highest derived balance.
CREATE TABLE IF NOT EXISTS public.prediction_market_bets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  match_key text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  side text NOT NULL,
  stake numeric NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  payout numeric,
  winning_side text,
  CONSTRAINT prediction_market_bets_side_check CHECK (side IN ('red', 'blue')),
  CONSTRAINT prediction_market_bets_stake_positive CHECK (stake > 0),
  CONSTRAINT prediction_market_bets_winning_side_check CHECK (winning_side IS NULL OR winning_side IN ('red', 'blue')),
  UNIQUE (event_key, match_key, created_by)
);

CREATE INDEX IF NOT EXISTS prediction_market_bets_event_idx
  ON public.prediction_market_bets (event_key);
CREATE INDEX IF NOT EXISTS prediction_market_bets_match_idx
  ON public.prediction_market_bets (event_key, match_key);

ALTER TABLE public.prediction_market_bets ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prediction_market_bets TO authenticated;
GRANT ALL ON TABLE public.prediction_market_bets TO service_role;

-- Select is open to every approved user, not just the bettor: a leaderboard
-- is the entire point of this feature, and everyone needs to see everyone
-- else's settled results to trust it.
DROP POLICY IF EXISTS prediction_market_bets_select_authenticated ON public.prediction_market_bets;
CREATE POLICY prediction_market_bets_select_authenticated ON public.prediction_market_bets
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS prediction_market_bets_insert_authenticated ON public.prediction_market_bets;
CREATE POLICY prediction_market_bets_insert_authenticated ON public.prediction_market_bets
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = created_by);

-- A regular scout can only ever edit or delete their OWN unresolved bet -
-- once resolved_at is set the row is history, not something they can nudge
-- after the fact. Resolving OTHER scouts' bets when a match's result comes
-- in is done by the server's service-role client, which bypasses RLS
-- entirely (see the service-role policy below) rather than needing a
-- broader authenticated policy here.
DROP POLICY IF EXISTS prediction_market_bets_update_authenticated ON public.prediction_market_bets;
CREATE POLICY prediction_market_bets_update_authenticated ON public.prediction_market_bets
  FOR UPDATE TO authenticated
  USING (public.approved_user() AND auth.uid() = created_by AND resolved_at IS NULL)
  WITH CHECK (public.approved_user() AND auth.uid() = created_by);

DROP POLICY IF EXISTS prediction_market_bets_delete_authenticated ON public.prediction_market_bets;
CREATE POLICY prediction_market_bets_delete_authenticated ON public.prediction_market_bets
  FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = created_by AND resolved_at IS NULL);

DROP POLICY IF EXISTS prediction_market_bets_service_all ON public.prediction_market_bets;
CREATE POLICY prediction_market_bets_service_all ON public.prediction_market_bets
  TO service_role USING (true) WITH CHECK (true);
