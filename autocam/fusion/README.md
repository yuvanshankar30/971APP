# Fusion CAM

The production Fusion-360-backed milling pipeline, separate from `autocam/`'s
pure-JavaScript turning/routing generator. It handles plate nesting, box tube,
real 3-axis toolpaths, machine-specific templates and exact post-processed NC
artifacts through a Fusion add-in polling Spartans Hub's `cam_jobs` queue.

Ported from FRC Team Valor 6800's open-source **AutoCAM** (MIT licensed):
- [`AutoCAM-FRC/Website`](https://github.com/AutoCAM-FRC/Website) - the original job-queue dashboard (Next.js/React/tRPC/Drizzle/Postgres/Better-Auth).
- [`AutoCAM-FRC/Runner`](https://github.com/AutoCAM-FRC/Runner) - the original Fusion 360 add-in.

## Structure

- **`_upstream/`** - the original `AutoCAM-FRC/Website` source, vendored in whole via `git subtree` (preserves upstream commit history; `git subtree pull` can bring in future upstream fixes). **Reference only - never built, never imported, not wired into `vite.config.js` or this app's SvelteKit routing.** It's here so the exact original is always available to diff/port from directly, not re-derived from memory.
- **`runner/_upstream/`** - same treatment for the original `AutoCAM-FRC/Runner` Fusion 360 add-in source.
- **`grouping.js`** - browser-side grouping helpers; database triggers remain
  authoritative for inventory and immutable job snapshots.
- **`jobPayload.js`** - turns a claimed job snapshot into signed Runner input.
- **`runner/`** - the active Fusion add-in: claims work from
  `/api/fusion-runner`, imports STEP files, arranges parts, applies templates,
  generates toolpaths and uploads exact NC artifacts.
- **`runner/templates/`** - generic and reviewed team templates. Plate jobs
  select the reviewed machine/material template when a mapping exists and
  fail back to the generic template only for combinations without one.
- **`turning/`** - experimental Fusion turning foundation. It is not connected
  to the production queue and does not generate G-code.
- **`_upstream/` and `runner/_upstream/`** - frozen reference snapshots of the
  original projects. They are excluded from the build and tests; do not treat
  their setup instructions as Spartans Hub instructions.

The web UI lives under `src/routes/autocam/fusion/`, the browser data layer is
`src/lib/fusionCam.js`, and the authenticated Runner API is
`src/routes/api/fusion-runner/+server.js`. SvelteKit route files remain under
`src/routes` because their location defines the URL.

## Operator documentation

- [`runner/docs/team-setup-guide.md`](runner/docs/team-setup-guide.md) - install
  and authenticate the add-in.
- [`runner/docs/usage-guide.md`](runner/docs/usage-guide.md) - queue and monitor
  jobs.
- [`runner/docs/cam-engineering-plan.md`](runner/docs/cam-engineering-plan.md) -
  machine/template validation and remaining release gates.
- [`runner/README.md`](runner/README.md) - Runner architecture and configuration.

## Why vendor the whole original instead of just porting from memory

The frozen references make it possible to audit what was ported without making
the deployed app depend on upstream availability. They are historical source,
not a second application to install or maintain.
