# Fusion CAM

The production Fusion-360-backed milling pipeline, separate from `autocam/`'s
pure-JavaScript turning/routing generator. It handles plate nesting, direct
box-tube jobs, real 3-axis toolpaths, machine-specific templates, and exact post-processed NC
artifacts through a Fusion add-in polling Spartans Hub's `cam_jobs` queue.

## Structure

- **`grouping.js`** - browser-side grouping helpers. The
  `queue_fusion_plate_job` database function atomically replaces the reusable
  plate's assignment set and inserts the immutable job snapshot; database
  triggers remain authoritative for validation and inventory.
- **`jobPayload.js`** - turns a claimed job snapshot into signed Runner input.
- **`runner/`** - the active Fusion add-in: claims work from
  `/api/fusion-runner`, imports STEP files, arranges parts, applies templates,
  generates toolpaths and uploads exact NC artifacts. Box-tube jobs create one
  manually indexed setup and native-post artifact for each of the four faces.
  Fusion saves are non-destructive: a duplicate document name fails the job
  without deleting the existing document.
- **`runner/templates/`** - generic and reviewed team templates. Plate jobs
  select the reviewed machine/material template when a mapping exists and
  fail back to the generic template only for combinations without one.
- **`turning/`** - experimental Fusion turning foundation. It is not connected
  to the production queue and does not generate G-code.

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
