-- Keep the Purchasing line-total column visible for existing accounts unless
-- an individual member explicitly opts out in Account Settings.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS show_purchasing_line_totals boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_profiles.show_purchasing_line_totals IS
  'Whether this account displays unit-price times quantity totals in Purchasing.';
