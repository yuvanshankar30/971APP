# Vision scouting system

Post-match ML analysis at `/scouting/vision`, a real Competition-nav tab
("Vision Scouting") open to every approved user - no special permission
needed, same as Pit/Data/Note Scouting. Raw recordings use the private
`vision-recordings` Supabase bucket (signed URLs, not an access-control
measure). Only the separate **release** action (pushing a run's results
into real `scout_data_events`) is permission-gated, on `VISION_RELEASE` -
see **Model acceptance gates** below.

## Capture contract

- Fixed, elevated, landscape camera; full field remains visible.
- Prefer 4K60, locked focus/exposure/white balance, no digital zoom. Per
  community R&D (see **Hybrid game-piece detection** below), shutter
  speed/motion blur matters more than raw frame rate for detection quality -
  30fps with a fast shutter beats 60fps with motion blur.
- Multiple synchronized views are supported. Each view records a signed
  storage path, camera position, millisecond offset, calibration points, and
  optional 3×3 image-to-field homography.
- A homography is required for real-unit mobility metrics. Without one, the
  runner preserves pixel trajectories but they must not be interpreted as
  meters or meters/second.
- A view may also calibrate a **field mask** (ROI polygon excluding
  audience/background) and one or more **goal zones** (polygons marking
  where a scored game piece's trajectory ends) - both normalized (0-1) image
  coordinates, both optional but required for automatic fuel attribution to
  work (see below).

## Processing boundary

The SvelteKit service queues metadata only. A separate GPU-capable runner in
`vision/runner/` claims jobs with `VISION_RUNNER_TOKEN`, receives one-hour
signed URLs, runs custom versioned Ultralytics YOLO weights, and submits robot
tracks and action observations. It also calls the authenticated full-BF16
Qwen3.8-27B service in `vision/qwen/` with bounded frame sequences. The
runner must always complete or fail a
claimed run, following the same terminal-state invariant used by AutoCAM. It
also heartbeats every poll iteration so a fleet dashboard can show runner
online/offline status directly, instead of that only being inferable from
"the queue stopped draining."

Required model class vocabulary (`robot_red`, `robot_blue`, `climb_attempt`,
`climb_success` - alliance-suffixed) is documented in the runner README.
**Fuel is deliberately not a YOLO class** - see **Hybrid game-piece
detection** below for why. Custom trained weights are deliberately not
committed: recordings must be labeled, split by match/event (never random
adjacent frames), trained, evaluated, and versioned before deployment.
Unknown team identity is review-required, never guessed from alliance color.

### Hybrid game-piece detection

Adapted from community R&D shared on Chief Delphi ("Computer Vision
Scouting", chiefdelphi.com/t/computer-vision-scouting/511642): training an
object detector for small, fast-moving game pieces at a distance is
difficult and expensive, while classical HSV color thresholding + contour
filtering (area + circularity) is both cheaper and more robust for this one
task. Robot detection stays YOLO - the best tool genuinely differs per
problem here.

- `detect_game_pieces` thresholds each frame by a per-run-configurable HSV
  range (`vision_runs.config.hsv_lower`/`hsv_upper`), masked to the view's
  field mask if calibrated, then filters contours by minimum area and
  circularity to reject noise and non-piece blobs.
- `PieceTracker` associates detections into trajectories frame-to-frame via
  gated nearest-neighbor matching - deliberately simple (no Kalman filter,
  no ML), matching the "classical CV" choice for the whole piece pipeline.
- `attribute_scores` treats a piece trajectory that ends inside a calibrated
  goal zone as scored, then walks back to the trajectory's *origin* point
  and attributes the score to whichever robot track was physically closest
  at that same moment - the shooter, not whichever robot happens to be
  nearest the goal when the piece lands.

### Robot occlusion recovery (ReID)

Also from the same source: `RobotReId` recovers a robot's tracked identity
across a brief occlusion (blocked by a game element or another robot)
instead of the tracker minting a new id for the same physical robot, which
would otherwise silently split one robot's real trajectory - and its
`identity_map` entry - into two unrelated tracks. Two signals must both
agree before a recovery is accepted: the lost track's last known velocity
predicts roughly where the new detection actually is, *and* the new
detection's bumper-region color histogram is similar enough to the lost
track's (position alone is ambiguous with multiple same-alliance robots
nearby).

The authenticated service in `vision/qwen/` loads the full BF16
Qwen3.8-27B checkpoint once on DGX Spark. The runner sends
bounded, timestamped clips from one or more camera views and receives
grounded robot, climb, and immobility evidence (fuel proposals, if any, are
purely a labeling hint - production fuel detection is the classical pipeline
above, not Qwen). Every proposal remains explicitly unreviewed until accepted
or corrected by a human, and the release API rejects unreviewed observations.
The offline `vision/training/bootstrap_annotate.py` uses the same full model
contract for dataset work. Once reviewed seed detector weights
exist, `bootstrap_yolo_annotate.py` supplies a faster dense pseudo-labeling
pass. Qwen performs semantic event reasoning; YOLO/ByteTrack remains
responsible for repeatable boxes and mobility tracks. Neither model output
flows directly into a released model or scouting result.

## Data flow

1. A reviewer creates a `vision_matches` row and uploads one or more
   `vision_views` using signed upload URLs.
2. A `vision_runs` job records immutable model name/version/config.
3. The runner emits `vision_tracks` (trajectories + mobility metrics) and
   `vision_observations` (fuel, climb, mobility, disabled, identity evidence).
4. Multi-view action observations within the deduplication window are fused.
5. Robot results aggregate to alliance totals and compare with a TBA match
   snapshot where compatible official breakdown fields exist.
6. Material differences become `vision_discrepancies`; raw results remain
   immutable while reviewers record a separate resolution and notes.

## Metrics and review

Mobility derives from calibrated field-coordinate trajectories: distance,
median/P90/max speed, mean acceleration, P90 turn rate, moving/stationary time,
and coverage. Gaps over one second and low-confidence points are excluded.

Default discrepancy thresholds require both more than three fuel and more
than 15% alliance-level difference. Climb-count disagreement is critical.
TBA is authoritative for official alliance results, but cannot normally
attribute an alliance total to an individual robot; robot attribution remains
Vision/human-scouter evidence and requires human review when uncertain.

Review resolutions are `accepted_vision`, `accepted_reference`, `corrected`,
`unobservable`, or `dismissed`. Evidence and original model output are never
overwritten.

## Deployment configuration

Web service:

```text
VISION_RUNNER_TOKEN=<high-entropy shared secret>
TBA_API_KEY=<existing server-side TBA key>
```

Runner:

```text
VISION_API_URL=https://spartanshub.example
VISION_RUNNER_TOKEN=<same secret>
VISION_RUNNER_ID=vision-runner-gpu-1
VISION_MODEL_PATH=/models/frc-vision-v1.pt
VISION_QWEN_URL=http://qwen:8000
VISION_QWEN_TOKEN=<separate high-entropy internal secret>
VISION_QWEN_MODEL=Qwen/Qwen3.8-27B
```

Run all four Vision migrations including
`20260829_vision_qwen30b_dgx.sql`, grant `VISION_RELEASE`
from the admin panel to whoever should be able to release results (basic use
needs no grant - every approved user already has it), then deploy the worker
separately. No Vision route or bucket is useful before those steps.

## Model acceptance gates

Before a model version can affect scouting rankings:

- Evaluate on held-out whole matches from unseen events/camera positions.
- Report per-class precision, recall, and identity-switch rate.
- Report trajectory error in meters after calibration.
- Report alliance fuel absolute error and climb confusion matrix.
- Run `vision/evaluation/evaluate_qwen.py` for hallucination rate, timestamp
  MAE, box IoU, fuel error, climb confusion, and multi-camera agreement.
- Review every critical discrepancy for the initial event.
- Pin the accepted Qwen Hugging Face revision and record BF16/attention/clip
  settings with the run.
- Keep model output advisory by default: nothing writes to `scout_data_events`
  or power rankings on its own. A completed run can be explicitly released
  (`POST api/vision {action: 'release-run'}`) by whoever holds the
  `VISION_RELEASE` permission - the one part of this feature that stays
  gated - one-time per run, fully audited (`vision_release_log`), and only for
  team-attributed results with a recognized climb value. This is the
  project-owner-controlled consumer this section used to describe as
  future work; it now exists.
