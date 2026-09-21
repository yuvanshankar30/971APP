-- Service-managed corrections and promotional balances for the play-point
-- leaderboard. These do not alter immutable bet history.
CREATE TABLE IF NOT EXISTS public.prediction_market_leaderboard_overrides (
  event_key text NOT NULL DEFAULT '*',
  participant_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  balance numeric CHECK (balance IS NULL OR balance >= 0),
  losses integer CHECK (losses IS NULL OR losses >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_key, participant_id)
);

ALTER TABLE public.prediction_market_leaderboard_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.prediction_market_leaderboard_overrides FROM authenticated, anon;
GRANT ALL ON TABLE public.prediction_market_leaderboard_overrides TO service_role;
DROP POLICY IF EXISTS prediction_market_leaderboard_overrides_service_all
  ON public.prediction_market_leaderboard_overrides;
CREATE POLICY prediction_market_leaderboard_overrides_service_all
  ON public.prediction_market_leaderboard_overrides
  TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.prediction_market_leaderboard_overrides
  (event_key, participant_id, balance, losses)
SELECT '*', id, 3000, 5
FROM public.user_profiles
WHERE lower(trim(full_name)) = 'arin rao'
ON CONFLICT (event_key, participant_id) DO UPDATE
SET balance = EXCLUDED.balance,
    losses = EXCLUDED.losses,
    updated_at = now();
