#!/usr/bin/env python3
"""Use private local Qwen3-VL grounding to create gated YOLO pseudo-labels."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import cv2
import numpy as np

from qwen_yolo_contract import (
    CLASS_NAMES, FUEL_TASK_PROMPT, ROBOT_TASK_PROMPT, SYSTEM_PROMPT, TASK_PROMPT, acceptance_decision,
    normalize_result, parse_json_response, to_yolo_line,
)


DEFAULT_MODEL = "Qwen/Qwen3-VL-32B-Instruct"
DEFAULT_REVISION = ""
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate conservative Qwen robot and fuel pseudo-labels")
    parser.add_argument("videos", nargs="+", help="Private local match recordings")
    parser.add_argument("--output", required=True, help="Proposal directory (never a train/val/test directory)")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--backend", choices=["ollama", "transformers"], default="ollama")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--ollama-model", default="qwen3.5:latest")
    parser.add_argument("--sample-fps", type=float, default=1.0)
    parser.add_argument("--max-frames", type=int, default=0, help="Maximum frames per video; 0 means all")
    parser.add_argument("--start-seconds", type=float, default=0,
                        help="Skip this many seconds at the start of every video")
    parser.add_argument("--max-new-tokens", type=int, default=1400)
    parser.add_argument("--parse-retries", type=int, default=1,
                        help="Retry malformed/truncated JSON with a larger response budget")
    parser.add_argument("--robot-confidence", type=float, default=0.85)
    parser.add_argument("--fuel-confidence", type=float, default=0.92)
    parser.add_argument("--task", choices=["all", "robots", "fuel"], default="all",
                        help="Use focused robot/fuel prompts when the combined task is too dense")
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True,
                        help="Resume from the checkpoint manifest (default: true)")
    parser.add_argument("--crop", help="Optional normalized x1,y1,x2,y2 crop in 0..1000")
    parser.add_argument("--attention", default="sdpa", choices=["sdpa", "flash_attention_2", "eager"])
    args = parser.parse_args()
    if args.sample_fps <= 0 or args.max_frames < 0 or args.start_seconds < 0 or args.parse_retries < 0:
        parser.error("--sample-fps must be positive; frame/start limits cannot be negative")
    if not 0 <= args.robot_confidence <= 1 or not 0 <= args.fuel_confidence <= 1:
        parser.error("confidence thresholds must be in 0..1")
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
    from transformers import AutoModelForImageTextToText, AutoProcessor

    if not torch.cuda.is_available():
        raise SystemExit("Full BF16 Qwen3-VL inference requires CUDA")
    options = {
        "dtype": torch.bfloat16,
        "device_map": "auto",
        "attn_implementation": attention,
        "low_cpu_mem_usage": True,
    }
    if revision:
        options["revision"] = revision
    model = AutoModelForImageTextToText.from_pretrained(model_name, **options).eval()
    processor_options = {"revision": revision} if revision else {}
    return model, AutoProcessor.from_pretrained(model_name, **processor_options)


def analyze_transformers(model, processor, frame, max_new_tokens: int, task_prompt: str) -> str:
    import torch
    from PIL import Image

    image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    messages = [
        {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
        {"role": "user", "content": [
            {"type": "image", "image": image},
            {"type": "text", "text": task_prompt},
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


def ollama_model_digest(url: str, model_name: str) -> str | None:
    with urlopen(f"{url}/api/tags", timeout=10) as response:
        payload = json.load(response)
    for model in payload.get("models") or []:
        if model.get("name") == model_name or model.get("model") == model_name:
            return str(model.get("digest") or "") or None
    return None


def analyze_ollama(frame, url: str, model_name: str, max_new_tokens: int, task_prompt: str) -> str:
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise RuntimeError("Could not encode frame for local Qwen")
    payload = json.dumps({
        "model": model_name,
        "prompt": f"{SYSTEM_PROMPT}\n\n{task_prompt}",
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


def probe_video_fps(video: Path) -> float:
    command = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json", str(video),
    ]
    try:
        payload = json.loads(subprocess.run(command, check=True, capture_output=True, text=True).stdout)
        stream = payload["streams"][0]
        raw = stream.get("avg_frame_rate") or stream.get("r_frame_rate")
        numerator, denominator = (float(value) for value in raw.split("/"))
        fps = numerator / denominator
    except (subprocess.CalledProcessError, KeyError, IndexError, TypeError, ValueError, ZeroDivisionError) as error:
        raise SystemExit(f"Could not read frame rate with ffprobe: {video}: {error}") from error
    if fps <= 0:
        raise SystemExit(f"Invalid frame rate from ffprobe: {video}: {fps}")
    return fps


def iter_sampled_frames(video: Path, sample_fps: float, max_frames: int, start_seconds: float = 0):
    """Decode through FFmpeg so AV1 YouTube recordings work without OpenCV AV1."""
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
    ]
    if start_seconds:
        command.extend(["-ss", str(start_seconds)])
    command.extend([
        "-i", str(video),
        "-vf", f"fps={sample_fps}",
    ])
    if max_frames:
        command.extend(["-frames:v", str(max_frames)])
    command.extend(["-q:v", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"])
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    buffer = bytearray()
    sample_index = 0
    assert process.stdout is not None
    while chunk := process.stdout.read(64 * 1024):
        buffer.extend(chunk)
        while True:
            start = buffer.find(b"\xff\xd8")
            if start < 0:
                if len(buffer) > 1:
                    del buffer[:-1]
                break
            end = buffer.find(b"\xff\xd9", start + 2)
            if end < 0:
                if start:
                    del buffer[:start]
                break
            encoded = bytes(buffer[start:end + 2])
            del buffer[:end + 2]
            frame = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise RuntimeError(f"FFmpeg produced an undecodable JPEG for {video}")
            timestamp_ms = round((start_seconds + sample_index / sample_fps) * 1000)
            yield sample_index, timestamp_ms, frame
            sample_index += 1
    stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
    return_code = process.wait()
    if return_code:
        raise RuntimeError(f"FFmpeg failed for {video}: {stderr[-2000:]}")


def write_manifest(path: Path, manifest: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def main() -> int:
    args = parse_args()
    task_prompt = {"all": TASK_PROMPT, "robots": ROBOT_TASK_PROMPT, "fuel": FUEL_TASK_PROMPT}[args.task]
    os.umask(0o077)
    videos = [Path(raw).expanduser().resolve() for raw in args.videos]
    for video in videos:
        if not video.is_file() or video.suffix.lower() not in VIDEO_SUFFIXES:
            raise SystemExit(f"Unsupported or missing video: {video}")
    output = Path(args.output).expanduser().resolve()
    frame_dir = output / "frames"
    label_dir = output / "proposed_labels"
    accepted_label_dir = output / "accepted_labels"
    frame_dir.mkdir(parents=True, exist_ok=True)
    label_dir.mkdir(parents=True, exist_ok=True)
    accepted_label_dir.mkdir(parents=True, exist_ok=True)
    output.chmod(0o700)
    frame_dir.chmod(0o700)
    label_dir.chmod(0o700)
    accepted_label_dir.chmod(0o700)
    model = processor = None
    ollama_url = None
    model_digest = None
    if args.backend == "transformers":
        model, processor = load_transformers_model(args.model, args.revision, args.attention)
    else:
        ollama_url = validate_ollama_url(args.ollama_url)
        model_digest = ollama_model_digest(ollama_url, args.ollama_model)
    manifest_path = output / "pseudo-label-manifest.json"
    manifest = {
        "format_version": 2,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "complete": False,
        "backend": args.backend,
        "model": args.model if args.backend == "transformers" else args.ollama_model,
        "model_digest": model_digest,
        "revision": args.revision if args.backend == "transformers" else None,
        "dtype": "bfloat16" if args.backend == "transformers" else "local-quantized",
        "classes": list(CLASS_NAMES),
        "crop_0_1000": args.crop,
        "start_seconds": args.start_seconds,
        "task": args.task,
        "policy": {
            "label_type": "single_model_pseudo_label",
            "approved_as_human_ground_truth": False,
            "training_use": "accepted_labels_only",
            "robot_confidence": args.robot_confidence,
            "fuel_confidence": args.fuel_confidence,
            "requires_match_level_holdout": True,
        },
        "items": [],
    }
    if args.resume and manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        if previous.get("model") != manifest["model"] or previous.get("classes") != manifest["classes"]:
            raise SystemExit("Refusing to resume: model or class vocabulary changed")
        failed_items = [item for item in previous.get("items", []) if item.get("parse_error") or not item.get("result")]
        if failed_items:
            failure_archive = output / "retry-failures.jsonl"
            with failure_archive.open("a", encoding="utf-8") as stream:
                for item in failed_items:
                    stream.write(json.dumps(item) + "\n")
            failure_archive.chmod(0o600)
        previous["items"] = [
            item for item in previous.get("items", [])
            if not item.get("parse_error") and item.get("result")
        ]
        manifest = previous
        manifest["complete"] = False
    items = manifest["items"]
    completed = {(item["source_video"], item["frame_index"]) for item in items}

    for video in videos:
        fps = probe_video_fps(video)
        proposed = 0
        decoded = 0
        for sample_index, timestamp_ms, frame in iter_sampled_frames(
            video, args.sample_fps, args.max_frames, args.start_seconds,
        ):
            decoded += 1
            frame_index = round(timestamp_ms * fps / 1000)
            if (str(video), frame_index) in completed:
                continue
            frame = crop_frame(frame, args.crop)
            stem = f"{source_id(video)}__{timestamp_ms:09d}ms"
            result = None
            raw = ""
            error = None
            attempts = 0
            for attempts in range(1, args.parse_retries + 2):
                token_budget = args.max_new_tokens * attempts
                if args.backend == "transformers":
                    raw = analyze_transformers(model, processor, frame, token_budget, task_prompt)
                else:
                    raw = analyze_ollama(frame, ollama_url, args.ollama_model, token_budget, task_prompt)
                parsed, error = parse_json_response(raw)
                if not error:
                    result, error = normalize_result(parsed)
                if not error:
                    break
            image_path = frame_dir / f"{stem}.jpg"
            label_path = label_dir / f"{stem}.txt"
            accepted_label_path = accepted_label_dir / f"{stem}.txt"
            cv2.imwrite(str(image_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            detections = result["detections"] if result else []
            accepted = []
            for detection in detections:
                is_accepted, rejection_reasons = acceptance_decision(
                    detection,
                    result["image_quality"],
                    robot_confidence=args.robot_confidence,
                    fuel_confidence=args.fuel_confidence,
                )
                detection["label_status"] = "auto_accepted" if is_accepted else "rejected"
                detection["rejection_reasons"] = rejection_reasons
                if is_accepted:
                    accepted.append(detection)
            label_path.write_text("\n".join(to_yolo_line(item) for item in detections) + ("\n" if detections else ""))
            accepted_label_path.write_text("\n".join(to_yolo_line(item) for item in accepted) + ("\n" if accepted else ""))
            items.append({
                "source_video": str(video), "frame_index": frame_index,
                "timestamp_ms": timestamp_ms, "image": str(image_path.relative_to(output)),
                "proposed_label": str(label_path.relative_to(output)),
                "accepted_label": str(accepted_label_path.relative_to(output)),
                "result": result, "parse_error": error, "raw_response": raw,
                "inference_attempts": attempts,
                "label_status": "auto_labeled" if accepted else "no_accepted_labels",
            })
            manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
            write_manifest(manifest_path, manifest)
            proposed += 1
            print(
                f"{video.name} {timestamp_ms}ms: {len(accepted)}/{len(detections)} boxes accepted",
                flush=True,
            )
        if decoded == 0:
            raise RuntimeError(f"FFmpeg decoded zero sampled frames from {video}")

    manifest["complete"] = True
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    write_manifest(manifest_path, manifest)
    print(manifest_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
