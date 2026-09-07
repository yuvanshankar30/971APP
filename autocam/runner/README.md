# AutoCAM Runner - milling only (now built, see Fusion CAM)

Turning and routing don't need this — both generate G-code synchronously,
server-side, from pure geometry math (`autocam/turning.js`,
`autocam/routing.js`) driven off geometry extracted directly from the
part's STEP file (`autocam/stepProfile.js`, via `occt-import-js`) in
`src/routes/api/cam-generate/+server.js`. There is no external process to
poll or claim jobs for those two operations, and no separate 2D
drawing to upload - just the STEP file the part already has.

**Milling is now built as Fusion CAM** (`autocam/fusion/`, reachable from
`/autocam/fusion`) - this is Option C from `autocam/docs/millimplementations.md`
(a local Fusion 360 add-in polling `cam_jobs` where `operation_type =
'milling'`), implemented as a native SvelteKit/Supabase Fusion CAM pipeline.
See `autocam/fusion/README.md` for the architecture and
`autocam/fusion/runner/docs/team-setup-guide.md` for machine setup.

It follows the job lifecycle this file used to only describe as a plan:
`queued -> claimed -> processing -> completed/failed`, using
`claimed_by`/`claimed_at` on `cam_jobs`, via a real claim/complete/fail
endpoint at `src/routes/api/fusion-runner/+server.js`. The Fusion-side half
is a Fusion 360 add-in at `autocam/fusion/runner/` that claims a
queued milling job, runs real CAM in Fusion against the part's STEP file,
and uploads each post-processed NC file byte-for-byte with its relative name,
size and SHA-256 checksum before marking the job complete.

`src/routes/api/cam-generate/+server.js` still rejects any job with
`operation_type = 'milling'` immediately - that endpoint is a separate,
synchronous path for turning/routing and was never meant to route milling
jobs to a Runner; Fusion CAM's own queueing (`src/lib/fusionCam.js`) is how
milling jobs actually get created now.
