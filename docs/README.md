# Spartans Hub Documentation

**The whole-project architecture overview lives at the repo root -
[`README.md`](../README.md)** - stack, module map, data layer, deployment,
contribution workflow. Deliberately not in this folder so it's the first
thing anyone sees landing on the repo, not something to go looking for.

Docs are split by purpose:

## `guides/` — living reference

How a system works **today**. Update these when the system changes.

| Doc | Covers |
|---|---|
| [AUTH_PROTOCOL.md](guides/AUTH_PROTOCOL.md) | Authentication flow, UUID-only local persistence, profile fetching |
| [BUDGET_SYSTEM_GUIDE.md](guides/BUDGET_SYSTEM_GUIDE.md) | Purchasing budgets: scopes, Project ID matching, pinning |

## `changes/` — historical change records

Point-in-time summaries of feature work, newest first. These describe what
changed and why; they are **not** kept up to date afterward.

| Doc | Date | Covers |
|---|---|---|
| [AUG_2026_MANUFACTURING_NOTIFICATIONS.md](changes/AUG_2026_MANUFACTURING_NOTIFICATIONS.md) | Aug 2026 | Manufacturing lead Slack notifications, request notes, admin Notifications role, profile-fetch column-list bugs |
| [AUG_2026_NAV_REORG.md](changes/AUG_2026_NAV_REORG.md) | Aug 2026 | Nav regrouped into Purchasing/Manufacturing/Competition/CAD folders, dropdown-clipping fix, AutoCAM dev-server 403 fix |
| [JULY_2026_UPDATES.md](changes/JULY_2026_UPDATES.md) | Jul 2026 | Purchasing roles/permissions rework, offseason budget, request-flood fixes, Modern theme |
| [PURCHASING_ADMIN_README.md](changes/PURCHASING_ADMIN_README.md) | — | Purchasing admin subtab, vendors table, analytics |
| [PROFILE_UI_IMPROVEMENTS.md](changes/PROFILE_UI_IMPROVEMENTS.md) | — | Profile header customization, drag-and-drop nav, live preview |
| [BUILD_TAB_CHANGES.md](changes/BUILD_TAB_CHANGES.md) | — | Build detail page reorganization, version-based BOM refetch |
| [BUILD_TAB_QUICK_REF.md](changes/BUILD_TAB_QUICK_REF.md) | — | Visual before/after reference for the build tab work |
| [BUILD_TAB_TESTING.md](changes/BUILD_TAB_TESTING.md) | — | Testing checklist for the build tab work |
| [MIGRATION_README.md](changes/MIGRATION_README.md) | — | Removal of the build approval workflow (DB migration) |
| [SEASON_TAGGING_CHANGES.md](changes/SEASON_TAGGING_CHANGES.md) | — | Season tagging and filtering changes |

## `plans/` — proposed work, not yet built

Implementation plans for features that don't exist yet. Grounded in the
real state of the app at the time they were written (confirmed via code
reads / live DB queries, not assumed), with explicit open questions rather
than guessed answers - update or supersede rather than trusting blindly
once the underlying app has moved on.

| Doc | Date | Covers |
|---|---|---|
| [2026-08-24-rostermanager-api-integration.md](plans/2026-08-24-rostermanager-api-integration.md) | Aug 2026 | Secure add/remove API for the external RosterManager App (Google Groups/GitHub/OnShape onboarding tool) |
| [2026-06-17-manufacture-features.md](plans/2026-06-17-manufacture-features.md) | Jun 2026 | Manufacturing feature checklist (agentic task breakdown) |

## `deployment/` — hosting & infrastructure

| Doc | Covers |
|---|---|
| [google-cloud-run.md](deployment/google-cloud-run.md) | Cloud Run deployment: Cloud Build trigger, secrets, `.dockerignore` gotchas |
| [supabase-alternative-design.md](deployment/supabase-alternative-design.md) | Design notes on Supabase's role in the current architecture |

## `design/` — product and interface standards

| Doc | Covers |
|---|---|
| [avoiding-ai-slop.md](design/avoiding-ai-slop.md) | Concrete interface-writing and visual-design standards for this app |

## `issue-assets/` — issue attachments

Screenshots and other evidence referenced by GitHub issues. These are supporting
artifacts, not living product documentation.
