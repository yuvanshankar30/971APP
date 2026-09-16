# Scouting Vision — implementation reference

> **This file is "where is the code and what does it do."** For what is still
> missing before the system is usable — split by whether a human, hardware, or
> more code is required — see
> [`scoutingvision-remaining-work.md`](../plans/scoutingvision-remaining-work.md).
> Keep both current; neither is allowed to go stale (see `../CONTRIBUTING.md`).

A post-match computer-vision pipeline that watches match video, combines
full-BF16 Qwen3-VL semantic review with deterministic YOLO/classical CV, and
cross-checks the result against The Blue Alliance's official match
breakdown. It's **Vision Scouting** in the Competition nav folder, open to
every approved team member — same as Pit/Data/Note Scouting, no special
permission required just to see or use it. Its output never *silently*
feeds `scout_data_events` or power rankings, though: a separate
`VISION_RELEASE` permission is required to explicitly push a completed
run's results into real scouting data (see **Reviewed-result release
bridge** below) - that's the one part of this feature that stays gated,
since it's a meaningfully higher-stakes action than just using the tool.
This doc is a file-by-file map of what's actually
implemented, for anyone picking the feature up. For the design rationale and
contracts (capture requirements, review states, model acceptance gates), see
`implementations/vision-scouting-system.md` — this file focuses on "where is
the code and what does it do."

## End-to-end data flow

1. A reviewer opens `/scouting/vision`, creates a `vision_matches` row for an
   `event_key` + `match_key`, and uploads one or more synchronized camera
   recordings as `vision_views` (each with a label, camera position, ms sync
   offset, and optional 3×3 image→field homography).
2. The reviewer queues a `vision_runs` job naming a model name/version and
   config (confidence floor, optional `identity_map`).
3. A separate GPU worker (`vision/runner/vision_runner.py`) polls
   `api/vision-runner`, claims the run, downloads each view via a signed URL,
   runs YOLO detection + tracking, sends bounded frame sequences to the
   authenticated DGX Spark Qwen service, and reports back `vision_tracks`
   (per-robot trajectories) and `vision_observations` (fuel/climb/mobility
   events) to `complete`.
4. The server keeps deterministic and Qwen summaries separate, flags
   material Qwen-vs-pipeline differences, fuses multi-camera observations
   (`fuseObservations`), summarizes them per team/alliance
   (`summarizeVision`), fetches the official TBA match breakdown
   (`fetchTbaMatchReference`), and diffs the two (`reconcileWithReference`).
   Material differences become `vision_discrepancies`.
5. A reviewer works the discrepancy queue in the UI, resolving each as
   `accepted_vision`, `accepted_reference`, `corrected`, `unobservable`, or
   `dismissed`. Raw vision results are never overwritten by a review — only
   the resolution record is added alongside them.

## Database

Eleven SQL files, all applied in production as of September 15, 2026.

Three of them are hardening rather than schema:

- `20260829_vision_rls_approved_user.sql` — every Vision table and the
  recordings bucket originally used `USING (true) WITH CHECK (true)`, which
  means every *authenticated* session, including accounts pending approval and
  banned accounts. The UI gated them out but RLS is what protects a direct
  anon-key client. All 10 tables and the storage bucket are now
  `public.approved_user()` (admin or `CAN_SEE_ROUTES`), matching every sibling
  scouting table.
- `20260829_vision_release_atomic.sql` — `release_vision_run()`, which does the
  `scout_data_events` insert, the `released_at` claim and the audit row in one
  transaction, with a compare-and-swap so concurrent releases can't double a
  match's events. See **Reviewed-result release bridge**.
- `20260829_vision_recording_retention.sql` — `vision_views.recording_deleted_at`,
  for the opt-in retention sweep.
- `20260829_vision_start_zones.sql` — `vision_views.start_zones`, the named
  auto starting regions that let vision report `auto_start_position` at all.
- `20260829_vision_match_roster.sql` — `vision_matches.team_roster`, the six
  teams in the match cached from TBA, which constrains identity assignment.
- `20260915_vision_function_execute_grants.sql` — removes PostgreSQL's default
  public `EXECUTE` grant from the two Vision `SECURITY DEFINER` functions.
  Only `service_role` may invoke `release_vision_run`; the database owner runs
  the cron invoker.

### `migrations/20260828_vision_system.sql`

Seven tables, all with RLS enabled:

