# Vision pipeline review — 2026-09-13

## Decision

Keep YOLO for dense robot detection. Benchmark a separate learned `fuel`
detector against HSV before replacing ball detection. Keep language models out
of the per-frame counter. Do not deploy an autonomous agent or reserve a large
BF16 model on Spark while training until throughput and memory are measured.

No training, new inference engine, external AI calls, or Spark service changes
were performed by this review. A read-only SSH check using `sudo -n` stopped
because sudo requires a password; current GPU/process/checkpoint state is
therefore unverified. No weights or recordings were found in the repository.

## What the code actually uses

| Task | Implementation | Important limitation |
| --- | --- | --- |
| Robot/climb boxes | Ultralytics 8.3.187, custom six-class YOLO weights; training defaults to `yolo11n.pt` at 1280 px | Generic pretrained COCO weights cannot replace the custom vocabulary; the training README reports no real checkpoint yet |
| Robot tracks | Explicit ByteTrack plus velocity/bumper-colour re-identification | Alliance colour is not a team identity; multi-camera IDs require audited mapping |
| Ball detection | OpenCV HSV threshold, contour area and circularity | Lighting, yellow background objects, small balls, blur, and touching/overlapping balls can defeat it |
| Ball association | `fuel_tracking.PieceTracker`, constant-velocity prediction and globally distance-ordered greedy pairs | Not a full assignment solver; dense streams/crossings can still switch IDs |
| Score proposals | Observed 2D goal entry, origin-to-robot matching in pixel space | A projected hub-region entry does not prove a score; first detection need not be the launch point |
| Semantic clip proposals | `Qwen/Qwen3-VL-30B-A3B-Instruct`, pinned revision, BF16, Transformers `.generate()` behind FastAPI/Uvicorn | Not vLLM, not a per-frame ball detector, and no measured production throughput |

