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

Recommended deployment is `../runner/docker-compose.yml` on DGX Spark. It
uses an NVIDIA NGC PyTorch ARM64/CUDA base image compatible with Spark's R580
driver, mounts a persistent model cache, uses BF16 without quantization, and
keeps port 8000 private to the Compose network. The model is placed explicitly
on CUDA because Accelerate's automatic placement treats Spark unified memory as
unavailable and silently offloads inference to the CPU. `/analyze` requires the
separate `VISION_QWEN_TOKEN`.

```bash
cd vision/runner
cp .env.example .env
# Replace both example secrets and add the real YOLO tracker weights.
docker compose up -d --build
docker compose logs -f qwen vision-runner
```

The first start downloads the 60+ GB checkpoint into the persistent cache.
The default `VISION_QWEN_REVISION` is pinned to Hugging Face commit
`1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`; change it only through a new
acceptance run so an upstream update cannot silently alter match results.
