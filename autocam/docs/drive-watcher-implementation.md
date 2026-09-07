# Google Drive integration for AutoCAM — as built

Supersedes `drive-watcher-cron-plan.md` (the original pre-implementation design doc, kept for its reasoning/history) now that this is actually built. Covers both directions:
- **Input**: a STEP file dropped in a Drive folder auto-queues (and, for routing, auto-generates) a CAM job.
- **Output**: a completed job's G-code gets written back to a separate Drive folder, for a Drive desktop sync client on a machine's control PC to pick up with no manual download - see `autocam/docs/direct-machine-file-transfer-plan.md`.

**Status: code complete, safe to ship with zero configuration, genuinely untested against a real Google Drive folder** - this environment has no Google credentials. Treat the first real sweep/delivery against a real folder as unverified, same as every G-code file this app produces already carries a "run it in a simulator first" warning.

**See `autocam/docs/drive-watcher-folder-layout.md` for the actual folder layout this is built for** (two router-specific `cad` subfolders, one shared `cammed` output, the machine-prefixed filename convention) - this doc stays focused on the module/API mechanism, which is deliberately generic (any number of machines, each with their own input/output folder IDs) rather than hardcoding that specific layout.

## Architecture

All Google Drive logic lives in one module, `src/lib/server/drive_watcher.js`:
- `getServiceAccountAccessToken(serviceAccountJson)` (exported) - signs and exchanges a service-account JWT for a short-lived Drive API access token. Hand-rolled with Node's built-in `crypto` (RS256) + plain `fetch` - no `googleapis` npm dependency, matching the zero-dependency approach already used for DXF/offset math elsewhere in this CAM system.
- `runDriveWatcherSweep({ appOrigin })` (exported) - the input side. For every enabled `cam_machines` row with a `drive_folder_id`: walks the Drive Changes API from a persisted cursor, finds new `.step`/`.stp` files in that folder, downloads + sanity-checks each one (`ISO-10303` header, not a real parse - real validation happens inside `/api/cam-generate`), uploads it to the `manufacturing-files` storage bucket, inserts a `cam_jobs` row using that machine's `operation_type`/defaults, and (routing only) calls the existing `/api/cam-generate` endpoint via an internal HTTP request. Turning jobs land as a draft (`status='queued'`, generation never auto-fires) since stock diameter can't be guessed safely.
- `deliverJobToDrive(job, machine)` (exported) - the output side. If `machine.drive_output_folder_id` is set, uploads the job's finished G-code into a dated subfolder ("2026-08-20", Pacific time, created on first use each day and reused for the rest of that day - `findOrCreateDateFolder`/`todayDriveDateFolderName`) inside it, via a hand-rolled Drive API v3 multipart upload. Filename comes from `driveDeliveryFileName(job, machine)` - `<machine-slug>_<part-slug>_<HHMMSS>_<job-id>.<ext>`, not just the job's own gcode_file_name. The machine prefix identifies a shared output folder's source and the job suffix prevents same-second collisions. Called from `/api/cam-generate` right after any job (manual, batch, or Drive-triggered) reaches `status='completed'` - delivery is a property of the machine, not of how the job started.

Both directions share one OAuth scope: `https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file` - read access for input folders, file-scoped write access for output folders (only reaches folders explicitly shared with the service account, not blanket Drive access).

`src/routes/api/drive-watcher/+server.js` is the entry point for the input sweep: bearer-token gated (reuses `isAuthorizedCronRequest` from `cron_auth.js`, same mechanism the planner-notification cron endpoint uses), claims a `drive_watcher_sweep` lease via the existing `claim_runtime_lease`/`release_runtime_lease` RPCs so overlapping sweeps can't race, then calls `runDriveWatcherSweep()`. The output side has no separate endpoint - it's invoked in-process from `cam-generate`, not on its own schedule.

## Schema (`migrations/20260817_cam_studio_system.sql`, applied live)

