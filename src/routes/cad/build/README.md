# CAD build routes

These SvelteKit routes present released CAD builds and their saved BOM
snapshots. The directory name determines the URLs, so route files stay here
even though most reusable behavior belongs in `src/lib`.

## Routes

- `+page.svelte` (`/cad/build`) lists builds grouped by project, supports
  season filtering, drag-and-drop project assignment/renaming, and summarizes
  manufacturing, purchasing, kitting and budget progress.
- `[id]/+page.svelte` (`/cad/build/:id`) shows one build's BOM snapshot,
  quantity-scaled requirements, linked downstream records, purchasing cost,
  vendor helpers and version-based BOM refresh controls.

## Data ownership

`builds` stores the release/project record and `build_bom` stores the snapshot
used by these pages. Added BOM rows may point to `parts`, `purchasing`, or
`kitting`; the route reads those linked records instead of inventing placeholder
status. Project grouping is the shared `builds.project_id` value.

Onshape requests go through `/api/onshape`. Generated preview images are cached
in the `part-previews` storage bucket and referenced from the linked part row.
Budget lookup uses `purchasing_budgets`, preferring build-specific scope before
subsystem scope.

## Maintenance checks

- Keep quantity math based on the saved build quantity and BOM row quantity;
  never rewrite the source BOM merely to display a scaled requirement.
- Preserve authentication/profile hydration before loading protected data.
- When adding a downstream workflow, update both the list summary and detail
  route so their counts cannot disagree.
- User-facing feature or route changes here also require the repo-root
  `README.md` to be updated in the same PR.
