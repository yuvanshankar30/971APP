-- Give every existing account the shared header configuration defined in
-- src/lib/defaultTabs.js: Home, Manufacturing, Competition, CAD, Purchasing,
-- Docs, and Admin (when authorized). NULL intentionally means "use default".
-- People can still personalize the header again from their profile afterward.
UPDATE public.user_profiles
SET header_tabs = NULL
WHERE header_tabs IS NOT NULL;
