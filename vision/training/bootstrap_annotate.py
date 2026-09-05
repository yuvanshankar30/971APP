#!/usr/bin/env python3
"""Use Qwen3-VL to propose review-required annotations from match videos."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import torch
from PIL import Image
from transformers import AutoModelForMultimodalLM, AutoProcessor

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "qwen"))
from qwen_contract import SYSTEM_PROMPT, TASK_PROMPT, normalize_result, parse_json_response

DEFAULT_MODEL = "Qwen/Qwen3.8-27B"
DEFAULT_REVISION = "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0"


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", nargs="+", help="One or more synchronized camera recordings")
    parser.add_argument("--output", required=True, help="Output review-manifest path")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--match-key")
    parser.add_argument("--view-names", nargs="*", help="Optional camera name for each video")
    parser.add_argument("--clip-seconds", type=float, default=5)
    parser.add_argument("--frames-per-clip", type=int, default=8)
    parser.add_argument("--max-new-tokens", type=int, default=900)
    parser.add_argument("--attention", default="sdpa", choices=["sdpa", "flash_attention_2", "eager"])
    parser.add_argument("--start-seconds", type=float, default=0)
    parser.add_argument("--end-seconds", type=float)
    args = parser.parse_args()
    if args.clip_seconds <= 0 or args.frames_per_clip < 2:
        parser.error("clip duration must be positive and frames-per-clip must be at least 2")
    if args.view_names and len(args.view_names) != len(args.videos):
        parser.error("--view-names must contain exactly one name per video")
    return args


def load_model(model_name: str, revision: str, attention: str):
    if not torch.cuda.is_available():
        raise SystemExit("Full BF16 Qwen3.8-27B inference requires CUDA")
    model = AutoModelForMultimodalLM.from_pretrained(
        model_name, device_map="auto", torch_dtype=torch.bfloat16,
        revision=revision, attn_implementation=attention, low_cpu_mem_usage=True,
    ).eval()
    processor = AutoProcessor.from_pretrained(model_name, revision=revision)
    return model, processor


def video_metadata(path: Path):
    capture = cv2.VideoCapture(str(path))
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    capture.release()
    if fps <= 0 or frames <= 0:
        raise SystemExit(f"Could not read video metadata: {path}")
    return fps, frames, frames / fps


def clip_frames(path: Path, start_s: float, end_s: float, count: int):
    capture = cv2.VideoCapture(str(path))
    timestamps = [start_s + (end_s - start_s) * index / (count - 1) for index in range(count)]
    output = []
    for timestamp in timestamps:
        capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
        ok, frame = capture.read()
        if not ok:
            continue
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        output.append((round(timestamp * 1000), Image.fromarray(rgb)))
    capture.release()
    return output


def analyze_clip(model, processor, frames, max_new_tokens: int):
    content = []
    for timestamp_ms, image in frames:
        content.extend([
            {"type": "text", "text": f"Frame timestamp_ms={timestamp_ms}"},
            {"type": "image", "image": image},
        ])
    content.append({"type": "text", "text": TASK_PROMPT})
    messages = [
        {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
        {"role": "user", "content": content},
    ]
    inputs = processor.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True,
        return_dict=True, return_tensors="pt",
    ).to(model.device)
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    trimmed = generated[:, inputs["input_ids"].shape[-1]:]
    return processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]


def main():
    args = parse_args()
    videos = [Path(raw).resolve() for raw in args.videos]
    for video in videos:
        if not video.is_file():
            raise SystemExit(f"Missing video: {video}")
    views = args.view_names or [video.stem for video in videos]
    model, processor = load_model(args.model, args.revision, args.attention)
    clips = []

    for video, view_name in zip(videos, views):
        fps, frame_count, duration = video_metadata(video)
        stop = min(args.end_seconds or duration, duration)
        cursor = args.start_seconds
        while cursor < stop:
            clip_end = min(cursor + args.clip_seconds, stop)
            frames = clip_frames(video, cursor, clip_end, args.frames_per_clip)
            raw = analyze_clip(model, processor, frames, args.max_new_tokens)
            parsed, error = parse_json_response(raw)
            normalized = None
            if not error:
                normalized, error = normalize_result(parsed, round(cursor * 1000), round(clip_end * 1000))
            clips.append({
                "view_name": view_name, "source_video": str(video),
                "start_ms": round(cursor * 1000), "end_ms": round(clip_end * 1000),
                "sampled_timestamps_ms": [timestamp for timestamp, _ in frames],
                "result": normalized, "parse_error": error,
                "raw_response": raw, "review_status": "unreviewed",
            })
            print(f"{view_name} {cursor:.1f}-{clip_end:.1f}s: {len(normalized['events']) if normalized else 0} proposals")
            cursor = clip_end

    manifest = {
        "format_version": 2,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "match_key": args.match_key,
        "model": args.model, "revision": args.revision,
        "dtype": "bfloat16", "quantization": "none", "attention": args.attention,
        "policy": {"human_review_required": True, "approved_as_ground_truth": False},
        "clips": clips,
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
