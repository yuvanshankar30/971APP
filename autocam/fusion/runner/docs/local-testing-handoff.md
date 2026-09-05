# Picking up local Fusion CAM Runner testing

Where things stand, and how to keep running real jobs locally until the
Runner is switched over to the deployed Hub (tracked separately in
[#312](https://github.com/frc971/spartanshub/issues/312)). Read this before
touching `autocam/fusion/` if you're picking this up cold.

## The short version

The Fusion CAM Runner (`autocam/fusion/runner/`, forked from Team Valor
6800's AutoCAM) works by polling a running Spartans Hub instance for queued
`cam_jobs` rows, downloading STEP files, building a Fusion CAM setup from a
template, generating toolpaths, exporting G-code, and reporting back. Right
now it's being pointed at a **local dev server**
(`BASE_URL=http://127.0.0.1:5173` in the Runner's own `.env`), not the
deployed `spartanshub.spartanrobotics.org`, because real local testing has
been finding and fixing genuine logic bugs in the Runner's Python that would
otherwise ship straight to production. All of that work lives on branch
`yuvan/fusion-arrange-fix`, tracked in
**[PR #311](https://github.com/frc971/spartanshub/pull/311)**, which stays
open (by direct instruction) until the pipeline works end to end - don't
merge it without checking its current comment thread first, per this repo's
own [CLAUDE.md](../../../../CLAUDE.md)/[CONTRIBUTING.md](../../../../CONTRIBUTING.md)
convention on reading a branch's PR before resuming work on it.

## Prerequisites (one-time, per machine)

1. **Fusion 360** installed, with this add-in placed at
   `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM/`
   (macOS) - see the repo root's `valor6800-autocam-runner-setup.md` for the
   full walkthrough, including the `.overridepath`/`requests`-package
   workaround Fusion's bundled Python needs (it has no third-party packages
   otherwise).
2. `autocam/fusion/runner/.env` (in the **live add-in folder**, not the
   repo checkout - Fusion loads from there) set to:
   ```
   BASE_URL="http://127.0.0.1:5173"
   API_KEY="<the local dev server's FUSION_RUNNER_TOKEN value>"
   RUNNER_ID="<a name for this machine>"
   ```
   See `autocam/fusion/runner/.env.example` for the full list of optional
   keys (`RUNNER_MACHINE_ID`, `FUSION_DATA_PROJECT_NAME`,
   `FUSION_DROP_FOLDER_PATH`).
3. After editing `.env`, fully **quit and relaunch Fusion** (not just
   Stop/Run the add-in) before testing a fix - this session found Stop/Run
   doesn't always reload changed Python reliably; a full relaunch does.

## Running a real job end to end

1. **Start the app's dev server** from the repo root:
   ```
   npm run dev -- --host 127.0.0.1 --port 5173
   ```
   This is what the Runner's `BASE_URL` above points at. Leave it running.
2. **Sync any Python changes to the live add-in.** Editing files under
   `autocam/fusion/runner/` in this repo checkout does nothing to Fusion by
   itself - Fusion only ever reads from the live AddIns folder. After any
   edit:
   ```
   LIVE="/Users/yuvan/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM"
   cp autocam/fusion/runner/<changed-file> "$LIVE/<same-relative-path>"
   find "$LIVE" -name "__pycache__" -type d -exec rm -rf {} +
   ```
   Clearing `__pycache__` is defensive, not confirmed necessary every time -
   but a stale `.pyc` has been a real suspect for a fix not taking effect
   even after a relaunch.
3. **Open the add-in in Fusion** (Scripts and Add-Ins > Add-Ins tab > Run) so
   it starts polling `/api/fusion-runner`.
4. **Queue a job.** Two ways:
   - **Through the UI** (`/autocam/fusion` - Parts, Plates, Job Queue tabs):
     add a Part (optionally with a STEP file and a "Fusion file name" so the
     saved Fusion document gets a readable name instead of the default
     `Plate<uuid>Job<uuid>`), add a Plate sized for your stock, nest the
     part onto it, then queue a `plate:cam` job against a machine/tool from
     the Plates tab.
   - **Scripted** (faster for repeat testing of the same plate size/material -
     this is how this session queued its test jobs). A one-off Node script
     using `@supabase/supabase-js` with the service key can replicate
     `src/lib/fusionCam.js`'s `createPart`/`createPlate`/
     `assignPartToPlate`/`queueFusionJob` calls directly: upload a STEP file
     to the `manufacturing-files` storage bucket, insert `fusion_parts` and
     `fusion_plates` rows, upsert a `fusion_part_category_assignments` row,
     then insert a `cam_jobs` row with
     `params: { fusionJobKind: 'plate:cam', plateId, boxTubeId: null }`.
     Run it from the repo root (`node script.mjs`, not elsewhere - Node
     resolves `node_modules` from its own directory) so `.env`'s
     `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` and the installed
     `@supabase/supabase-js` are both in scope. Known-good catalog rows from
     this project (reuse these IDs rather than looking them up each time):

     | What | Value |
     | --- | --- |
     | Aluminum 6061 (`cam_materials.id`) | `819af897-16d3-4f22-9e01-d0be32fd23ad` |
     | Aluminum 6061 @ 0.25" (`fusion_part_categories.id`) | `ec177f74-28e2-4edb-828c-bdd6b0002bba` |
     | 0.1575" 971 Main Bit (`cam_tools.id`) | `60ef32c0-d76d-4549-a4a6-3cf4a7aee115` |
     | UNC Router (`cam_machines.id`) | `517ba89c-7167-4415-b6fd-cfc7be1e59e1` |

     Delete the script when done - it's a throwaway testing tool, not
     something to commit.
5. **Watch Fusion's Text Commands console.** The Runner logs its own claim,
   setup, toolpath-generation, and post-process steps there - that's the
   primary debugging signal, along with whatever the job's `errors`/
   `warnings` columns end up holding in `cam_jobs`.

## What's confirmed working vs. still unverified (as of this doc)

Confirmed by real local runs, on branch `yuvan/fusion-arrange-fix`:
- `AutoArrange.py`'s single-plate envelope setup (`quantity`/`envelopeSpacing`
  API fixes).
- `templateTools.py`'s rest-machining fix - the first/largest pocket tool
  pass no longer comes out as an empty toolpath.
- `NewNCProgram.py`'s post-process retry wrapper and the `_format_tool_label`
  float-precision fix (no more `S15750000000000004Pocket`-style filenames).
- The tool-library duplicate-entry cleanup (`971-outside-plate.tools`).

**Not yet confirmed against a live Fusion run** - needs a real test before
trusting it on actual material:
- `SetupGenerator.py`'s WCS orientation change (Face/Edge picks instead of
  construction axes, fixture clearances, zeroed X/Y stock padding). Check
  the resulting Setup's WCS in Fusion, or the toolpath direction, before
  cutting real stock with it.

Known gap, not yet addressed: jobs have logged
`Template tool matches missing: [{'description': '', 'type': 'drill',
'diameter': 0.256}]` on every run so far. Harmless for parts with no holes
(nothing has needed that drill yet) but will matter for a part that does.

## Moving off local dev

Two things need to happen before pointing the Runner at the deployed Hub
instead of `127.0.0.1:5173`:
1. PR #311's fixes need to be confirmed working end to end on a real job (or
   several), then merged.
2. The GCP-admin-side setup in
   [#312](https://github.com/frc971/spartanshub/issues/312) needs doing -
   confirming/creating the `FUSION_RUNNER_TOKEN` Secret Manager secret and
   its IAM grant, then updating each physical Runner install's `.env` to
   point at `https://spartanshub.spartanrobotics.org` with the real deployed
   token. That issue has the exact commands.

[#309](https://github.com/frc971/spartanshub/issues/309) covers a related
but separate gap - Vision Scouting's own runner secret doesn't exist yet
either - not blocking for Fusion, but worth knowing about if you're in that
area of GCP anyway.
