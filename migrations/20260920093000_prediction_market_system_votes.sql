-- Private automated votes are stored separately from human bets. Only the
-- service role can read this table; the public API emits a source-free row so
-- the market UI treats it as an ordinary anonymous vote.
CREATE TABLE IF NOT EXISTS public.prediction_market_system_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  match_key text NOT NULL,
  side text NOT NULL CHECK (side IN ('red', 'blue')),
  stake numeric NOT NULL CHECK (stake > 0),
  placed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  payout numeric,
  winning_side text CHECK (winning_side IS NULL OR winning_side IN ('red', 'blue')),
  UNIQUE (event_key, match_key)
);

CREATE INDEX IF NOT EXISTS prediction_market_system_votes_event_idx
  ON public.prediction_market_system_votes (event_key);

ALTER TABLE public.prediction_market_system_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.prediction_market_system_votes FROM authenticated, anon;
GRANT ALL ON TABLE public.prediction_market_system_votes TO service_role;
DROP POLICY IF EXISTS prediction_market_system_votes_service_all ON public.prediction_market_system_votes;
CREATE POLICY prediction_market_system_votes_service_all ON public.prediction_market_system_votes
  TO service_role USING (true) WITH CHECK (true);
