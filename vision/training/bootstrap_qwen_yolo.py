#!/usr/bin/env python3
"""Use local Qwen3-VL grounding to create human-review-required YOLO proposals."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import cv2

from qwen_yolo_contract import SYSTEM_PROMPT, TASK_PROMPT, normalize_result, parse_json_response, to_yolo_line


DEFAULT_MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct"
DEFAULT_REVISION = "9c4b90e1e4ba969fd3b5378b57d966d725f1b86c"
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate unreviewed Qwen robot-box proposals")
    parser.add_argument("videos", nargs="+", help="Private local match recordings")
    parser.add_argument("--output", required=True, help="Proposal directory (never a train/val/test directory)")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--backend", choices=["ollama", "transformers"], default="ollama")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--ollama-model", default="qwen3.5:latest")
    parser.add_argument("--sample-fps", type=float, default=1.0)
    parser.add_argument("--max-frames", type=int, default=0, help="Maximum frames per video; 0 means all")
    parser.add_argument("--max-new-tokens", type=int, default=700)
    parser.add_argument("--crop", help="Optional normalized x1,y1,x2,y2 crop in 0..1000")
    parser.add_argument("--attention", default="sdpa", choices=["sdpa", "flash_attention_2", "eager"])
    args = parser.parse_args()
    if args.sample_fps <= 0 or args.max_frames < 0:
        parser.error("--sample-fps must be positive and --max-frames cannot be negative")
    if args.crop:
        try:
            values = [int(value) for value in args.crop.split(",")]
        except ValueError:
            parser.error("--crop must contain four integers")
        if len(values) != 4 or not all(0 <= value <= 1000 for value in values):
            parser.error("--crop must be x1,y1,x2,y2 within 0..1000")
        if values[2] <= values[0] or values[3] <= values[1]:
            parser.error("--crop must have positive width and height")
        args.crop = values
    return args


def load_transformers_model(model_name: str, revision: str, attention: str):
    import torch
    from transformers import AutoProcessor, Qwen3VLMoeForConditionalGeneration

    if not torch.cuda.is_available():
        raise SystemExit("Full BF16 Qwen3-VL inference requires CUDA")
    model = Qwen3VLMoeForConditionalGeneration.from_pretrained(
        model_name,
        dtype=torch.bfloat16,
        device_map="auto",
        revision=revision,
        attn_implementation=attention,
        low_cpu_mem_usage=True,
    ).eval()
    return model, AutoProcessor.from_pretrained(model_name, revision=revision)


def analyze_transformers(model, processor, frame, max_new_tokens: int) -> str:
    import torch
    from PIL import Image

    image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    messages = [
        {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
        {"role": "user", "content": [
            {"type": "image", "image": image},
            {"type": "text", "text": TASK_PROMPT},
        ]},
    ]
    inputs = processor.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True,
        return_dict=True, return_tensors="pt",
    ).to(model.device)
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    trimmed = generated[:, inputs["input_ids"].shape[-1]:]
    return processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]


def validate_ollama_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("--ollama-url must use an HTTP loopback address; remote image upload is forbidden")
    return raw_url.rstrip("/")


def analyze_ollama(frame, url: str, model_name: str, max_new_tokens: int) -> str:
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise RuntimeError("Could not encode frame for local Qwen")
    payload = json.dumps({
        "model": model_name,
        "prompt": f"{SYSTEM_PROMPT}\n\n{TASK_PROMPT}",
        "images": [base64.b64encode(encoded.tobytes()).decode("ascii")],
        "stream": False,
        "format": "json",
        "think": False,
        "options": {"temperature": 0, "num_predict": max_new_tokens},
    }).encode()
    request = Request(f"{url}/api/generate", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=300) as response:
        result = json.load(response)
    return str(result.get("response") or "")


def source_id(path: Path) -> str:
    digest = hashlib.sha256(str(path).encode()).hexdigest()[:8]
    return f"{path.stem.replace(' ', '_')}__{digest}"


def crop_frame(frame, crop):
    if not crop:
        return frame
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = crop
    return frame[
        round(y1 * height / 1000):round(y2 * height / 1000),
        round(x1 * width / 1000):round(x2 * width / 1000),
    ]


def main() -> int:
    args = parse_args()
    os.umask(0o077)
    videos = [Path(raw).expanduser().resolve() for raw in args.videos]
    for video in videos:
        if not video.is_file() or video.suffix.lower() not in VIDEO_SUFFIXES:
            raise SystemExit(f"Unsupported or missing video: {video}")
    output = Path(args.output).expanduser().resolve()
    frame_dir = output / "frames"
    label_dir = output / "proposed_labels"
    frame_dir.mkdir(parents=True, exist_ok=True)
    label_dir.mkdir(parents=True, exist_ok=True)
    output.chmod(0o700)
    frame_dir.chmod(0o700)
    label_dir.chmod(0o700)
    model = processor = None
    ollama_url = None
    if args.backend == "transformers":
        model, processor = load_transformers_model(args.model, args.revision, args.attention)
    else:
        ollama_url = validate_ollama_url(args.ollama_url)
    items = []

    for video in videos:
        capture = cv2.VideoCapture(str(video))
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        if fps <= 0:
            raise SystemExit(f"Could not read frame rate: {video}")
        interval = max(1, round(fps / args.sample_fps))
        frame_index = 0
        proposed = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % interval:
                frame_index += 1
                continue
            frame = crop_frame(frame, args.crop)
            timestamp_ms = round(frame_index * 1000 / fps)
            stem = f"{source_id(video)}__{timestamp_ms:09d}ms"
            if args.backend == "transformers":
                raw = analyze_transformers(model, processor, frame, args.max_new_tokens)
            else:
                raw = analyze_ollama(frame, ollama_url, args.ollama_model, args.max_new_tokens)
            parsed, error = parse_json_response(raw)
            result = None
            if not error:
                result, error = normalize_result(parsed)
            image_path = frame_dir / f"{stem}.jpg"
            label_path = label_dir / f"{stem}.txt"
            cv2.imwrite(str(image_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            detections = result["detections"] if result else []
            label_path.write_text("\n".join(to_yolo_line(item) for item in detections) + ("\n" if detections else ""))
            items.append({
                "source_video": str(video), "frame_index": frame_index,
                "timestamp_ms": timestamp_ms, "image": str(image_path.relative_to(output)),
                "proposed_label": str(label_path.relative_to(output)),
                "result": result, "parse_error": error, "raw_response": raw,
                "review_status": "unreviewed",
            })
            proposed += 1
            print(f"{video.name} {timestamp_ms}ms: {len(detections)} unreviewed boxes", flush=True)
            frame_index += 1
            if args.max_frames and proposed >= args.max_frames:
                break
        capture.release()

    manifest = {
        "format_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "backend": args.backend,
        "model": args.model if args.backend == "transformers" else args.ollama_model,
        "revision": args.revision if args.backend == "transformers" else None,
        "dtype": "bfloat16" if args.backend == "transformers" else "local-quantized",
        "classes": ["robot_red", "robot_blue"],
        "crop_0_1000": args.crop,
        "policy": {
            "human_review_required": True,
            "approved_as_ground_truth": False,
            "training_use_before_review": False,
        },
        "items": items,
    }
    manifest_path = output / "review-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest_path.chmod(0o600)
    print(manifest_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
