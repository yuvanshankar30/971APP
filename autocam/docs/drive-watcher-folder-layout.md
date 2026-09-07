# Manufacturing folder architecture (Google Drive AutoCAM)

As-built reference for the Drive-triggered CAM pipeline. Supersedes any earlier
assumption of a single shared `cad` folder - the real setup has one `cad`
subfolder per router. See `drive-watcher-implementation.md` for the lower-level
module/API details; this doc covers the folder layout, routing, naming, and
operational questions (tool config, failure handling) end to end.

## Folder layout

```
<Shared Drive>/
  .../
    Cad/
      oldrouter/   -> drops here run on the ShopSabre router (WinCNC dialect)
      newrouter/   -> drops here run on the other router
    Cammed/
      2026-08-20/  -> everything delivered today, from EITHER router
      2026-08-21/
      ...
```

Local reference mockup at `~/Desktop/manufacturing/` mirrors this shape
(`Cad/oldrouter`, `Cad/newrouter`, `Cammed/<date>`) for visualizing the
structure without touching the real Shared Drive.

- **Two `cad` subfolders, one per router.** Each is a separate input-trigger
  folder mapped to its own `cam_machines` row (its own `drive_folder_id`).
  Dropping a CAD file in `oldrouter` queues (and for routing jobs,
  auto-generates) a job against the ShopSabre machine profile; dropping one in
  `newrouter` does the same against the other router's profile. No code
  changes were needed for this - `runDriveWatcherSweep` already sweeps every
  enabled machine with a `drive_folder_id` set, however many there are.
- **One shared `cammed` folder for both routers.** Both machine profiles are
  configured with the identical `drive_output_folder_id`. No code change here
  either - it's just two machine profiles pointing at the same output folder
  ID. Results are grouped by date inside it, not by router.

## Why output is grouped by date, not by router

Whoever is picking up finished G-code cares about "what's ready to cut today,"
not "what did the old router make vs. the new one" - the date folder is the
natural unit of work. Router identity is still preserved, just in the
**filename** instead of a separate folder tree (see below), so it doesn't get
lost.

## Filename convention

```
<machine-slug>_<part-slug>_<HHMMSS>_<job-id>.<ext>
```

Example: a "Gearbox Plate" cut on the ShopSabre router at 2:05:09pm Pacific
becomes `old-router-shopsabre_gearbox-plate_140509.ngc`, delivered into
`Cammed/2026-08-20/`.

- **Why the machine prefix**: since both routers deliver into the *same* dated
  folder, nothing else distinguishes their output. Two routers cutting a
  same-named part on the same day would otherwise produce ambiguous or
  literally colliding filenames - the whole point of routing a file to the
  correct physical machine (`oldrouter` vs `newrouter`) would be lost the
  moment it reached `Cammed`.
- **Why the time suffix**: cheap, stateless collision protection for the same
  machine re-running a same-named part on the same day (a re-cut, a
  correction) - no need to track a counter or list the folder first.
- **Why no date in the filename**: it's already the enclosing folder's name;
  repeating it would be redundant.
- The job-id suffix also prevents two same-name jobs that finish during the
  same second from colliding.
- Implemented as `driveDeliveryFileName(job, machine)` in `drive_watcher.js`,
  tested in `drive_watcher.test.js`.

## Tool/material/parameter configuration

There is no per-file configuration - a Drive-dropped file can't be asked any
questions. Every setting comes from the **machine profile** (`cam_machines`
row, edited in `/autocam` → Manage Profiles) that the file's `cad` subfolder
is mapped to:

- `default_material_id`, `default_tool_id`, `default_params` (step-down, feed
  rate, tool diameter/sequence, etc.) - the exact same param set used for a
  manual "New Job".
- Every file dropped in `oldrouter` uses the ShopSabre profile's settings;
  every file dropped in `newrouter` uses the other router's profile. Within
  one router's `cad` subfolder, there is currently no way to vary settings per
  part - if that's ever needed, it requires a further split (another
  subfolder + machine profile pair), not a code change to this pipeline.

## Turning vs. routing at the auto-trigger

Only **routing** jobs auto-generate G-code immediately. **Turning** jobs
queue as a draft and stop there - stock diameter is a real physical decision
(what's actually in the chuck) that can't be inferred from a STEP file, so a
human has to open the job in `/autocam`, set it, and click "Save &
Regenerate." If a `cad` subfolder is ever mapped to a lathe, dropped files
will need that manual follow-up step; they won't silently fail, they just
won't finish on their own.

## Failure handling

No Slack notification (removed 2026-08-20). Every failure is still caught
individually - one bad file can never take down the rest of a sweep - and
recorded:

- **Input-side** (a dropped file fails to queue/generate): logged in
  `drive_watcher_files` with `status='failed'` and the real error message.
- **Generation failure** (bad geometry, tool too small, sharp corner needing
  a fillet, etc.): the job itself ends up `status='failed'` with `errors`
  populated in `cam_jobs` - visible in `/autocam`'s jobs list with a **Retry**
  button, regardless of whether the job was Drive-triggered or manual.
- **Output-delivery failure** (upload to `cammed` itself fails): logged
  server-side (`console.error`); the job's own completion status is
  unaffected - delivery failure never un-completes a job.

There is currently no scheduled trigger for the input sweep - dropping a file
in `cad` does nothing until something calls `/api/drive-watcher` on a timer
(Cloud Scheduler or a Supabase `pg_cron` job, see the repo-root `README.md`
for setup). Output delivery needs no scheduler - it fires automatically on
every job completion.