The [pinned Qwen config](https://huggingface.co/Qwen/Qwen3-VL-30B-A3B-Instruct/raw/9c4b90e1e4ba969fd3b5378b57d966d725f1b86c/config.json)
declares `Qwen3VLMoeForConditionalGeneration`. Its architectural class name is not
the public checkpoint name. Training annotation now matches the service's
class, Transformers dependency range, and explicit CUDA placement.

Qwen samples eight frames per five-second clip by default. That is sparse
semantic evidence, not a continuous view of a rapid ball stream. Do not use
its apparent agreement with a count as independent verification that every
ball was visible and counted.

## Bugs fixed in this review

1. Ball pixels were compared to calibrated robot metres during attribution.
   Retain robot pixel centres alongside field positions and use only comparable
   pixel samples, a time window, and a configurable maximum pixel distance.
   Legacy calibrated points without pixel centres are skipped rather than
   treated as pixels.
2. Every track ending in a goal region produced a score. Require an observed
   outside-to-inside transition and emit one provisional candidate at the
   first entry; reject tracks observed only inside a goal.
3. Arbitrary track iteration could steal a detection from a closer track.
   Predict from elapsed-time velocity and match distance-ordered pairs once
   each. This reduces specific synthetic failures, not a claim of real-video
   accuracy.
4. The documented ByteTrack backend was not selected, and `persist=True`
   could carry state across different camera videos. Select `bytetrack.yaml`
   explicitly and use a fresh tracker per video call (tracking still continues
   within the video). See [Ultralytics tracking guidance](https://docs.ultralytics.com/modes/track).
5. Bare-metal install instructions omitted imported modules. Copy
   `apriltag_calibration.py` and `fuel_tracking.py` with the runner. Default the
   example Qwen URL to loopback; the existing optional Compose artifact gets
   an explicit internal-host override. No Docker installation is needed.

All output remains `unreviewed`; release permission and human review remain
mandatory. Existing cross-view/source reconciliation is retained, not assumed
to make every duplicate or attribution error disappear.

Per-run tuning keys (starting guesses, not measured venue settings):
`piece_max_match_distance_px=80`, `piece_max_missed_frames=5`,
`fuel_attribution_distance_px=120`, plus existing HSV/area/circularity keys.
Distances depend on resolution. Do not reuse a pixel threshold across camera
setups without validation.

## Do we need YOLO for balls?

**A benchmark: yes. An immediate untrained production replacement: no.**
The old claim that HSV is inherently more robust is unsupported by a local
held-out dataset. A ball detector should predict a physical `fuel` object,
not `fuel_scored`: scoring is a temporal event, not an object class.

Use a separate dataset/checkpoint to avoid breaking the existing six-class
robot/climb vocabulary. Label visible stationary and airborne fuel and hard
negative backgrounds. Include varied venues, camera distances, motion blur,
occlusion and dense shooting. Keep entire matches/events together in
train/validation/test; tune on validation, not the held-out test set.

Compare HSV and a small YOLO baseline (start with the existing YOLO11 family,
not a dependency upgrade) on identical goal-camera clips. Consider cropped
goal ROIs or higher-resolution inference where full-frame resizing erases
small balls. Measure detection precision/recall by ball size, track ID switches,
per-match alliance count error, shooter attribution, duplicate counts,
latency, and peak memory. Detection mAP alone cannot approve a scorer.
Promote only after human-reviewed whole-match results beat the baseline.

## Agentic harness and model choice

**No agent in the counting loop.** A fixed decode → detect → associate →
propose → reconcile → human-review workflow is sufficient today. Adding an
LLM loop does not recover pixels absent from low-resolution footage.

A future bounded review agent may fetch an ambiguous clip, zoom a calibrated
ROI, inspect tracks and TBA totals, and propose a cited correction. Limit
tool calls/time/cost, use typed outputs, preserve provenance and keep its
tools read-only. It must never approve releases, modify tokens, run shell
commands, or manage Spark services. No such agent is deployed by this PR.

- **Local/private default:** retain the existing Qwen contract for semantic
  proposals, not counting. Serving and precision need a separate measured
  acceptance run.
- **OpenAI candidate:** `gpt-5.6-terra` via Responses with application-owned
  functions is a reasonable balanced starting point for a bounded reviewer;
  evaluate `gpt-5.6-luna` for routine low-cost triage and reserve a stronger
  model for genuinely hard clips. This is a workload recommendation, not a
  benchmark result. [Official model catalog](https://developers.openai.com/api/docs/models),
  [function calling](https://developers.openai.com/api/docs/guides/function-calling).
  Use API model IDs, not a ChatGPT website session/subscription as a backend.
- **DeepSeek v4 candidate:** `deepseek-v4-pro` can review structured textual
  evidence using tool calls. Check the account's current model list before
  integration. The fetched [Responses reference](https://api-docs.deepseek.com/api/create-response/)
  names `deepseek-flash` for image input, whereas older indexed docs still
  mention `deepseek-v4-flash-vision-exp`; do not assume v4-pro sees images or
  hardcode the experimental alias. The
  [compatibility guide](https://api-docs.deepseek.com/guides/responses_api/)
  describes stateless histories and ignored built-in tools/limits: implement
  budgets and tools in our application, not by relying on `max_tool_calls`.

External APIs would transmit selected footage/evidence to a third party and
incur usage charges. None is enabled by default. Outbound HTTPS does not
require an inbound Spark listener, but it is still a separate privacy decision.

## Precision, serving, and training

BF16 is the current reproducibility baseline, not a scoring requirement.
Evaluate a supported quantized Qwen checkpoint or a smaller vision model
against corrected clips before changing it. Do not quietly remove the
runner's current dtype/revision checks: the service health, observation
provenance, and acceptance workflow must change together.

Current inference is native Transformers behind Uvicorn. The
[Qwen model card](https://huggingface.co/Qwen/Qwen3-VL-30B-A3B-Instruct) lists vLLM and
SGLang compatibility, but that does not establish our Spark driver/kernel
compatibility or measured speed. Do not install a new engine on speculation.
Benchmark a bare-metal supported engine in a separate local-only deployment,
with bounded context/concurrency and a memory budget, if semantic throughput
is inadequate. A failed startup is not evidence of a particular deadlock.

For now schedule detector training and large-model inference separately.
Stop only our identified Qwen unit before training, verify reclaimed memory,
and leave unrelated services alone. Do not try to train the 27B language model
as the first step; the missing artifact is a reviewed detector checkpoint.

Training prerequisites: actual recordings, corrected YOLO boxes, match-level
split validation, CUDA-compatible existing runtime, and a verified free-memory
budget. Start with an explicit conservative batch size rather than auto-batch
on a shared unified-memory host. Example once those prerequisites exist:

```bash
sudo -u vision-runner /opt/vision-runner/.venv/bin/python \
  /opt/vision-training/validate_splits.py /datasets/frc-vision-v1
sudo -u vision-runner /opt/vision-runner/.venv/bin/python \
  /opt/vision-training/train_model.py --data /datasets/frc-vision-v1/data.yaml \
  --version robot-climb-v1 --base /models/yolo11n.pt \
  --imgsz 1280 --batch 2 --output /models/training
```

The training scripts and pretrained base must already exist at those paths;
the example does not install them or imply a dataset has been supplied.
Keep Qwen bound to `127.0.0.1:8000`, use the separate token, and use an SSH
tunnel if a remote client needs access. Never bind it to `0.0.0.0` or add a
router/firewall ingress rule. Model caches and recordings belong on Spark or
the chosen file store, not in the small database or Git history.

## Verification

Dependency-free CPU regressions:

```bash
python3 -m unittest discover -s vision/runner -p test_fuel_tracking.py -v
```

They cover crossing/competing tracks, missed frames, one-use association,
pixel/metre separation, time/distance gates, and goal-entry orchestration.
Synthetic tests are not a real-footage benchmark and do not justify release.
