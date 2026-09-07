-- The theme belongs to the authenticated account, not just this browser, so
-- it is restored when the member signs in again (including after sign-out).
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS theme_preference text NOT NULL DEFAULT 'modern';

COMMENT ON COLUMN public.user_profiles.theme_preference IS
  'Account-selected application/login theme, including authorized special theme IDs.';

-- PostgREST caches table metadata. Explicitly invalidate that cache so the
-- REST API can accept theme_preference immediately after this migration runs.
NOTIFY pgrst, 'reload schema';
