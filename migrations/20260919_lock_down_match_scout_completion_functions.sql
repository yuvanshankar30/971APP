-- Supabase may retain explicit API-role grants independently of PUBLIC.
-- Neither helper is an RPC endpoint; only the database trigger needs them.
REVOKE ALL ON FUNCTION public.normalize_match_scout_suffix(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_match_scout_assignment_from_report() FROM PUBLIC, anon, authenticated;
