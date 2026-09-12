# Vision Scouting — everything left before this is functional

Companion to `../guides/scoutingvision.md` (which is the file-by-file "where is the code
and what does it do" reference). This doc is the gap between *"the code
exists"* and *"this produces a scouting number someone would trust."*

It is organised by **who can actually do the thing**, because that is the only
distinction that matters for planning:

- **[Part A — human/hardware only](#part-a--only-a-human-can-do-these).**
  GCP console access, physical hardware, real match footage, labeling time.
  No amount of further code closes these.
- **[Part B — still doable in code](#part-b--still-doable-in-code).** Real
  work an agent or contributor can pick up today without any hardware.
- **[Part C — known gaps and risks](#part-c--known-gaps-and-risks)** worth a
  decision rather than a task.

Status key: **[BLOCKER]** nothing works until this is done · **[NEEDED]**
required before competition use · **[NICE]** improves it, not load-bearing.

---

## Where it stands today

The whole path exists in code and is unit-tested: create match → upload camera
views → queue a run → the DGX runner claims it → YOLO/ByteTrack tracking +
classical-CV game-piece detection + Qwen3-VL clip analysis → discrepancy
reconciliation against TBA → human review → release into `scout_data_events`.

**What is genuinely verified:** 624 JS tests, 0 `svelte-check` errors, Python
unit tests, and synthetic-fixture harnesses covering attribution, occlusion
re-identification, clip-failure handling, and the track→observation identity
chain. The homography solver is checked against `cv2.getPerspectiveTransform`.
Ten vision migrations are applied to the live Supabase project; RLS on all
10 `vision_*` tables is gated on `approved_user()`.

Vision now releases six scouting fields rather than two — `hub_fuel_override`,
`climb_pos`, `auto_climb_pos`, `dead_auto` and `auto_start_position` — closing
most of the gap against what a human scout records by hand.

**What is not:** *none of it has ever processed a real frame of match video.*
Every threshold, the HSV range, the attribution distances, and the entire
throughput model are educated guesses until footage exists. Treat every number
in the config as a starting point, not a tuned value.

---

## Part A — only a human can do these

### A1. Wire `VISION_RUNNER_TOKEN` into Cloud Run **[READY TO DEPLOY]**

The dedicated secret now exists. `cloudbuild.yaml` maps it into the web
service, and the same value belongs only in the ignored `vision/runner/.env`
on the DGX host. Before deploying, verify that Cloud Run's runtime service
account (`536793099017-compute@developer.gserviceaccount.com`) has
`roles/secretmanager.secretAccessor` on this secret. The runner API is
fail-closed, so it rejects every claim, heartbeat, and completion until the
deployed service receives this variable.

The order matters: referencing a secret before it exists breaks every
subsequent deploy, which is exactly how the `CRON_NOTIFICATION_TOKEN` gap
(still open, see C1) started.

### A2. Provision the DGX Spark host **[BLOCKER]**

The Compose stack and systemd units are written and ready; no host is running
them. Needed: current DGX OS, NVIDIA Container Toolkit, `docker login` against
NVIDIA NGC (the base image is `nvcr.io/nvidia/pytorch`), the ~60+ GB
Qwen3.8-27B checkpoint downloaded into the persistent cache, both example
secrets in `vision/runner/.env.example` replaced with real generated values,
and a decision about who owns uptime and cache maintenance.

### A3. Apply the cron migration **on merge**, and pick a retention window **[NEEDED]**

`migrations/20260829_vision_runner_health_cron.sql` is deliberately **not**
applied. Unlike the schema migrations (additive, and deployed code ignores
them), it schedules a `pg_cron` job that calls
`/api/notifications/vision-stale-runners` — a route that only exists on this
branch. Applying it early just 404s against production every 5 minutes. Apply
it right after PR #84 merges and deploys.

At the same time, decide two things the code deliberately does not guess:

- **`CRON_NOTIFICATION_TOKEN`.** Both Vision sweeps fail closed without it and
  will return 503 (see C1). Setting it is what turns them on.
- **`VISION_RECORDING_RETENTION_DAYS`.** Unset means video is kept forever,
  which is the safe default but will grow fast at a multi-day event. Pick a
  window and schedule `/api/notifications/vision-recording-retention` the same
  way. Nothing is ever deleted before its run has been released.

### A4. Time one Qwen clip on the real hardware **[NEEDED]**

This is the highest-information cheap experiment available, and it may force a
design change rather than a tuning tweak — so do it before optimising
anything.

Clips run strictly serially: ~30 per view for a 150-second match at the
5-second default, each a blocking call carrying 8 images at 1280×720, with a
single inference lock on the service side. At a plausible 30–60s per clip
that is **15–30 minutes per view**, times the number of cameras. A qual day
running a match every ~7 minutes falls behind immediately.

Measure one clip, then pick from the levers in [B1](#b1-cut-qwen-throughput-cost-needed).

### A5. Camera hardware and a real recording **[BLOCKER for useful output]**

The pipeline assumes a fixed, elevated view of the field. Nothing in this repo
records what camera exists or where it would mount. The single most valuable
next step after A1/A2 is getting **one** real recording — a phone on a tripod
is genuinely enough — through the pipeline by hand, to see what the detection
actually produces before investing in labeling.

Hardware note from the source Chief Delphi work: prioritise **shutter speed
over frame rate**. Motion-blurred robots at 60fps are worse than sharp ones at
30fps.

### A6. A labeled dataset and a trained YOLO model **[BLOCKER for useful output]**

**The full procedure is written up in
[`vision/training/TRAINING.md`](vision/training/TRAINING.md)** — footage
quantities, camera settings, the attempt-vs-success labeling rule, split
discipline, what to evaluate beyond mAP, and the promotion checklist.

`create_placeholder_model.py` produces a real, loadable 6-class checkpoint that
exercises the claim/heartbeat/complete plumbing — its detections are
meaningless noise. A real model needs, in order: recordings (A5), frame
extraction, manual labeling in CVAT or similar (no labeled dataset exists),
a real `train_model.py` run, and evaluation against the acceptance gates. This
is data-collection and human-labeling time; no scripting shortcut exists.

Rough scale from TRAINING.md: ~8–12 matches for a first trainable model, 25–40
across at least two venues for something competition-usable. Variety across
events matters more than raw frame count.

Note the Qwen checkpoint is pretrained and needs **no** local training — Qwen
review trials can begin as soon as A1/A2 are done, before any YOLO model
exists.

### A7. Per-venue calibration **[NEEDED]**

There is now a click-to-draw calibrator (B2), so this is no longer hand-typed
JSON: trace the field mask, outline goal zones, outline the named auto start
zones, and click four landmarks to solve the homography. What stays human is
knowing *which* four landmarks and what their real field coordinates are, and
doing it once per venue per camera — though B4a now removes even that where
the camera can see field AprilTags. HSV thresholds are still numeric fields
on
the run form and will need tuning against real footage.

Calibrating start zones is what makes `auto_start_position` reportable at all —
without them vision stays silent on that field rather than guessing.

### A8. Decide the model-acceptance policy **[NEEDED — a decision, not a task]**

Nothing in `release-run` checks model quality before allowing a release. Either
keep it a documented trust-based process, or say the word and B6 adds a real
`approved_for_release` gate.

---

## Part B — still doable in code

Ordered by value per unit of effort. None of these need hardware.

### B1. Cut Qwen throughput cost **[NEEDED]**

Depends on A4's measurement for validation, but the code can land first.
Cheapest first:

- `VISION_QWEN_FRAMES_PER_CLIP` 8→4, `VISION_QWEN_JPEG_WIDTH` 1280→960 —
  already env-tunable, no code needed.
- `VISION_QWEN_CLIP_SECONDS` 5→10 — halves request count, coarsens timestamps.
- **Activity-gated clips** — only send Qwen the clips where the deterministic
  pipeline already saw a robot near a goal or climbing structure. Most of a
  match is not a scoring moment, so this is potentially a 3–5× reduction *and*
  it cuts hallucination surface. This is the real fix and the one worth
  writing. It is a behaviour change, so it wants real footage to validate.
- `sample_qwen_clip` reopens and re-seeks the video for every clip; reuse one
  `VideoCapture`. Wasteful but trivial next to inference time — do it last.

### ~~B2. A visual calibration tool~~ **[DONE]**

`VisionCalibrator.svelte` — click-to-draw against a paused frame of the view's
own recording. Trace the field mask, outline goal zones, or click four
landmarks and type their field coordinates to solve the homography.
`src/lib/homography.js` does the DLT solve; its output was checked against
`cv2.getPerspectiveTransform` and agrees to ~10 significant figures, which
matters because the runner applies the matrix with `cv2.perspectiveTransform`.
Saved through the new `update-view` action.

### ~~B3. Jump the video to an observation's timestamp~~ **[DONE]**

Each review row has a Watch button that seeks that view's player to
`started_ms - sync_offset_ms` and scrolls it into frame.

### B4. Persist reviewed identities so a re-run starts attributed **[NEEDED — but see the caveat]**

`identity_map` is still only ever empty. Reviewed track identities now cascade
to observations within a run (fixed), but re-running the same match throws all
of it away.

**Deliberately not built yet, because it is not safely buildable from here.**
`identity_map` is keyed by ByteTrack tracker IDs, and whether those are stable
across two runs of the same video depends on the tracker's determinism under
whatever parameters changed between them. Re-running with a different
`confidence_floor` or different weights will certainly renumber them; re-running
with only HSV changes probably will not. Getting that wrong means silently
attributing events to the *wrong team*, which is worse than today's behaviour
of attributing nothing. Verifying it needs a real model and real footage
(A5/A6). Build it after that, keyed on parameters that provably did not change.

### B4b. Pull match video from The Blue Alliance **[NICE]**

Requested: an API that fetches match video from TBA so recordings don't have
to be uploaded by hand. Worth doing, with two caveats that shape what it can
actually be:

- **TBA serves links, not files.** `/match/{key}` returns
  `videos: [{type: 'youtube', key: '...'}]`. Fetching the video itself means
  going to YouTube, which is a separate dependency with its own terms; TBA
  alone gets you the link and the metadata.
- **Broadcast footage is a different problem from what this pipeline
  assumes.** The whole design — field mask, goal-zone polygons, homography —
  assumes one *fixed* elevated camera. Broadcast video cuts between angles,
  zooms, replays, and overlays graphics, so per-view calibration is
  meaningless against it and robot tracks break at every cut.

So the honest shape is: TBA integration is genuinely useful for **match
metadata and as a fallback/secondary source a human reviews**, and for
bootstrapping a labeling dataset (A6) where camera motion doesn't matter. It
is not a substitute for the fixed camera in A5. Build it as a link-resolver
plus optional fetch, and keep broadcast-sourced runs flagged as a distinct
source so nobody mistakes their attribution for the calibrated pipeline's.

### ~~B4a. Solve the homography from AprilTags~~ **[DONE]**

`vision/runner/apriltag_calibration.py`. A camera that can see two or more
field tags calibrates itself: detect 36h11 markers, look each one up in the
WPILib `AprilTagFieldLayout` JSON, recover the camera pose with `solvePnP`,
and derive the floor-plane homography from it. The runner tries this
automatically for any view with no hand-drawn homography; the four-point tool
remains the fallback.

Not a plain four-point homography, because FRC tags are mounted upright on
walls — their corners are not coplanar with the floor, so fitting a homography
straight to them fits the wrong plane.

**Opt-in, and it refuses rather than guessing.** Needs
`config.apriltag_layout_path` (the layout is game-year specific, so it's a
path rather than baked-in constants) and the camera's horizontal FOV or real
intrinsics. Three independent gates, each earned by an observed failure:

- **Reprojection error.** Catches a wrong tag size or a badly overstated FOV.
- **Physical plausibility of the recovered camera pose.** Catches what
  reprojection cannot: an *understated* FOV reprojects at 1.9px — comfortably
  inside the gate — while placing the camera 31 m behind the alliance wall.
  The error lands in the pose, not the residual, so it takes a "is the camera
  above the floor and near the field" check to see it.
- **Planar ambiguity.** A camera seeing only one wall has a coplanar point
  set, and coplanar PnP has a real two-fold ambiguity — the true pose and its
  mirror both reproject perfectly. `solvePnPGeneric` returns every solution
  and the plausibility check picks; taking whichever came back first put the
  camera under the floor about half the time.

**Accuracy depends on tag spread, and the solve says so.** Measured on
synthetic scenes at 0.3px corner noise: tags across three walls put a 3 m
ground distance within 1 mm, while the same number on a single wall drifts to
~6 cm, because depth is weakly constrained when everything is on one plane.
Both are exact with perfect corners, so this is noise sensitivity rather than
bias. When the visible tags are coplanar the diagnostics say so and suggest
aiming to catch a side wall.

Now also opt-in behind an explicit `apriltag_autocalibrate` flag (not just a
layout path), configurable for tag family and error threshold, with a
recording preflight reporting resolution/fps/duration and per-view diagnostics
travelling back with the run. 44 Python tests cover layout parsing, the solve,
every refusal path, and manual-homography precedence.

**Still wants a real field** to confirm the corner-ordering convention — the
one assumption synthetic tests can't validate. The reprojection gate is what
would catch it being wrong, so check the reported camera position looks sane
on the first real run before trusting the numbers. Two practical notes from
testing: a 6.5in tag at 14 m is only ~15px and the detector misses about half
of those, and accuracy is much better when the camera sees more than one wall.

### B4c. Analytics vision does better than a human **[NICE]**

The pipeline stores a full trajectory per robot and `trajectoryMetrics`
already derives distance, median/p90/max speed, acceleration, turn rate and
moving-vs-stationary time from it — and none of that is shown anywhere. Also
derivable from data already collected, with no model work:

- **Defense played** — proximity between opposing-alliance trajectories over
  time. Humans track this badly; vision doesn't.
- **Cycle time and time-to-first-score** — from observation timestamps.
- **Zone occupancy / heat map** — needs a homography, which the calibrator now
  makes practical to obtain.

Two things deliberately *not* mapped into the scouting vocabulary, having
checked what those fields actually mean: `rank_speed` is **balls per second**,
not robot speed, so releasing our m/s into it would be silently wrong; and
`pushing` always writes the value `"outpost"`, whose game meaning isn't clear
enough from the code to synthesize. Surface these as vision-native analytics
instead of forcing them into fields that mean something else.

### B5. Keyboard-driven review **[NICE]**

Bulk accept and filters exist now. A j/k/a/r keyboard loop over the filtered
list would make a match's worth of proposals genuinely fast to clear.

### B6. `approved_for_release` gate **[NICE — pending A8]**

If the answer to A8 is "enforce it": a flag on the model/run that
`release-run` checks, so an unvalidated model physically cannot reach
`scout_data_events`.

### ~~B7. Storage retention~~ **[DONE — opt-in]**

`api/notifications/vision-recording-retention` reclaims video files. Two
safety properties, both in `vision_retention.js` and unit-tested: it is
**opt-in** (no `VISION_RECORDING_RETENTION_DAYS`, no deletions — there is no
right default to guess for someone else's data), and it never touches a
recording whose run has not been *released*, because video is the evidence
behind a reviewer's decision. Only the file goes; tracks, observations and the
release audit trail stay, so a released number keeps its provenance.

Still needs a human to pick the window and schedule the sweep.

### ~~B8. Test coverage for the release bridge~~ **[DONE]**

`release_bridge.test.js` covers release-run and the `update-track` cascade.

---

## What other FRC teams do that we now do too

Surveyed against published FRC scouting and vision work — Team 334's
"Building AI-Assisted FRC Scouting" write-up, the ScoutingPASS / QRScout
family of scouting apps, PhotonVision, and the Roboflow FRC robot-detection
datasets — to find conventions worth adopting rather than reinventing.

- **Pre-populate team numbers from the match schedule.** Standard practice in
  every established scouting app, and it was our slowest review step done the
  worst way: free text, once per track, with nothing preventing a typo or a
  red team typed onto a blue track. Now a dropdown of the three teams actually
  on that track's alliance, cached from TBA on the match. **Adopted.**
- **Sanity-check against the expected robot count.** Six robots play a match;
  the roster tells us so. Materially more tracks means one robot split across
  an occlusion, fewer means one was never picked up. Free signal, surfaced
  before anyone assigns identities. **Adopted.**
- **Human review is not optional.** Team 334's conclusion after a season of
  this was that fully autonomous scouting was not reliable enough to trust.
  That matches the design here — every model output lands `unreviewed` and
  only accepted or corrected rows can be released — and is worth not drifting
  away from as accuracy improves.
- **AprilTag-derived field calibration.** See B4a; the single biggest thing
  still worth borrowing.
- **Field-zone occupancy.** Several scouting apps record robot position as a
  coarse grid (one divides the field into 72 boxes). We store full
  trajectories, so the grid is a presentation choice — worth matching their
  vocabulary so vision output is comparable with hand-scouted position data.
  Folded into B4c.

Deliberately **not** adopted: bumper-number OCR for identity. It sounds like
the obvious fix, but team numbers on bumpers are small, frequently occluded by
other robots, and rotate out of view constantly — and the match roster already
narrows identity to a three-way choice, which is a far cheaper way to get the
same answer.

## Part C — known gaps and risks

### C1. The cron trust boundary is fail-open — but Vision's endpoints are not

`cron_auth.js`'s `isAuthorizedCronRequest()` accepts **any** request when none
of `CRON_SECRET`/`CRON_TOKEN`/`CRON_NOTIFICATION_TOKEN` is configured, and
`CRON_NOTIFICATION_TOKEN` is currently commented out of `cloudbuild.yaml`'s
`--set-secrets` (frc971/spartanshub issue #5). That default is still there for
the older sweeps.

Both Vision endpoints now **fail closed** instead of inheriting it: with no
cron secret configured they return 503 and do nothing. A health sweep that
doesn't run is a much smaller problem than an open endpoint, and the retention
sweep deletes files, so it must never run unauthenticated. Remove those guards
once issue #5 is closed and the fail-open default is gone.

The underlying issue #5 is still worth closing — it is the *other* endpoints
that remain exposed.

### C2. Attribution is proximity-based and will need retuning

Every attribution path picks the nearest same-alliance robot track within a
500 ms window. That is sound for climbs (the box is on the robot) and for fuel
(the trajectory is traced back to its *origin*, deliberately not the goal).
But no distance ceiling is set by default, so a lone robot far from an event
can still win it. `qwen_attribution_max_distance` and
`climb_attribution_max_distance` exist for exactly this and are unset — they
want real footage to choose a value.

Mitigating this: every model observation lands `review_status=unreviewed`, and
only `accepted`/`corrected` rows can be released. Attribution is a suggestion
a human confirms, never a silent write.

### C3. Multi-camera fusion is time-based only

`fuseObservations` merges observations of the same type/team/alliance within
350 ms across views and keeps the highest-confidence one. It does not
geometrically verify that two cameras saw the *same physical event*. With
correct sync offsets this is fine; with drifting offsets it will silently
double-count. Worth revisiting once real multi-camera footage exists.

### C5. Fixed this pass: RLS was open to every authenticated session

Recorded because it is the kind of thing worth not reintroducing. Every Vision
table and the recordings bucket used `USING (true) WITH CHECK (true)`, which
reads as "open to everyone" but means open to every authenticated Supabase
session — including accounts still pending approval and accounts that have
been *banned*. The app UI gated them out, but RLS is what protects a direct
client using the public anon key, so those accounts could read, modify, or
delete Vision records and raw match video.

`20260829_vision_rls_approved_user.sql` moves all 10 tables and the storage
bucket to `public.approved_user()` — admin or `CAN_SEE_ROUTES`, exactly what
the admin panel's Approve action grants, and what every sibling scouting table
already used. Applied; verified all 10 policies now carry it.

### C6. Fixed this pass: release was not transactional

`release-run` used to insert `scout_data_events`, then separately update the
run's `released_at`, then insert the audit row. A failure between them left
real scouting data with no release state and no provenance, and two concurrent
releases could both pass the already-released check and double every event for
the match.

All three now happen inside `release_vision_run()`
(`20260829_vision_release_atomic.sql`) — one transaction, with a
compare-and-swap on `released_at` so the second concurrent caller loses
cleanly with a 409. Applied.

### C4. Everything downstream of the model is only as good as the sync offsets

`sync_offset_ms` per view is hand-entered and unverified. Phase assignment,
multi-camera fusion, and attribution windows all depend on it. There is no
tooling to check that two views are actually aligned.

---

## Suggested order

1. **A1** — the two `gcloud` commands. Nothing runs until this is done.
2. **A2** — stand up the Compose stack; confirm a full `queue-run` → `claim` →
   Qwen → `complete` cycle against the deployed app using the placeholder
   model. This proves the plumbing without needing a trained model.
3. **A4** — time one clip. The answer decides whether B1's activity-gating is
   urgent or optional.
4. **A5** — one real recording through the pipeline by hand. Expect the HSV
   range and every threshold to be wrong; this is where they get tuned.
5. **B2 + B3** — calibration tool and video seeking. Both become obviously
   necessary the moment a human sits down to review real footage.
6. **A6** — labeling and a real trained model, once you know from step 4 what
   the detector actually needs to handle.
7. Everything else in Part B as it earns its place.

`A3` happens whenever PR #84 merges, independently of this sequence.
