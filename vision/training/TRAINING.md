# Training the Vision Scouting detector

An end-to-end walkthrough for going from "we have a camera" to "a model whose
numbers we'd let into power rankings." `README.md` in this folder is the
command reference; this file is the judgement — how much footage, what to
label, where the process quietly goes wrong, and what has to be true before
anyone flips `approved_for_rankings`.

Nothing here has been run against real footage yet. Every quantity below is a
starting estimate, and the first real dataset should be treated as the thing
that corrects them.

---

## What you are actually training

**Three physical-object classes:**

```
0 robot_red
1 robot_blue
2 fuel
```

Fuel is labeled so the learned detector can eventually be fused with the
existing HSV + contour candidates. The two signals must be deduplicated before
tracking; neither becomes a scored event until a trajectory crosses a calibrated
goal region. Climb attempts, climb success, defense, shooting, and immobility
remain temporal metadata/states rather than object classes.

The detector's whole job is: **find robots and fuel so they can be tracked**.
Everything downstream — trajectories,
attribution, mobility, auto start position, defense — is derived from those
boxes, so box quality is the ceiling on all of it.

---

## Phase 0 — prove the plumbing before collecting anything

Do this first. It takes ten minutes and it means a bad end-to-end run later is
unambiguously a model problem, not a wiring problem.

```bash
cd vision/training
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python create_placeholder_model.py --output /tmp/placeholder.pt
```

Point `VISION_MODEL_PATH` at that file and run a full
`queue-run → claim → complete` cycle. The placeholder has the right class
vocabulary and a correctly shaped head; its detections are **meaningless
noise**. It exists only to exercise the pipeline. Never let its output near a
release.

---

## Phase 1 — collect footage

### Camera placement

The entire pipeline assumes a **fixed, elevated, unmoving** camera. The field
mask, goal zones, start zones, and homography are all calibrated per camera
position, and every one of them is invalidated if the camera moves. Tape it
down. If someone bumps it mid-event, that event's calibration is gone.

Broadcast/TBA footage does **not** satisfy this — it cuts between angles and
zooms, so tracks break at every cut and calibration is meaningless against it.
It's useful for labeling data (see Phase 3), not for live capture.

### Camera settings

From the community R&D this pipeline is adapted from
(chiefdelphi.com/t/computer-vision-scouting/511642): **prioritise shutter speed
over frame rate.** A sharp 30fps robot is far more labelable and trackable than
a motion-blurred 60fps one. Blur destroys both the box and the bumper colour
histogram that `RobotReId` uses to recover identity through occlusion.

Aim for the whole field in frame at a resolution where a robot's bumper is
comfortably more than ~40px wide. 1080p from an elevated corner is a
reasonable starting point.

### How much

| Stage | Matches | Why |
|---|---|---|
| First smoke test | 1 | See what detection actually produces before investing |
| First trainable model | 8–12 | Enough variety in alliance colours and robot designs |
| Competition-usable | 25–40 | Across at least two events/venues if possible |

The number that matters is **variety, not frames**. Twenty matches from one
event under one lighting condition will produce a model that collapses at the
next venue. Two events beats twice as much footage from one.

---

## Phase 2 — extract frames without poisoning your metrics

```bash
.venv/bin/python extract_frames.py recordings/2026casf_qm1_fullfield.mov \
  --output labeling/2026casf_qm1_fullfield --sample-fps 2
```

**Sample at 1–2 fps, not higher.** Adjacent frames at 30fps are nearly
identical; labeling 30 of them costs 30× the effort for almost no new
information, and — far worse — makes leakage between splits nearly certain.

**Put the match key and view label in the source filename.** `validate_splits.py`
derives a source id from the filename stem before `__`, and that is what
enforces the split discipline in Phase 4. Sloppy filenames silently defeat it.

---

## Phase 3 — labeling

### Conservative self-labeling

The seed dataset is generated locally by Qwen3-VL rather than hand-boxed.
Only three physical classes enter YOLO. Qwen's guesses about shooting,
defense, climbing, disability, readable team number, distance, and occlusion
remain manifest metadata. This prevents subjective states from contaminating
the detector vocabulary.

The labeler writes every normalized output to `proposed_labels`, then writes
only detections that pass class-specific confidence, visibility, blur,
occlusion, and geometry gates to `accepted_labels`. Ambiguous evidence is
discarded. Empty accepted files are valid negative examples.

### Practical rules

- Box the **robot**, not the bumper alone, and not the robot plus its game
  pieces.
- Label robots that are **partially occluded** if you can tell where they are —
  occlusion recovery is a real part of the pipeline and needs examples.
- Label robots at the **frame edge** if more than roughly half is visible.
- Do **not** label robots outside the field mask (audience, pits, queueing).
  They're discarded at inference anyway, so labeling them teaches nothing and
  costs time.
- Alliance colour comes from the **bumper**, not from field side.
- Box each physical yellow fuel ball separately. Ignore yellow tape, lights,
  graphics, logos, and printed balls.

### Tooling

Run the private local 32B labeler over sampled frames. The manifest checkpoints
after each frame and resumes by default:

```bash
.venv/bin/python bootstrap_qwen_yolo.py recordings/*.mp4 \
  --output labeling/qwen-v1 --sample-fps 1 \
  --ollama-model qwen3-vl:32b-instruct

# Dense second-round pseudo-labels after seed weights exist.
.venv/bin/python bootstrap_yolo_annotate.py recordings/*.mov \
  --weights vision-models/v1/weights/best.pt \
  --output labeling/round2 --accept-confidence 0.75
```

