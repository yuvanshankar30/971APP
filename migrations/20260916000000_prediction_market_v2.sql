-- Generic event markets. The original prediction_market_bets table remains
-- intact for auditability; v2 positions make non-match questions possible.
CREATE TABLE IF NOT EXISTS public.prediction_market_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  market_key text NOT NULL,
  market_type text NOT NULL CHECK (market_type IN ('match_winner', 'qualification_rank', 'practice')),
  outcome_key text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stake numeric NOT NULL CHECK (stake > 0),
  placed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  payout numeric,
  winning_outcome text,
  UNIQUE (event_key, market_key, created_by)
);

CREATE TABLE IF NOT EXISTS public.prediction_market_ticks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL,
  market_key text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  pools jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS prediction_market_positions_event_idx ON public.prediction_market_positions (event_key, market_key);
CREATE INDEX IF NOT EXISTS prediction_market_ticks_market_idx ON public.prediction_market_ticks (event_key, market_key, captured_at);

ALTER TABLE public.prediction_market_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prediction_market_ticks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prediction_market_positions TO authenticated;
GRANT SELECT ON public.prediction_market_ticks TO authenticated;
GRANT ALL ON public.prediction_market_positions, public.prediction_market_ticks TO service_role;

CREATE POLICY prediction_market_positions_read ON public.prediction_market_positions FOR SELECT TO authenticated USING (public.approved_user());
CREATE POLICY prediction_market_positions_insert ON public.prediction_market_positions FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = created_by);
CREATE POLICY prediction_market_positions_update ON public.prediction_market_positions FOR UPDATE TO authenticated USING (public.approved_user() AND auth.uid() = created_by AND resolved_at IS NULL) WITH CHECK (public.approved_user() AND auth.uid() = created_by);
CREATE POLICY prediction_market_positions_delete ON public.prediction_market_positions FOR DELETE TO authenticated USING (public.approved_user() AND auth.uid() = created_by AND resolved_at IS NULL);
CREATE POLICY prediction_market_ticks_read ON public.prediction_market_ticks FOR SELECT TO authenticated USING (public.approved_user());
