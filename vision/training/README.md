# Vision model training

> **New to this? Read [`TRAINING.md`](TRAINING.md) first.** It is the
> end-to-end walkthrough — how much footage to collect, what the labeling rules
> are, why splits must be by match, and what has to be true before a model's
> output is allowed into scouting data. This README is the command reference.

No real trained model exists yet (see `../../docs/plans/scoutingvision-remaining-work.md`).
Before investing in the real labeling/training workflow below, prove the
runner<->API plumbing works end to end with a placeholder:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python create_placeholder_model.py --output /tmp/placeholder.pt
```

This produces a **non-functional** but structurally valid `.pt` file (right
3-class vocabulary, correctly shaped detection head - verified to actually
load and survive a real `model.track()` call) for pointing `VISION_MODEL_PATH`
at while testing `claim`/`heartbeat`/`complete`. Its detections are
meaningless noise; never use it for anything but plumbing verification.

Store accepted pseudo-labeled frames in YOLO format using the class vocabulary in
`data.example.yaml`. Split by complete match and preferably by event/camera
position; random frame splits leak nearly identical adjacent images into the
test set and produce fraudulent metrics.

Extract deterministic frames for labeling (the source filename should include
the match key and view label):

```bash
.venv/bin/python extract_frames.py recordings/2026casf_qm1_fullfield.mov \
  --output labeling/2026casf_qm1_fullfield --sample-fps 2
```

After labeling, move whole match/view groups into `train`, `val`, or `test`
and verify that no source leaks across splits:

```bash
.venv/bin/python validate_splits.py /datasets/frc-vision-v1
```

Qwen3-VL can bootstrap semantic proposals directly from any number of camera
recordings. The semantic clip service defaults to full BF16
`Qwen3-VL-30B-A3B-Instruct`
checkpoint and requires the DGX Spark or comparable CUDA memory:

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python bootstrap_annotate.py recordings/qm1_fullfield.mov \
  recordings/qm1_red_goal.mov recordings/qm1_climb.mov \
  --view-names full-field red-goal climb \
  --output labeling/qm1-qwen-review.json --match-key 2026casf_qm1 \
  --attention sdpa
```

The output contains timestamped, grounded Qwen proposals for robot, fuel,
climb, and immobility evidence. It is always marked unreviewed and is not a
training dataset until a human corrects it. Qwen analyzes bounded five-second
clips rather than blindly consuming an entire match in one context.
It loads BF16 weights without quantization; use the long-lived service under
`vision/qwen/` for repeated production jobs so the checkpoint loads once.

TBA/YouTube footage can be discovered and downloaded directly onto private
storage without running any inbound web service. The downloader prefers 1080p
at 30–60 fps, accepts lower resolution when that is all YouTube provides, and
stores the full TBA score breakdown beside each recording:

```bash
.venv/bin/pip install yt-dlp
.venv/bin/python download_tba_recordings.py 2022cc 2024cc \
  --output /private/vision-data/tba --limit 10 --download
```

Before seed YOLO weights exist, the Spark's local Qwen3-VL 32B Ollama model
can propose red/blue robot boxes from sampled frames. Use a focused prompt;
asking one pass to ground robots and tiny fuel reduces recall. The backend
only accepts a loopback Ollama URL, so frames cannot be sent to a remote host:

```bash
.venv/bin/python bootstrap_qwen_yolo.py /private/vision-data/tba/*/*.mp4 \
  --output /private/vision-data/qwen-pseudo-labels --sample-fps 1 \
  --task robots --ollama-model qwen3-vl:32b-instruct
```

Pass `--backend transformers` to use the full-BF16
`Qwen/Qwen3-VL-32B-Instruct` checkpoint instead. That path requires the Spark
CUDA/Transformers environment and is substantially heavier.

Every model box is preserved under `proposed_labels`. Only boxes that pass the
class-specific confidence, visibility, blur, occlusion, and geometry gates are
written to `accepted_labels`; training must use that directory. These are
pseudo-labels, not human ground truth, and may not be used to claim measured
precision/recall. The checkpoint manifest is written atomically after every
frame so an interrupted run resumes without losing completed work. It records
the immutable Ollama model digest, while the recording inventory records a
SHA-256 for every source video.

Fuel uses a focused path because balls are too small for reliable full-frame
VLM grounding. `bootstrap_fuel_candidates.py` proposes yellow circular regions,
enlarges the strongest eight into a numbered contact sheet, and asks the same
local Qwen model to reject tape, lights, graphics, and robot parts. The contour
provides the final box; Qwen provides the semantic acceptance decision:

```bash
.venv/bin/python bootstrap_fuel_candidates.py recordings/*.mp4 \
  --output labeling/fuel-v1 --sample-fps 1 \
  --ollama-model qwen3-vl:32b-instruct
```

Run `merge_qwen_pseudo_labels.py` on complete focused manifests to produce one
frame/label directory. The merger verifies that aligned passes used identical
image pixels before combining their accepted boxes.

On the Spark, the resumable end-to-end corpus job is:

```bash
nohup bash tools/run_self_label.sh ~/vision-data 2026-self-label-v1 \
  > ~/vision-data/logs/2026-self-label-v1.log 2>&1 &
```

Broadcast layouts that contain picture-in-picture robot cameras should be
cropped to the full-field panel before proposing labels. For example, a top
panel occupying 62.5% of the frame uses `--crop 0,0,1000,625`. Record the crop
in the proposal manifest and inspect it; broadcast layouts can change between
matches.

The acquisition and labeling workflow makes outbound HTTPS requests only for
TBA metadata, YouTube recordings, and explicitly requested model packages. It
does not start an inbound listener. Store the corpus outside the repository in
a mode-0700 directory; the downloader applies that mode automatically.

After seed YOLO weights exist, `bootstrap_yolo_annotate.py` provides
the faster dense pseudo-labeling pass. The hybrid is intentional: Qwen handles
semantic event reasoning, while YOLO/ByteTrack handles repeatable boxes and
trajectories.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp data.example.yaml data.yaml
# edit data.yaml paths, then:
.venv/bin/python train_model.py --data data.yaml --version v1
```

The script trains from a declared base model, evaluates the held-out `test`
split, and emits immutable best weights plus `model-manifest.json`. Detection
mAP is necessary but insufficient: separately evaluate tracker identity
switches, calibrated trajectory error, alliance fuel error, and climb
confusion on whole videos before changing `approved_for_rankings` through a
human-controlled release process.
