# Vision ML Runner

Private post-match worker for `/scouting/vision`. It downloads every camera
view through one-hour signed URLs, runs a hybrid detection pipeline, tracks
robots, emits trajectory/action/scoring evidence, and reports results to the
authenticated runner API. The web app never receives model weights or the
runner token.

**Hybrid pipeline** (adapted from community R&D shared on Chief Delphi,
"Computer Vision Scouting" - see `docs/guides/scoutingvision.md` for the full writeup):

- **Robots**: versioned custom Ultralytics YOLO weights + built-in
  cross-frame tracking, plus a velocity+color-histogram re-identification
  pass (`RobotReId`) that recovers a robot's tracked identity across a brief
  occlusion instead of splitting it into two unrelated tracks.
- **Game pieces (fuel)**: *not* a YOLO class - classical HSV color
  thresholding + contour/circularity filtering (`detect_game_pieces`),
  tracked with constant-velocity prediction and distance-ordered association
  (`fuel_tracking.PieceTracker`), and attributed to a scoring robot
  by tracing a piece's trajectory back to its origin and finding the closest
  robot track at that moment (`attribute_scores`) - not whichever robot is
  nearest the goal when the piece lands. Robot attribution uses retained pixel
  centres, never compares ball pixels to calibrated robot metres, and has a
  distance gate. Only an observed outside-to-inside goal transition produces
  a candidate; this is not proof that a ball scored and always needs review.

YOLO is already required for robot detection (training base: `yolo11n.pt`,
six custom robot/climb classes). There are no production weights committed.
HSV is an unvalidated baseline, not inherently better than YOLO for balls.
See `../evaluation/pipeline-review.md` for detector/model/harness decisions.