- `cam_machines.drive_folder_id text` - input folder, null = auto-trigger disabled for this machine.
- `cam_machines.drive_output_folder_id text` - output folder, null = no auto-delivery for this machine. Deliberately separate from the input folder so the watcher never mistakes its own output for a new STEP file.
- `drive_watcher_state(folder_id text primary key, page_token text, updated_at)` - the Changes API's resumable cursor per folder.
- `drive_watcher_files(drive_file_id text primary key, cam_job_id uuid, processed_at, status, error)` - atomic `processing` reservation plus idempotency/audit trail so two sweeps cannot queue the same file, and failures are visible.
- Both new tables have RLS: `service_role` full access, `authenticated` + `approved_user()` read - same pattern as every other `cam_*` table.

## Setup (nothing here is done yet - no Google credentials exist in this environment)

1. **Google Cloud**: create/reuse a project, enable the Drive API, create a service account, generate a JSON key, note its email address.
2. **Share folders** with that service account email: input folders as Viewer, output folders as Editor.
3. **Vercel**: add `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` (the entire JSON key file's contents) as an environment variable, redeploy.
4. **`/autocam` → Manage Profiles**: paste each folder's ID (the trailing segment of its Drive URL) into the machine's "Drive Auto-Trigger Folder ID" / "Drive Delivery Folder ID" fields - these should be the actual "cad" and "cammed" subfolders' own IDs (whatever they're named doesn't matter to the code; only the ID does), not a parent folder to search within.
5. **On the machine's control PC** (output delivery only): install Google Drive's desktop sync client, point it at the output folder, so the uploaded file appears locally with no manual step.

## What's still explicitly not done

**The input sweep has nothing to trigger it.** `/api/drive-watcher` exists and works once called, but no scheduler calls it yet - deliberately not set up, since wiring `pg_cron`/`pg_net`/Supabase Vault secrets against a service account that didn't exist yet would've been dead configuration. Once steps 1-4 above are done, the remaining piece (from the original plan doc, not yet applied):
```sql
-- Vault secrets: drive_watcher_app_url, drive_watcher_cron_token
CREATE OR REPLACE FUNCTION public.invoke_drive_watcher_cron() ... -- near-identical to invoke_planner_notification_cron()
SELECT cron.schedule('drive-watcher-sweep', '*/5 * * * *', 'SELECT public.invoke_drive_watcher_cron();');
```
Sweep interval (`*/5 * * * *` above) is a starting guess, not a measured choice - see the original plan's open question #2.

**Output delivery needs no scheduler** - it fires automatically the moment steps 1-4 are done, on every job completion, no cron piece required.

**A possible GCP-native alternative to the pg_cron trigger**: instead of Supabase `pg_cron`/`pg_net`/Vault, a **Google Cloud Scheduler** job could hit `/api/drive-watcher` directly on a timer with the same bearer token - lighter weight than standing up Cloud Run/Cloud Build for this, since the endpoint itself already runs fine on the existing Vercel deployment. Worth revisiting if/when this project's Supabase-vs-Google-Cloud direction firms up.

## Failure visibility

No Slack notification (removed 2026-08-20 - was posting to `971bot.js`'s approver-DM channel, prefixed `[Drive Watcher]`). Every per-file/per-job failure is still caught individually (one bad file can't take down the rest of a sweep) and still recorded: input-side failures land in `drive_watcher_files` with a real error message, output-delivery failures are logged server-side (`console.error`) and the job itself already carries its own `status`/`errors` from `/api/cam-generate` regardless of how it was queued - check either of those for what went wrong.

## Testing performed (and what could not be)

- Unit-tested `deliverJobToDrive`'s no-op paths (null machine, no output folder configured, no service account key configured, malformed input) - all confirmed to return a clear skip reason and never throw.
- Confirmed the whole app still builds and the full test suite (147 tests) still passes with both new files added.
- **Not tested**: any real call to the Drive API (Changes API, file download, multipart upload) - no credentials exist in this environment to do so. The JWT-signing and multipart-body-construction code has not been exercised against Google's real endpoints.
