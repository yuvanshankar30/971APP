-- Grants CREATE_BUILDS to every approved member (general_role = 'member'),
-- not just subsystem_lead/lead, matching the app-side GENERAL_ROLE_PERMISSIONS
-- update in src/lib/permissions.js. Without this backfill, every existing
-- member's already-materialized permissions array stays stale until an
-- admin happens to re-save their roles - has_permission('CREATE_BUILDS')
-- (checked by the builds table's INSERT RLS policy) reads that stored
-- array directly, not the role, so a member would see the Create Manual
-- Build button but have their insert rejected by RLS until this runs.
-- Idempotent: array_append with a NOT ... @> guard, safe to re-run.
UPDATE public.user_profiles
SET permissions = array_append(COALESCE(permissions, '{}'::text[]), 'CREATE_BUILDS')
WHERE general_role = 'member'
  AND NOT (COALESCE(permissions, '{}'::text[]) @> ARRAY['CREATE_BUILDS']);