Requires a per-view **field mask** (audience/background exclusion) and
**goal zone** calibration (where a scored piece's trajectory should end) to
get useful output - see the upload form on `/scouting/vision`.

This worker calls the authenticated full-BF16 Qwen3-VL-30B-A3B-Instruct service in
`vision/qwen/` for bounded semantic clip analysis. It still provides
deterministic per-frame tracks, mobility metrics, and piece attribution.
Qwen proposals are stored as unreviewed observations and cannot be released
into scouting data until a human accepts or corrects them.

Required environment:

```text
VISION_API_URL=https://your-spartans-hub-origin
VISION_RUNNER_TOKEN=shared-secret
VISION_RUNNER_ID=vision-runner-gpu-1
VISION_MODEL_PATH=/models/frc-vision-v1.pt
VISION_QWEN_URL=http://127.0.0.1:8000
VISION_QWEN_TOKEN=separate-shared-secret
VISION_QWEN_MODEL=Qwen/Qwen3-VL-30B-A3B-Instruct
VISION_QWEN_DEVICE_MAP=cuda
```

Manual install and run (quickest way to test on a machine you already have
a shell on):

```bash
cp .env.example .env   # then fill in real values
set -a; source .env; set +a
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python vision_runner.py
```

## Self-calibrating a camera from field AprilTags

A camera that can see two or more field tags can solve its own field
homography, which removes the hand-clicked four-point calibration step.

**Why it matters beyond convenience:** with no homography at all,
`field_point()` passes pixel coordinates straight through, so speed, distance,
attribution thresholds and the dead-auto check are all in *pixels* and are not
comparable between venues or even between cameras. A tag-derived solve puts
them in metres in the real FRC field frame.

### Setup

1. Get the season's `AprilTagFieldLayout` JSON. It ships with WPILib
   (`edu.wpi.first.apriltag`) and gives every tag's surveyed pose in metres.
   Put it somewhere the runner host can read.
2. Find the camera's **horizontal field of view** in degrees, from its spec
   sheet. This is required — the runner will not guess a focal length, because
   a homography from wrong intrinsics is confidently wrong rather than
   obviously wrong (see the gates below). Real calibrated intrinsics, e.g.
   from WPILib's `wpical`, are better if you have them.
3. Enable it in the run config:

```json
{
  "apriltag_autocalibrate": true,
  "apriltag_layout_path": "/opt/vision/2026-field.json",
  "camera_horizontal_fov_deg": 65
}
```

Optional: `apriltag_family` (`36h11` default, also `36h10`/`25h9`/`16h5` for
older seasons), `apriltag_size_m` (default `0.1651`, the 6.5in FRC tag), and
`apriltag_max_reprojection_px` (default `6.0`).

### Calibrating a venue once, by hand

```bash
python3 apriltag_calibration.py recordings/qm1_fullfield.mov \
  --layout 2026-field.json --fov 65
```

Prints the homography and diagnostics as JSON, so a good result can be pasted
into a view's stored calibration rather than re-solved every run.

### Capture expectations

- **The camera must be fixed.** Every calibration is invalidated if it moves.
- **Tags need to be big enough in frame.** A 6.5in tag at 14 m spans roughly
  15px at 1600px wide, and the detector misses about half of those. Closer, or
  higher resolution.
- **Try to see more than one wall.** Accuracy is dominated by tag spread in
  depth: at 0.3px corner noise, tags across three walls put a 3 m ground
  distance within 1 mm, while the same number on a single wall drifts to
  ~6 cm. Both are exact with perfect corners, so this is noise sensitivity
  rather than bias. The diagnostics say when the visible tags are coplanar.

### What it refuses, and why

Manual calibration always wins — if the view already has a homography, the
solver is not even consulted. Beyond that there are three gates, each of which
exists because something got past the previous one:

| Gate | Catches |
|---|---|
| Reprojection error | Wrong tag size, wrong layout year, overstated FOV |
| Camera-pose plausibility | An **understated** FOV, which reprojects at ~1.9px — well inside the error gate — while placing the camera 31 m behind the alliance wall. The error lands in the pose, not the residual. |
| Planar-ambiguity resolution | A one-wall view has a coplanar point set, and coplanar PnP genuinely has two solutions — the true pose and its mirror, both reprojecting perfectly. Every candidate is evaluated and the physically possible one is picked. |

Nothing here can fail a run. A missing layout, an OpenCV build without
`cv2.aruco`, an unreadable recording, no tags in view, or a refused solve all
fall back to pixel coordinates and record the reason in the run's per-view
diagnostics.

### Diagnostics

Each view reports back with the run: tags detected and matched, reprojection
error, recovered camera position, whether the tags were coplanar, whether
calibration was accepted, and the fallback reason if not. A recording
preflight also reports resolution, fps, frame count and duration, and warns
about low resolution, low frame rate, or a clip shorter than a match.

### Remaining real-world validation

The solve is verified against synthetic ground truth and against real 36h11
markers rendered into a scene and read by the actual detector. The one thing
synthetic tests cannot confirm is that the **tag corner ordering convention
matches real WPILib layout data**. If it were mirrored, the reprojection gate
is what would catch it — so the first real-field run should be checked for a
sane reported camera position before its numbers are trusted.

## Deployment (long-running - pick one)

Before either deployment path is used, run the read-only host check:

```bash
python3 preflight.py
```

It checks required environment names, real model-file size, web API
reachability, and Qwen health without printing secret values or claiming a
job. `--skip-network` checks only local configuration; `--json` emits a result
that can be attached to an event-readiness record.

This has to run continuously on the DGX Spark, not on Cloud Run
(no GPU support there, and this polls for work rather than serving inbound
requests). A Spark exists, but its current service/weight state requires host
verification - see `../evaluation/pipeline-review.md`. Two existing options,
depending on what hardware ends up hosting this:

- **`Dockerfile`** + **`docker-compose.yml`** - an existing optional DGX Spark
  deployment. It starts both the BF16 Qwen service and dense runner, persists
  the model cache, pins a Spark-driver-compatible NGC runtime, places Qwen on
  CUDA explicitly, and waits for Qwen health before claiming work. `cp
  .env.example .env`, fill it in, `mkdir models`, add the tracker `.pt`, then
  use the existing Compose artifact only on an already-approved Docker host.
  Do not install/start Docker for this Spark.
- **`vision-runner.service`** + **`../qwen/qwen.service`** - a systemd
  alternative for running both processes directly on DGX Spark without
  Docker. This is the selected Spark deployment path. Install steps are in the
  files' header comments; copy both imported helper modules with the runner.
  Use `sudo` for host administration; Qwen binds only to loopback. No new Spark
  services are started by the review. See `../evaluation/pipeline-review.md`
  for scheduling training separately from large-model inference.

Either way, `VISION_RUNNER_TOKEN` must be set to the *same* value as the web
service's `VISION_RUNNER_TOKEN` secret. Cloud Run receives its copy from GCP
Secret Manager, but that does not automatically configure the DGX Spark: put
the matching value in the DGX deployment's gitignored `.env` (or an equivalent
host secret store). Get it from the project administrator; do not generate a
replacement on the runner host and never commit it. `VISION_MODEL_PATH`
must point at real trained weights (also not built yet - see
`../training/create_placeholder_model.py` for a non-functional stand-in
that at least exercises the claim/heartbeat/complete plumbing).

The supplied weights may define `robot_red` and `robot_blue`, or a generic
`robot` class. For generic detections, the runner classifies only the lower
bumper band as red or blue and rejects ambiguous/occluded evidence; it never
guesses an alliance. It also supports `climb_attempt` and `climb_success`
classes (alliance suffixes supported for action classes).
**Do not train a `fuel_scored` class** - fuel detection is the classical CV
pipeline above, tuned via `vision_runs.config` (`hsv_lower`/`hsv_upper`/
`min_piece_area`/`min_circularity`), not trained weights; any `fuel_scored`
box a legacy model still emits is explicitly ignored rather than
double-counted. A model cannot identify a specific FRC team from alliance
color alone. Queue configuration may provide an audited `identity_map` from
`<view id>:<tracker id>` to `frcNNNN`; unidentified tracks are marked for human
review instead of guessed.

Every poll iteration - whether or not it claims a job - also sends a
`heartbeat` (runner id, tracker path, Qwen identity/health, current run, last error) so the event
dashboard can show this runner as online/offline instead of that only being
inferable from "jobs stopped moving." A heartbeat failure never blocks or
crashes the actual processing loop.
