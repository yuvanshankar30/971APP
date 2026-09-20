-- Docs was removed from the shared default header (src/lib/defaultTabs.js)
-- by direct instruction. Anyone who already had a saved header_tabs layout
-- (including everyone who got Docs added to theirs by the prior
-- 20260903_reset_header_tabs_to_shared_default.sql reset) still has it
-- pinned in their own saved layout, so the code-level removal alone doesn't
-- take it out of their header. Same fix as that prior migration: clear
-- header_tabs back to NULL ("use default") for everyone. People can still
-- personalize their header again from their profile afterward.
UPDATE public.user_profiles
SET header_tabs = NULL
WHERE header_tabs IS NOT NULL;
