# Qwen3.8 vision service for DGX Spark

Long-lived, authenticated inference service for the full BF16
`Qwen/Qwen3.8-27B` checkpoint. It is separate from
`vision/runner/`: Qwen handles bounded semantic clip analysis while the
runner keeps dense YOLO/ByteTrack trajectories and classical game-piece
tracking deterministic.

The service accepts 2–8 timestamped JPEG frames per request, validates the
model's JSON against `qwen_contract.py`, clamps untrusted coordinates and
timestamps, and serializes inference with one process/one request at a time.
Every returned event is provisional. The runner stores it with
`review_status=unreviewed`; the web API refuses to release it into scouting
data until a human accepts or corrects it.

For this Spark, use the bare-metal `qwen.service` and companion
`../runner/vision-runner.service`; do not install Docker. The Qwen unit binds
only to `127.0.0.1:8000`, not the LAN or public internet. Use `sudo` for host
administration and an SSH tunnel for any remote client. Install the matching
CUDA runtime through the host's approved setup, not an unverified engine
upgrade. `VISION_QWEN_URL=http://127.0.0.1:8000` belongs in the ignored runner
environment. `/analyze` requires the separate `VISION_QWEN_TOKEN`.

The existing optional `../runner/docker-compose.yml` artifact
uses an NVIDIA NGC PyTorch ARM64/CUDA base image compatible with Spark's R580
driver, mounts a persistent model cache, uses BF16 without quantization, and
keeps port 8000 private to the Compose network. The model is placed explicitly
on CUDA because Accelerate's automatic placement treats Spark unified memory as
unavailable and silently offloads inference to the CPU. `/analyze` requires the
separate `VISION_QWEN_TOKEN`.

This describes an existing alternative, not authorization to install or start
it. See `../evaluation/pipeline-review.md` before changing precision or serving
engines. BF16 is the current accepted contract, not a fundamental requirement
of ball tracking; quantized alternatives need evaluation and provenance changes.

The first start downloads the 60+ GB checkpoint into the persistent cache.
The default `VISION_QWEN_REVISION` is pinned to Hugging Face commit
`1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`; change it only through a new
acceptance run so an upstream update cannot silently alter match results.