| Table | Purpose |
|---|---|
| `vision_matches` | One row per event+match being reviewed. `status`: `draft → queued → processing → review → complete/failed`. |
| `vision_views` | One row per uploaded camera recording for a match: storage path, camera position, frame rate/dimensions, sync offset, homography + calibration points. |
| `vision_runs` | One row per model-processing attempt on a match. Immutable `model_name`/`model_version`/`config`; `status`: `queued → claimed → processing → complete/failed/cancelled`. |
| `vision_tracks` | Per-robot trajectory output from one run: alliance, start/end ms, identity + tracking confidence, raw `trajectory` points, derived `metrics` (see analytics below), `needs_review` flag. |
| `vision_observations` | Discrete detected events (`fuel_attempt`, `fuel_scored`, `climb_attempt`, `climb_success`, `mobility`, `disabled`, `identity`) with a JSON `value`, confidence, and `evidence` for audit. `climb_*` evidence is a YOLO frame/box; `fuel_scored` evidence is the classical-CV goal zone label + trajectory length (see **Hybrid game-piece detection** below - fuel isn't a YOLO detection). |
| `vision_discrepancies` | Vision-vs-TBA mismatches queued for human review, with severity (`info`/`warning`/`critical`) and a resolution workflow. |
| `vision_reference_snapshots` | The TBA match breakdown captured at analysis time, so later re-review doesn't depend on TBA's API still returning the same shape. |

Also creates a private `vision-recordings` storage bucket (`public: false`).

Access control is RLS-driven, applied via a `DO $$ ... FOREACH $$` loop over
all seven tables:
- `authenticated` role: full access gated on `public.approved_user()` — any
  *approved* team member can use Vision Scouting, same as the rest of
  Competition, with no extra permission needed. (This originally shipped as
  `USING (true)`, which also let pending and banned accounts through via a
  direct anon-key client; tightened in
  `20260829_vision_rls_approved_user.sql`.)
- `service_role`: unrestricted (`USING (true)`) — this is what the runner's
  server-side Supabase client uses.
- The storage bucket gets a matching `approved_user()` policy - private in the
  sense of "not directly browsable, signed URLs only," not "hidden from
  teammates."

### `migrations/20260829_vision_notifications_release_fleet.sql`

Three additions on top of the above:

- **`user_profiles.vision_notify` boolean** (default `false`) — the Slack
  alert opt-in list (see **Slack alerting** below). Seeded `true` for Yuvan
  Shankar and Arin Rao by a best-effort `full_name ILIKE` match (free text,
  not a real FK — same "skip gracefully if it doesn't match" stance already
  used for `parts.requester` elsewhere in this codebase).
- **`vision_runs.released_at` / `released_by`** plus a new
  **`vision_release_log`** table (`vision_run_id`, `released_by`,
  `scout_data_event_ids uuid[]`, `team_count`) — the audit trail for the
  release bridge. Original vision evidence is never mutated by a release;
  this just records what was produced and by whom.
- **`vision_runners`** table (`runner_id` primary key, `last_seen_at`,
  `model_path`, `current_run_id`, `last_error`) — runner fleet heartbeats.

Both new tables are SELECT-only for `authenticated` (gated on
`approved_user()` - read for the dashboard, same stance as the rest of Vision
Scouting); all writes go through `service_role` (the runner's own heartbeat
call, and the release bridge's privileged insert — see below).

### `migrations/20260829_vision_field_mask_goal_zones.sql`

Two more columns on `vision_views` (no new tables, no new RLS - already
covered by the table's existing policy from the first migration):

- **`field_mask` jsonb** — a normalized (0-1) ROI polygon; detections
  outside it (audience, pit area) are discarded before either detector runs.
- **`goal_zones` jsonb** (default `[]`) — array of `{label, alliance,
  polygon}`; where a scored game piece's trajectory is expected to end. See
  **Hybrid game-piece detection** under the runner section below.

### `migrations/20260829_vision_qwen30b_dgx.sql`

Adds immutable Qwen model identity to runs, Qwen health/runtime fields to
runner heartbeats, mandatory observation review state/reviewer timestamps,
and `vision_qwen_clips`. The clip table retains normalized and raw output even
when Qwen proposes zero events, so absence remains auditable. Only accepted
or corrected observations are eligible for release.

## Backend

### Analytics engine — `src/lib/visionAnalytics.js`

Pure functions, framework-agnostic, unit-tested in `visionAnalytics.test.js`:

- `trajectoryMetrics(points, { minConfidence })` — turns a raw list of
  `{t, x, y, confidence}` points into distance traveled, median/P90/max
  speed, mean acceleration, P90 turn rate, and moving/stationary time. Drops
  low-confidence points and any gap > 1 second between samples (so a
  tracking dropout doesn't get counted as a teleport).
- `fuseObservations(observations, { dedupeWindowMs = 350 })` — merges the
  same real-world event seen by multiple camera views: two observations of
  the same type/team/alliance within 350ms are collapsed into one, keeping
  the higher-confidence detection and recording every contributing view.
  Deliberately does *not* merge simultaneous red and blue events, even if
  otherwise similar.
- `summarizeVision(observations, tracks)` — fuses observations, then rolls
  fuel/climb counts and best-coverage mobility metrics up per team and per
  alliance (for teams whose identity isn't resolved yet).
- `reconcileWithReference(summary, reference, thresholds)` — diffs a vision
  summary against a TBA reference. Fuel: flagged only if the difference is
  *both* > 3 (absolute, default) *and* > 15% (relative, default) — a
  deliberately conjunctive threshold so a single miscounted ball doesn't spam
  the review queue. Climb count: any disagreement is `critical`, since it's a
  binary and TBA's number is authoritative.

### TBA reference parsing — `src/lib/server/vision_reference.js`

`referenceFromTbaMatch(match)` reshapes a raw TBA `/match/{key}` API response
into `{ matchKey, alliances: { red, blue } }`, each with team keys, total
score, a best-effort extracted fuel count, and a climb count. Field names
aren't standardized across TBA game years, so fuel/climb extraction tries a
short list of known key names first (`fuelPoints`, `totalFuelPoints`, …),
then falls back to a regex scan of the breakdown object
(`firstMatchingFinite`) rather than hardcoding one season's schema.
`fetchTbaMatchReference(matchKey, authKey, fetchImpl)` wraps this with the
actual HTTP call; `fetchImpl` is injectable for testing.

### User-facing API — `src/routes/api/vision/+server.js`

Auth: per-request Supabase client built from the caller's own `Authorization`
header (`clientFor`), so every query goes through RLS as that user — the
route itself does no permission check beyond "is there a logged-in user"
(matching the open-to-everyone RLS above). The one exception is `release-run`
below, which adds its own explicit `VISION_RELEASE` check.

- `GET` (no `id`): lists all `vision_matches` with view/run counts.
- `GET ?id=`: full detail for one match — views (with freshly
  signed 15-minute playback URLs), runs, and (for the latest or a specified
  `run_id`) tracks/observations/discrepancies/Qwen clip audit records.
- `GET ?dashboard=<event_key>`: event-level rollup — matches
  total/complete, run counts by status (+ how many are released), open vs.
  resolved discrepancy counts (with an `open_critical` breakout), the
  current queue depth, and the runner fleet (see **Runner fleet visibility**
  below). Powers `src/routes/scouting/vision/dashboard/+page.svelte`.
- `POST` actions:
  - `create-match` — new `vision_matches` row.
  - `add-view` — inserts the `vision_views` row (storage path is
    `event_key/match_key/<uuid>-<sanitized filename>`) and returns a signed
    *upload* URL the client uploads the raw file to directly.
  - `queue-run` — requires at least one view and a pinned model identity,
    evaluates runner/roster/calibration readiness, and requires an explicit
    acknowledgement before incomplete inputs can be queued as a shadow run;
    inserts a `vision_runs` row and flips the match to `queued`.
  - `review` — resolves a discrepancy (one of the 5 allowed statuses),
    stamping reviewer id and timestamp.
  - `update-track` / `update-observation` — human correction of a track's
    team identity or an observation's team/value/confidence. `update-track`
    also cascades the team down to that track's unreviewed observations (see
    **How identity actually reaches released data**) and reports how many it
    touched as `attributed_observations`.
  - `review-observation` — accepts, corrects, rejects, or marks an individual
    model observation unobservable. Release ignores unreviewed/rejected rows.
  - `review-observations` — the same verdicts applied to up to 500 ids at
    once, for clearing a match's worth of proposals without a click per row.
    Deliberately excludes `corrected`, which needs a per-row value and team.
  - `preview-release` — permission-gated, read-only construction of the exact
    `scout_data_events` rows a completed run would release, including skipped
    climb values. The review UI requires this before enabling release and
    sends the preview rows back so the server can reject a stale preview.
  - `cancel-run` — abandons a `queued`/`claimed`/`processing` run. A runner
    that crashes mid-job otherwise leaves the run wedged forever, since only
    the worker actively holding a run ever terminates it. The status filter is
    a compare-and-swap, so a run that just completed can't be stomped back to
    cancelled (409 instead).
  - `retry-run` — re-queues a `failed`/`cancelled` run's match as a *new* run
    rather than resetting the old one: model identity and config are immutable
    per run by design, and the failed attempt stays on the record.
  - `refresh-roster` — re-caches the match's six teams from TBA. Schedules
    change, and a match created without a TBA key has an empty roster.
  - `update-view` — saves calibration (field mask, goal zones, start zones,
    homography, sync offset) onto an already-uploaded view. Separate from `add-view`
    because calibration is drawn against the recording itself, which can't
    happen until the file exists.
  - `release-run` — the reviewed-result release bridge; see its own section
    below.

### Runner-facing API — `src/routes/api/vision-runner/+server.js`

Separate endpoint, separate auth: a shared-secret bearer token
(`VISION_RUNNER_TOKEN`) checked with a constant-time comparison
(`checkToken`, XOR-accumulate over `TextEncoder` bytes) rather than `===`, to
avoid a timing side-channel on the token value. This is a machine-to-machine
credential for the GPU worker (which also needs `service_role` DB access to
write tracks/observations) - unrelated to whether a human teammate needs a
permission to use the feature; they don't.

- `heartbeat` — upserts `vision_runners` with the runner's id, current run,
  tracker path, Qwen identity/endpoint/health metrics, and last error.
- `claim` — atomically claims the oldest of up to 5 queued runs
  (`update ... eq('status','queued')` as the compare-and-swap so two runners
  can't double-claim), returns the run plus every view with a freshly signed
  1-hour download URL.
- `processing` — marks a claimed run as started; 409s if it wasn't in
  `claimed` state.
- `complete` — accepts tracks/observations plus immutable Qwen clip records,
  keeps Qwen and deterministic summaries separate, runs TBA reconciliation
  and Qwen-vs-pipeline reconciliation, persists
  any discrepancies and a reference snapshot, flips the match to `review`
  (if discrepancies exist) or `complete`, and fires a Slack alert (see
  below) for every newly inserted `critical` discrepancy.
- `fail` — marks a claimed/processing run `failed` with an error message
  (only if a row actually transitioned - a no-op CAS never alerts) and fires
  a Slack alert. Every claimed run must terminate through `complete` or
  `fail` — same invariant the AutoCAM Fusion runner uses.

## Recording retention — `api/notifications/vision-recording-retention`

Match video is by far the largest thing this feature stores and nothing ever
removed it, so an event's worth of multi-camera recordings grew without bound.
This sweep reclaims the video files and nothing else: the view row, its tracks,
observations, discrepancies and the release audit trail all stay, so a released
scouting number keeps its provenance after the video behind it is gone.

The decision of what may be deleted lives in `src/lib/server/vision_retention.js`,
kept pure and separately unit-tested because it decides what gets permanently
destroyed. Three deliberate constraints:

- **Opt-in.** With `VISION_RECORDING_RETENTION_DAYS` unset, nothing is ever
  deleted. There is no defensible default number of days to guess on a team's
  behalf.
- **Released runs only.** Video is the evidence behind a reviewer's decision;
  a run that was never released means that work is unfinished or was rejected,
  and either way the footage still matters.
- **Measured from the most recent release**, not the first — a re-release means
  someone was still working with that match.

Like the stale-runner sweep it **fails closed** without a cron secret (see
below), which matters more here because this one deletes files.

## Slack alerting

`src/lib/server/slack_notifications.js` adds `notifyVisionRunFailed(runId)`,
`notifyVisionCriticalDiscrepancy(discrepancyId)` and
`sendVisionRunnerHealthAlerts()`, all following the same
`dispatchNotification` pattern every other Slack DM in this app uses
(per-notification-type opt-out via `user_profiles.notification_settings`,
automatic dedup via `user_notification_logs`). What's different from every
other notification category here: the recipient list isn't role-derived
(there's no "Vision Lead" role) - it's an explicit, admin-managed opt-in list
(`user_profiles.vision_notify`), deliberately separate from who can *use* the
feature (everyone) - alerting is opt-in regardless, the same way match
reminders or task assignments are, not a permission gate.
`NOTIFICATION_KEYS.VISION_ALERT` covers all
trigger conditions (run failure, new critical discrepancy, runner outage)
under one category rather than splitting them - to a recipient, they all mean
the same thing: "go look at Vision Scouting."

**Runner outages** are the third trigger, and the only scheduled one. A
runner that can't reach its Qwen service stops claiming work entirely and
records that nowhere but its own `vision_runners` row, so queued runs would
otherwise sit unprocessed with nobody told. `sendVisionRunnerHealthAlerts()`
is driven by a `pg_cron` sweep every 5 minutes via
`api/notifications/vision-stale-runners` (cron-gated by the same
`cron_auth.js` token as the other notification sweeps, reusing the existing
`planner_notifications_*` vault secrets rather than provisioning a new one).

Both Vision cron endpoints **fail closed**: `isAuthorizedCronRequest()` is
deliberately fail-open — it accepts any request when no cron secret is
configured — and `CRON_NOTIFICATION_TOKEN` is currently commented out of
`cloudbuild.yaml` (issue #5), so inheriting that default would have put new
unauthenticated routes on the live service. With no secret set they return 503
and do nothing. A health sweep that doesn't run beats an open endpoint, and
refusing loudly is what gets the secret configured. Remove those guards once
issue #5 is closed.
`visionRunnerAlert(runner, now)` holds the decision and is unit-tested
separately in `src/lib/server/vision_runner_health.test.js`; it fires for a
runner silent past 15 minutes, or one that is heartbeating but reporting
`runtime_metrics.qwen.ready === false`. The 15-minute threshold is
deliberately far above the dashboard's 60s *online* cutoff: that one means
"responding right now", this one only trips for an outage nobody could
mistake for a slow iteration. The entity key embeds `last_seen_at`, which is
frozen while a runner is down, so one continuous outage alerts exactly once
while a later, separate outage alerts again.

**Admin UI** (`src/routes/admin/+page.svelte`): a "Vision Alerts" checkbox
sits next to the existing manufacturing-workflow notify checkboxes in the
Notifications column, writing `vision_notify` through the same
`update-roles` API path `manufacturing_lead_workflows` already uses. Yuvan
Shankar and Arin Rao are seeded in via the migration (see above); anyone else
needs an admin to check the box.

**`VISION_RELEASE`** (the release-into-real-scouting-data permission, not
general access - see below) is a separate concept from alerting and is
granted via its own checkbox in the same admin page's Permissions column - a
real entry in `src/lib/permissions.js`'s `PERMISSIONS` array (not
role-derived), written through the generic `permissions[]` update path
`api/admin/+server.js` already exposed.

## Reviewed-result release bridge

`POST api/vision { action: 'release-run', run_id }` is the "actual payoff"
path: it turns one completed run's advisory output into real
`scout_data_events` rows, so a released match's vision-derived fuel/climb
counts count toward power rankings like any human-scouted match would.

Guardrails, in order:
1. Requires `VISION_RELEASE` specifically (checked against the caller's own
   `user_profiles.permissions`/`role`, via the caller's own RLS-scoped
   client) - just being able to use Vision Scouting (everyone) is not
   enough for this one action.
2. The run must be `status: 'complete'` and not already released
   (`released_at IS NULL`) - a release is a one-time, explicit action, not
   re-runnable. The read here is only an early bail-out; the *authoritative*
   check is a compare-and-swap inside `release_vision_run()`, because two
   concurrent callers could otherwise both pass this read before either
   wrote, and double every event for the match.
3. Once authorized, the actual write uses a `service_role` client
   (`getSupabase()`), because `scout_data_events` INSERT is RLS-gated on
   `DATA_SCOUT_ADMIN`/`DATA_SCOUT_MEMBER` - permissions a vision releaser
   has no reason to also hold. The `VISION_RELEASE` check above is the real
   gate; the service client is just how the already-authorized write
   actually lands, the same "app-level permission check, then a privileged
   write" shape `notifyManufacturingRequestById` and friends already use.
4. Per team in the run's fused `summarizeVision()` output:
   - Fuel count (if any observation resolved fuel for that team) becomes one
     `hub_fuel_override` event - a single authoritative count rather than
     emulating individual taps, matching what that event type already means
     in `src/lib/scoutingStats.js`.
   - Climb (`team.climb`) becomes a `climb_pos` event **only** if it's
     exactly one of the real enum values (`N/A`/`Failed`/`L1`/`L2`/`L3`),
     rather than being written as garbage into a column power-ranking
     aggregation depends on. Anything else is refused *and reported* — the
     response carries `skipped_climbs` and the UI names the count, because a
     silent refusal made a release look successful while a team's climb
     quietly never landed.

     Two things now make that path actually reachable. The run config carries
     a **Default climb level** (a real select on the queue-run form, defaulting
     to `L1`); without it `value.level` is null, `summarizeVision` falls back
     to the literal `'success'`, and *every* climb is refused. And Qwen is
     told the exact vocabulary in `TASK_PROMPT`, with `normalize_result`
     dropping any `climb_level` outside `ALLOWED_CLIMB_LEVELS` back to null so
     an invented wording falls through to that default instead of being
     carried to release and rejected there.
   - **`auto_climb_pos`** for a climb whose phase is `auto`. The runner has
     always stamped each observation's phase; the release used to discard it
     and file every climb as teleop.
   - **`dead_auto`** (`"true"`/`"false"`) from the robot's measured
     displacement during the auto window. Deliberately absent, rather than
     `false`, when the robot was never seen in auto — "we didn't see it" and
     "we saw it do nothing" are different claims and only the second is worth
     releasing. Any view that saw movement overrules a view that lost the
     robot behind a truss.
   - **`auto_start_position`** from the named start zone the robot was sitting
     in when auto began (see **Calibration UI**). Omitted entirely when no
     start zones are calibrated for that view, rather than guessed.
   - Alliance-only observations (no resolved `team_key`) are never released
     as a specific team's data.
   - Every released row is tagged `role: 'vision'`, so released rows stay
     identifiable/filterable in `scout_data_events` after the fact, on top
     of the `vision_release_log` audit row.
5. If nothing is attributable yet (no track/observation has a resolved team
   identity), the release is rejected outright rather than silently doing
   nothing.
6. The write itself is a single call to `release_vision_run()`
   (`20260829_vision_release_atomic.sql`), which claims the run, inserts the
   `scout_data_events` rows, and writes the `vision_release_log` entry in one
   transaction. This was three separate REST calls originally, which meant a
   failure between them could leave real scouting data with no release state
   and no provenance — invisible vision-authored rows nothing recorded the
   origin of. Rows are computed and validated in JS and passed in already
   vetted; the function's only job is to write all of them or none.

UI: a "Release to scouting data" button appears per run on
`/scouting/vision` once it's complete and unreleased, gated client-side on
`hasPermission(user, 'VISION_RELEASE')` (the server enforces this
regardless - the client check is purely to not show a button that would
just 403). A confirm dialog warns it can't be undone before the request
fires.

## Runner fleet visibility

`vision_runner.py`'s poll loop now calls a `heartbeat` action every
iteration - whether or not it actually claims a job - reporting its
`runner_id`, `model_path`, current `run_id` (if any), and last error.
Heartbeat failures are swallowed (`except Exception: pass`): a status ping
must never be able to take down the actual processing loop.

The dashboard (`GET ?dashboard=`) reads `vision_runners` and marks a runner
"online" if its last heartbeat is within `RUNNER_ONLINE_THRESHOLD_MS`
(60s - a generous multiple of the runner's own 10s default poll interval,
so one slow iteration - a big download, a busy GPU - doesn't flap a healthy
runner offline). This makes a dead runner visible directly instead of only
inferable from "the queue stopped draining."

## Frontend — `src/routes/scouting/vision/+page.svelte`

Single-page app, not code-split into sub-routes. Left sidebar: create a new
match, pick from the list of existing ones (status + view count shown
inline). Right pane, once a match is selected:

1. **Camera views** — inline `<video>` playback per uploaded view (signed
   URL from the detail fetch), plus an upload form (label, position, sync
   offset, optional homography JSON, field mask JSON, goal zones JSON, file
   picker). Upload flow calls `add-view` for a signed upload URL, then
   uploads directly to Supabase Storage via
   `supabase.storage...uploadToSignedUrl` — the raw video never transits the
   SvelteKit server. Field mask/goal zones are plain JSON textareas for now
   (no visual polygon-drawing tuner - see the runner section's calibration
   note).
2. **ML processing** — queue a run by name/version/confidence floor, plus a
   collapsed "Hybrid game-piece detection tuning" section (HSV lower/upper,
   min area, min circularity - all optional, fall back to the runner's
   defaults if left blank); lists past runs with status (and error, if
   failed).
3. **Robot tracks & mobility** (once a run has tracks) — editable team-key
   field per track (writes back via `update-track`), plus derived distance /
   P90 speed / turn rate.
4. **Detected actions** (once a run has observations) — source-labelled
   event list with attribution, timestamp, confidence, editable team/value,
   and accept/correct/reject/unobservable review controls.
5. **Qwen clip audit** — model revision, clip interval, quality, proposal
   count, latency, and review notes, including zero-event clips.
6. **Human review** — the discrepancy queue: metric, severity badge, vision
   vs. TBA values, a notes field, and one-click resolution buttons for each
   of the 5 outcomes.

Each run in the "ML processing" list also shows a **Release to scouting
data** button (complete + unreleased + `VISION_RELEASE` only) or a
`released` tag once it's been pushed - see **Reviewed-result release
bridge** above.

The page's own header links to the event dashboard (below).

### Event dashboard — `src/routes/scouting/vision/dashboard/+page.svelte`

A separate page (linked from the main Vision Scouting header) that answers
"how's this event going" without clicking through matches one at a time:
stat tiles for matches complete/total, runs by status (+ released count),
open discrepancies (with a critical count called out), and current queue
depth, plus a runner fleet table (online/offline, last-seen age, current run,
model path, last error). Takes an `event_key` via `?event_key=` or a manual
input; defaults to the active scouting event.

## External ML runner — `vision/runner/`

`vision_runner.py`: a standalone Python polling loop (no web framework) —
`heartbeat` (every iteration) → `claim` → `processing` → `process_view` per
camera → `complete`/`fail`, using `requests` against `api/vision-runner`.

The pipeline is **hybrid**, adapted from community R&D shared on Chief
Delphi ("Computer Vision Scouting",
chiefdelphi.com/t/computer-vision-scouting/511642 - see
`implementations/vision-scouting-system.md` for the full rationale). Two
different detectors run per frame, because the best tool differs by problem:

- **Robots** — Ultralytics `YOLO(...).track(..., persist=True)` (detection +
  ByteTrack-style cross-frame tracking). `robot_red`/`robot_blue` boxes with
  a tracker id become trajectory points (`field_point` applies the view's
  homography via `cv2.perspectiveTransform` if one was calibrated, otherwise
  passes through raw pixel coordinates and marks them `calibrated: false`).
  `climb_attempt`/`climb_success` boxes become `vision_observations`
  directly, same as before.
- **Game pieces (fuel)** — classical CV, *not* a YOLO class:
  `detect_game_pieces` (HSV threshold → contour → area/circularity filter,
  masked to the view's field mask if calibrated) finds piece candidates each
  frame; `PieceTracker` associates them into trajectories via gated
  nearest-neighbor matching; `attribute_scores` treats a trajectory ending
  inside a calibrated goal zone as scored, and attributes it to whichever
  robot track was closest to the trajectory's *origin* point (where the
  piece left the shooter), not whichever robot is nearest the goal itself.
  Any `fuel_scored` boxes from legacy weights are explicitly ignored rather
  than double-counted alongside this pipeline.
- **`RobotReId`** — recovers a robot's tracked identity across a brief
  occlusion (blocked by a game piece or another robot) instead of minting a
  new track id for the same physical robot. A candidate recovery needs both
  signals to agree: the lost track's last known velocity projects to
  roughly where the new detection is, *and* the new detection's bumper-
  region color histogram (`bumper_histogram` - HSV hue+saturation of the
  box's bottom third, ignoring brightness) is similar enough to the lost
  track's. Position alone is ambiguous with several same-alliance robots
  nearby; this file's own smoke tests (see below) confirm a same-position,
  different-looking robot is correctly rejected rather than merged.

### Match roster — constraining who a track can be

`vision_matches.team_roster` caches the six teams in the match from TBA (the
same payload `fetchTbaMatchReference` already reads), populated on
`create-match` and refreshable. The identity editor uses it to offer the three
teams on that track's alliance as a dropdown instead of a free-text box, which
is what every established FRC scouting app does with the match schedule and
removes the typo/wrong-alliance class of error entirely. With no roster cached
— no TBA key, offline venue, a match TBA doesn't know yet — it falls back to
free text rather than blocking review.

The roster also gives a free quality signal: six robots play a match, so a run
producing materially more tracks split a robot across an occlusion, and fewer
means one was never picked up. The UI says so before anyone starts assigning
identities.

Team identity is never inferred from alliance color — a track only gets a
`team_key` if the run's `config.identity_map` (an audited
`"<view id>:<tracker id>": "frcNNNN"` mapping) contains an entry for it;
otherwise `needs_review: true`. No model weights are committed to the repo —
`VISION_MODEL_PATH` must point to a locally trained/versioned `.pt` file (see
training pipeline below).

### How identity actually reaches released data

`identity_map` is keyed by tracker IDs that don't exist until a run has
finished, so on a first run it is necessarily empty and nothing is
attributed. Naming robots afterwards, in review, is the real path — and it
works because every observation is linked to the track that produced it:

1. `process_view` gives each robot track a run-scoped `track_key`
   (`"<view id>:<tracker id>"`) and every observation it derives carries the
   `track_key` of the robot it was attributed to. All three sources
   participate: classical-CV fuel via trajectory origin, YOLO climbs via
   `attribute_climbs`, and Qwen events via `attribute_qwen_event`.
2. The `complete` handler inserts tracks first, then rewrites each
   observation's `track_key` into the real `vision_observations.track_id`
   FK. `track_key` is a wire-only field and never reaches the database.
3. `update-track` — the identity editor — cascades the assigned `team_key`
   to that track's still-`unreviewed` observations. Already-reviewed rows are
   left alone, because a human decision outranks a later bulk re-attribution.

That chain is what makes naming one robot attribute all of its events at
once. Before it existed, `track_id` was an unpopulated column,
`summarizeVision` read team identity only off observations, and a carefully
identified track released nothing — the only working path was correcting
every observation by hand.

## Qwen service — `vision/qwen/`

`qwen_service.py` loads the full BF16
`Qwen/Qwen3-VL-30B-A3B-Instruct` checkpoint once on DGX Spark and serves
authenticated, single-concurrency `/analyze` requests. The runner samples
2–8 timestamped JPEGs from each bounded clip; Qwen never receives an
unbounded match context. `qwen_contract.py` parses and clamps its JSON before
anything reaches Supabase. Qwen and deterministic summaries are compared,
not blindly added together. Their material fuel/climb disagreements become
`vision_discrepancies` for human review.

`migrations/20260829_vision_qwen30b_dgx.sql` records Qwen model/runtime
identity and adds observation review states. Only `accepted` or `corrected`
observations can cross the `VISION_RELEASE` bridge.

### Failure handling and attribution

Three behaviours are worth knowing before reading `analyze_view_with_qwen`:

- **A failed clip is skipped, not fatal.** The service answers 422 whenever
  the model emits unparseable JSON, which over dozens of clips per view is a
  matter of when rather than if. Losing one clip must not discard the run's
  YOLO tracks and classical-CV work, so the clip is recorded with
  `clip_quality='unusable'` and the service's error body in `raw_response`
  (surfaced in the "Qwen clip audit" panel) and the pass continues. If *every*
  clip fails the run is failed outright — an outage must not read as Qwen
  silently agreeing with the deterministic pipeline.
- **Robot-centric events are attributed to a track; fuel is not.**
  `attribute_qwen_event` matches a Qwen box against concurrent YOLO tracks —
  which already carry `team_key` from `identity_map` — but only for
  `climb_attempt`/`climb_success`/`disabled_or_immobile`, where the box sits
  on the robot doing the thing. `fuel_scored` is deliberately excluded: its
  box is at the goal, not the shooter, and attributing it to the nearest robot
  is the exact error `attribute_scores` traces piece trajectories back to
  their origin to avoid. Qwen fuel therefore stays alliance-level and serves
  only as a cross-check. Matching requires the same alliance and a track point
  within 500 ms, records `attribution_distance` in evidence, and can be capped
  via `config.qwen_attribution_max_distance`. It is only ever a pre-filled
  suggestion — the observation still lands `unreviewed`.
- **The runner heartbeats per clip.** A whole-match Qwen pass is dozens of
  serialized inferences running for many minutes; without a ping per clip the
  fleet dashboard's 60s online threshold reads a hard-at-work runner as
  offline, and a genuinely hung one is indistinguishable from a busy one.

### Calibration UI — `src/lib/components/VisionCalibrator.svelte`

Click-to-draw calibration against a paused frame of the view's own recording,
replacing hand-typed JSON. Four modes: trace the field mask, outline goal
zones (each with a label and alliance), outline **start zones**, or click four
field landmarks and type their real coordinates to solve the homography.

Start zones are picked from a fixed list — `left trench`, `left mound`,
`center`, `right mound`, `right trench` — rather than free text, because the
released `auto_start_position` has to be a value datascout also writes or it's
unreadable next to a hand-scouted match.

Naming which zone a robot started in happens in the **runner**
(`resolve_auto_start_zone`), not at release time, and that placement is
load-bearing: start-zone polygons are stored normalized 0-1 and `point_in_zone`
scales them against a *pixel* centre, while a stored trajectory point is in
field units whenever a homography is calibrated. Doing the same check
server-side would silently never match. The runner records the answer in the
track's `metrics.autoStartZone`, and `autoStartPosition()` just reads it.

Two coordinate spaces, deliberately — this is the thing to get right when
touching it. Mask and goal-zone polygons are stored **normalized 0-1** so one
calibration survives a resolution change (`build_mask`/`point_in_zone` scale
them by frame size). Homography source points are stored in the **source
video's own pixels**, because `field_point()` applies the matrix to pixel-space
box centres. `calibrationPointFromClick()` in `src/lib/homography.js` returns
both from one click, and is unit-tested for the case that actually bites: the
player is almost always scaled down, so displayed pixels are not video pixels.

`solveHomography()` is a plain DLT solve (four correspondences, an 8×8 system,
Gaussian elimination with partial pivoting) returning a matrix normalized so
h33 is 1. It refuses degenerate point sets — three collinear or two coincident
— rather than returning a garbage matrix, which is the common way a hand-picked
set goes wrong. Its output was checked against `cv2.getPerspectiveTransform`
and agrees to ~10 significant figures; that equivalence matters because the
runner consumes the matrix with `cv2.perspectiveTransform`.

### AprilTag self-calibration — `vision/runner/apriltag_calibration.py`

A camera that can see two or more field AprilTags calibrates itself, which
removes the most expert-only step in the whole pipeline. `process_view` tries
it automatically for any view with no hand-drawn homography, writes the result
onto the view so every downstream `field_point()` picks it up, and records the
diagnostics; the four-point tool stays as the fallback.

Not a plain four-point homography: FRC tags are mounted **upright on walls**,
so their corners are not coplanar with the floor and fitting a homography
directly to them fits the wrong plane. Instead `solvePnP` recovers the camera
pose from the tags' known 3D field positions, and the floor-plane homography
falls out of that pose — for a point at z=0 the third rotation column drops
out, leaving `K [r1 r2 t]`, which is inverted because `field_point()` goes
image → field.

**Opt-in twice over, and manual calibration always wins.** It needs
`config.apriltag_autocalibrate: true` *and* `config.apriltag_layout_path` (the
WPILib layout is game-year specific, so a path rather than baked-in
constants), plus `camera_horizontal_fov_deg` — which is never guessed, because
a homography from invented intrinsics is confidently wrong rather than
obviously wrong. `resolve_view_calibration()` holds the precedence rule and
does not even consult the solver when a view already has a homography.
`apriltag_family` (36h11/36h10/25h9/16h5), `apriltag_size_m` and
`apriltag_max_reprojection_px` are configurable too.

It refuses rather than guessing, through three gates that each exist because
something got past the previous one:

1. **Reprojection error** — catches a wrong tag size or an overstated FOV.
2. **Physical plausibility of the recovered pose** — catches what reprojection
   cannot. An *understated* FOV reprojects at 1.9px, well inside the gate,
   while placing the camera 31 m behind the alliance wall: the error lands in
   the pose, not the residual. So the camera must solve to above the floor,
   below a sane roof, and within a margin of the field bounds the layout
   itself supplies.
3. **Planar ambiguity** — a camera seeing one wall has a coplanar point set,
   and coplanar PnP genuinely has two solutions: the true pose and its mirror
   through the tag plane, both reprojecting perfectly. `solvePnPGeneric`
   returns every candidate and the plausibility check picks the real one.
   Taking whichever came back first put the camera under the floor about half
   the time.

Accuracy is dominated by how far apart the tags are in depth, and the solve
reports it. Measured on synthetic scenes at 0.3px corner noise: tags spread
over three walls put a 3 m ground distance within 1 mm; the same count on a
single wall drifts to ~6 cm. Both are exact with perfect corners, so this is
noise sensitivity, not bias. When the visible tags are coplanar the
diagnostics say so and suggest aiming to catch a side wall.

`main()` doubles as a CLI for calibrating a venue once from a recording,
printing the homography and diagnostics as JSON.

**Nothing here can fail a run.** A missing layout, an OpenCV build without
`cv2.aruco`, an unknown tag family, an unreadable recording, no tags in view
or a refused solve all fall back to pixel coordinates and record why.

**Per-view diagnostics travel with the run.** `complete` now carries a
`view_diagnostics` entry per view: the recording preflight (resolution, fps,
frame count, duration, and warnings about low resolution, low frame rate or a
clip shorter than a match), plus the calibration outcome — tags detected and
matched, reprojection error, recovered camera position, coplanarity, and the
fallback reason when it was refused. That means a reviewer can see why a view
produced pixels instead of metres without reading the runner's logs.

Setup, capture expectations and the remaining real-world validation are in
`vision/runner/README.md`.

### Calibration & tuning

- **Field mask** (`vision_views.field_mask`) and **goal zones**
  (`vision_views.goal_zones`) — normalized (0-1) polygons, set per view via
  a JSON textarea on the upload form (matching the existing homography JSON
  field). A field mask excludes audience/background from *both* detectors; a
  goal zone is where a scored piece's trajectory is expected to end. Without
  a goal zone calibrated, no fuel can ever be attributed - `attribute_scores`
  only fires for trajectories that actually end inside one.
- **HSV range / min area / min circularity** (`vision_runs.config.hsv_lower`,
  `hsv_upper`, `min_piece_area`, `min_circularity`) — per-run, since per the
  source community's own experience, lighting varies enough by venue that a
  single hardcoded threshold doesn't survive multiple events. Exposed as a
  collapsed "Hybrid game-piece detection tuning" section on the run-queue
  form; falls back to `DEFAULT_HSV_LOWER`/`DEFAULT_HSV_UPPER`/etc. in
  `vision_runner.py` if left blank.

No visual polygon-drawing/HSV-preview tuner tool exists yet (the source
community post describes building one) - calibration today is hand-written
JSON/numbers. A natural follow-up, not built here.

### Verifying the pure-logic pieces without a GPU or real footage

`PieceTracker`, `detect_game_pieces`, `build_mask`, `point_in_zone`,
`attribute_scores`, and `RobotReId` are all plain Python/OpenCV/NumPy with
no YOLO dependency, so they can be exercised directly against synthetic
frames and fixtures - stub `sys.modules['ultralytics']` before import (the
module only touches `ultralytics.YOLO` at call time, not import time) since
`vision_runner.py` otherwise requires the real package. The runner-specific
checks were run ad hoc during development to confirm, concretely:
a moving piece stays one trajectory; two simultaneous distant pieces don't
merge; a non-circular blob is rejected by the circularity filter; a piece
that never enters a goal zone produces no observation; a piece is attributed
to the robot closest to its *origin*, not the robot closest to the goal; an
occluded robot is recovered under its original id when both position and
appearance match; and a same-position, different-colored robot is correctly
*not* merged. Checked-in standard-library tests separately validate Qwen
contract normalization and evaluation math without loading model weights.

## Training pipeline — `vision/training/`

Not run by the app at all — a standalone offline toolchain for producing the
YOLO weights the runner needs:

- `extract_frames.py` — pulls frames from a recording at a fixed sample rate
  into a flat "unsplit" labeling directory (source filename encodes match key
  + view label, so provenance survives into the dataset).
- `validate_splits.py` — fails the build if frames from the same source video
  appear in more than one of `train`/`val`/`test` (a real, specific leakage
  bug this guards against: adjacent frames of the same match are nearly
  identical, so a naive random split would let the model "cheat" by
  memorizing rather than generalizing — inflating held-out accuracy).
- `bootstrap_annotate.py` — uses the full BF16
  `Qwen/Qwen3-VL-30B-A3B-Instruct` checkpoint to analyze short (~5s)
  clips across one or more synced views and
  propose grounded robot/fuel/climb/immobility events as JSON. Purely a
  labeling accelerant — output is explicitly unreviewed and never becomes a
  training set or production result on its own.
- `vision/qwen/` — long-lived DGX Spark service for the same checkpoint. It
  serializes bounded inference, authenticates the runner, persists model
  cache through Compose, and validates/clamps model JSON before the runner
  stores it as a review-required observation.
- `bootstrap_yolo_annotate.py` — once reviewed seed YOLO weights exist, runs
  them densely across new recordings to generate a faster pseudo-labeling
  pass (dense box coverage; Qwen still owns semantic event judgment).
- `train_model.py` — trains a YOLO model from a declared base checkpoint
  against a `data.yaml`, evaluates on the held-out `test` split, and writes
  versioned best weights + a `model-manifest.json`. Detection mAP alone is
  treated as insufficient — the design doc requires separately evaluating
  tracker identity-switch rate, calibrated trajectory error, alliance fuel
  error, and climb confusion before a model can be marked
  `approved_for_rankings`.

## Tests

- `src/lib/visionAnalytics.test.js` — trajectory metrics from real-coordinate
  points, multi-camera dedup, red/blue non-merging, alliance-level
  reconciliation before identity is known, and full team fuel
  summarization + discrepancy flagging.
- `src/lib/server/vision_reference.test.js` — TBA breakdown parsing
  (alliance/fuel/climb extraction) and the negative case: total score must
  *not* be mistaken for a fuel count when no compatible breakdown field
  exists.
- `src/routes/api/vision-runner/server.test.js` — token auth (missing/wrong/
  wrong-length all reject before the constant-time compare even runs), the
  claim compare-and-swap loop (a lost race on the first candidate correctly
  falls through to the next one), heartbeat validation, and that `fail`
  only fires a Slack alert when a row actually transitioned (not on a no-op
  CAS). **Note the file name**: `server.test.js`, not `+server.test.js` -
  SvelteKit reserves the `+` prefix for real route files
  (`+page.svelte`/`+server.js`/etc.); a test file starting with `+` trips a
  "Files prefixed with + are reserved" warning (surfaced as a Vite HMR
  overlay in dev, and would very likely break `npm run build` too).
- `src/routes/api/vision/server.test.js` — auth guard, dashboard aggregation
  math (run/discrepancy counts, runner online/offline threshold), and the
  full `release-run` guardrail chain (missing `run_id`, missing permission,
  wrong run status, already-released, no-attributable-results, and the
  happy path asserting the *exact* rows handed to `scout_data_events.insert`
  - including that an unrecognized climb value is dropped rather than
  written through).
- `vision/qwen/test_qwen_contract.py` — malformed/model-wrapped JSON parsing,
  schema normalization, coordinate clamping, and mandatory review state.
- `vision/evaluation/test_evaluate_qwen.py` — event matching, multi-camera
  deduplication, climb attempt/success separation, and acceptance metrics.
- `vision/evaluation/evaluate_qwen.py` — offline acceptance gate for event
  precision/recall, hallucination rate, timestamp error, box IoU, fuel error,
  climb confusion, and cross-camera agreement; `--fail-on-thresholds` makes
  it suitable for DGX validation once reviewed recordings exist.

The JavaScript vision route tests mock `@supabase/supabase-js`'s `createClient`
(and `$lib/server/971bot.js`'s `getSupabase` for the two API-route files)
with a small reusable chain-object mock: every query-builder method returns
the same chain, and the chain itself is awaitable, resolving to a per-table
queued `{data, error}` - because every code path in these routes builds one
full chain and awaits it exactly once, never branching mid-chain. There was
no prior precedent for testing a SvelteKit `+server.js` route in this repo;
this establishes one.

## Access control & security summary

- App-level auth: every `api/vision` call requires a signed-in Supabase user
  (401 otherwise); beyond that, RLS grants any approved user full access -
  no special permission needed to use the feature. `release-run` is the one
  action with its own additional `VISION_RELEASE` check.
- Runner auth: a separate bearer-token secret (`VISION_RUNNER_TOKEN`),
  constant-time compared, never exposed to the browser client.
- Raw recordings live in a private bucket; every playback/download URL is
  short-lived and signed per request (15 min for review playback, 1 hour for
  the runner's processing download).
- The runner's Supabase credentials (`SUPABASE_SERVICE_KEY`) and model
  weights never reach the web app or the browser — the boundary between
  "metadata queue" (SvelteKit) and "GPU processing" (external Python worker)
  is a deliberate design choice, not an accident of deployment.

## Setup checklist (nothing here works until these are done)

1. Run all Vision migrations against Supabase in order. Production has all of
   these applied:
   - `migrations/20260828_vision_system.sql` — applied
   - `migrations/20260829_vision_notifications_release_fleet.sql` — applied
   - `migrations/20260829_vision_field_mask_goal_zones.sql` — applied
   - `migrations/20260829_vision_qwen30b_dgx.sql` — applied
   - `migrations/20260829_vision_rls_approved_user.sql` — applied
   - `migrations/20260829_vision_release_atomic.sql` — applied
   - `migrations/20260829_vision_recording_retention.sql` — applied
   - `migrations/20260829_vision_start_zones.sql` — applied
   - `migrations/20260829_vision_match_roster.sql` — applied
   - `migrations/20260829_vision_runner_health_cron.sql` — applied; schedules
     the active five-minute runner health sweep.
   - `migrations/20260915_vision_function_execute_grants.sql` — applied;
     prevents browser roles from invoking privileged Vision functions as RPCs.
2. No permission grant is needed for basic access - every approved user can
   already use Vision Scouting once the migrations run. Grant `VISION_RELEASE`
   (from the admin panel's Permissions column) only to whoever should be able
   to release results into real scouting data.
3. Set `VISION_RUNNER_TOKEN` and `TBA_API_KEY` in the web service; generate a
   separate `VISION_QWEN_TOKEN` for the private runner-to-Qwen boundary.
4. Deploy the checked-in bare-metal systemd units on DGX Spark with the pinned
   Qwen revision, persistent model cache, and `VISION_MODEL_PATH` pointing at
   a locally trained tracker model — no weights are committed to this repo.

`/scouting/vision` is a real "Vision Scouting" tab in the Competition nav
folder (`src/routes/+layout.svelte`, `navigation.json`, `defaultTabs.js`),
visible to every approved user with no extra `canRenderTabKey` gate - same
as Pit/Data/Note Scouting.

One caveat specific to *existing* accounts: a user who already customized
their own nav (`user_profiles.header_tabs`) keeps their saved layout
verbatim and won't automatically pick up a newly-added default tab -
they (or an admin, directly via SQL) need to add it once, the same
pre-existing limitation `defaultTabs.js` already documents for any new tab
added to the defaults. New/uncustomized accounts get it automatically.
