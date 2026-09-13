-- Make builds visible to all approved users, matching the visibility of the
-- subsystems/subsystem_members tables they're rendered alongside on the CAD
-- Subsystems page. Previously, builds_select_authenticated only let a user
-- see a build if they held CREATE_BUILDS (leads) or were a member of that
-- specific subsystem, so a member of one subsystem couldn't see another
-- subsystem's "Builds (N)" section or its entries in "All Builds" even
-- though the subsystem card itself (name, lead, member badges) is visible
-- to every approved user via approved_user().

DROP POLICY IF EXISTS "builds_select_authenticated" ON "public"."builds";
CREATE POLICY "builds_select_authenticated" ON "public"."builds" FOR SELECT TO "authenticated" USING ("public"."approved_user"());