The intended loop is: Qwen pseudo-labels → deterministic acceptance gates →
train v1 → require Qwen/v1 agreement for round two → train v2. These labels do
not become human ground truth, and model mAP against them measures agreement
with the labeling system rather than true real-world accuracy.

---

## Phase 4 — split by match, never by frame

This is the single easiest way to produce a model that looks excellent and is
worthless.

```bash
.venv/bin/python validate_splits.py /datasets/frc-vision-v1
```

Move **whole matches** into `train`/`val`/`test`. Never randomly shuffle
frames. Frames sampled half a second apart are near-duplicates; a random split
puts near-copies of training images into the test set, and your mAP measures
memorisation rather than generalisation. It will look great and mean nothing.

Better still, split by **event or camera position**, so the test set answers
the question you actually care about: *does this work at a venue it has never
seen?*

Run `validate_splits.py` and make it pass before every training run. Treat a
failure as a hard stop.

Rough target: 70/15/15 train/val/test by match count, with at least 3 matches
in test.

---

## Phase 5 — train

```bash
cp data.example.yaml data.yaml   # edit `path:` to your dataset root
.venv/bin/python train_model.py --data data.yaml --version v1
```

Defaults are `yolo11n.pt`, 100 epochs, `imgsz=1280`, auto batch size.

- **`--imgsz 1280`** matters. Robots at the far end of the field are small; the
  usual 640 default throws away the resolution that distinguishes them.
- **Start with `yolo11n`** (nano). Reach for `yolo11s`/`m` only if nano
  underfits, which with a few thousand frames it probably won't. A bigger model
  on a small dataset mostly buys overfitting and slower inference — and
  inference time is already the throughput constraint on the runner.
- **Version every run.** `--version` is immutable and becomes part of the run
  record; `vision_runs.model_version` is what ties a released scouting number
  back to the exact weights that produced it. Never overwrite a version.

Output: `vision-models/<version>/weights/best.pt` plus a `model-manifest.json`
carrying the test-split metrics and an explicit
`"approved_for_rankings": false`.

---

## Phase 6 — evaluate, and don't stop at mAP

`train_model.py` reports mAP50, mAP50-95, precision and recall on the held-out
test split. **Necessary, not sufficient.** mAP measures boxes on independent
frames; this system's output depends on *tracks over time* and on events
derived from them. A model can post a fine mAP and still be useless because
identity flips every time two robots cross.

Evaluate these separately, on whole videos:

1. **Tracker identity switches.** Run `vision_runner.py` over a full match and
   count how often a robot's canonical id changes. Every switch is a track that
   splits into two, and two half-attributed robots.
2. **Climb confusion.** attempt-vs-success confusion specifically, not lumped
   into overall mAP. This maps directly onto a released `climb_pos`.
3. **Alliance fuel error** against the TBA breakdown. The pipeline already
   computes this — `reconcileWithReference` produces exactly this comparison,
   and `vision/evaluation/evaluate_qwen.py` scores it with configurable
   thresholds:

```bash
.venv/bin/python ../evaluation/evaluate_qwen.py \
  --truth truth/2026casf_qm1.json --predictions exports/2026casf_qm1.json \
  --fail-on-thresholds
```

4. **Calibrated trajectory error**, if you have any ground truth for where
   robots actually were.

A useful sanity check costing nothing: run the model over a match you have
human scouting data for, release nothing, and compare the summary against what
the scouts recorded. Systematic disagreement in one direction is far more
informative than an aggregate score.

---

## Phase 7 — promote it

Promotion is a **human decision**, deliberately. Nothing in `release-run`
checks model quality (this is tracked as an open decision — see A8 in
`docs/plans/scoutingvision-remaining-work.md`).

Before a model's output should be allowed into `scout_data_events`:

- [ ] `validate_splits.py` passes — no source leaks across splits
- [ ] Test split is whole matches, ideally a whole unseen event
- [ ] Identity switches per match measured and acceptable
- [ ] Climb attempt/success confusion measured on whole videos
- [ ] Alliance fuel error against TBA measured across several matches
- [ ] A human has reviewed a full match's observations and agrees with them
- [ ] `model-manifest.json` metrics recorded somewhere durable
- [ ] The version string is immutable and recorded in the run

Then copy the weights to the runner host, set `VISION_MODEL_PATH`, and set
`model_name`/`model_version` on the run form so released rows are traceable to
these exact weights.

---

## Where this goes wrong

| Symptom | Usual cause |
|---|---|
| Excellent mAP, useless in practice | Random frame split — near-duplicate frames leaked into test |
| Model collapses at a new venue | All footage from one event/lighting condition |
| Identity switches constantly | Motion blur (shutter speed) or robots too small — raise `imgsz`, fix the camera |
| Climb attempt/success indistinguishable | Labelers used different rules; no written definition |
| Detects robots in the crowd | Field mask not calibrated for that view |
| Fuel counts wildly wrong | This is *not* the detector — tune HSV/area/circularity per venue |
| Everything unattributed | `identity_map` empty; name robots in review (see `docs/guides/scoutingvision.md`) |

---

## Retraining

Retrain when the venue, lighting, or camera position changes materially, or
when review keeps correcting the same class of mistake. Always as a **new
version** — never overwrite weights an existing run's results were released
from, or you break the link between a released scouting number and the model
that produced it.
