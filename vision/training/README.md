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
6-class vocabulary, correctly shaped detection head - verified to actually
load and survive a real `model.track()` call) for pointing `VISION_MODEL_PATH`
at while testing `claim`/`heartbeat`/`complete`. Its detections are
meaningless noise; never use it for anything but plumbing verification.

Label reviewed frames in YOLO format using the class vocabulary in
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
recordings. The default is the full BF16 `Qwen3.8-27B`
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

After reviewed seed YOLO weights exist, `bootstrap_yolo_annotate.py` provides
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
