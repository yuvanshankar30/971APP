#!/usr/bin/env python3
"""Self-label tiny fuel via HSV geometry plus local Qwen contact-sheet review."""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import cv2
import numpy as np

from bootstrap_qwen_yolo import (
    iter_sampled_frames, ollama_model_digest, probe_video_fps, source_id,
    validate_ollama_url, write_manifest,
)
from qwen_yolo_contract import CLASS_NAMES, to_yolo_line


FUEL_REVIEW_PROMPT = """Each tile in this contact sheet is labeled C0, C1, and
so on. Decide which tiles show one physical yellow FRC 2026 FUEL ball. Reject
yellow tape, signs, lights, clothing, field markings, graphics, glare, robot
parts, and printed images. A partially visible ball is acceptable only when its
round physical boundary is clear. Return only JSON:
{"accepted":[{"id":0,"confidence":0.0,"evidence":"brief visible reason"}],
"notes":"brief text"}"""


def parse_model_json(text: str) -> dict:
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I | re.S)
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.S)
        if not match:
            raise ValueError("Qwen response contains no JSON object")
        parsed = json.loads(match.group())
    if not isinstance(parsed, dict) or not isinstance(parsed.get("accepted"), list):
        raise ValueError("Qwen response lacks accepted array")
    return parsed


def normalize_acceptances(parsed: dict, candidate_count: int) -> dict[int, dict]:
    accepted = {}
    for item in parsed["accepted"]:
        if not isinstance(item, dict):
            continue
        try:
            candidate_id = int(item.get("id"))
            confidence = max(0.0, min(1.0, float(item.get("confidence", 0))))
        except (TypeError, ValueError):
            continue
        if not 0 <= candidate_id < candidate_count:
            continue
        accepted[candidate_id] = {
            "confidence": confidence,
            "evidence": str(item.get("evidence", ""))[:500],
        }
    return accepted


def find_candidates(frame: np.ndarray, hsv_lower, hsv_upper, min_area: float,
                    min_circularity: float, max_candidates: int) -> list[dict]:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(
        hsv, np.array(hsv_lower, dtype=np.uint8), np.array(hsv_upper, dtype=np.uint8),
    )
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = frame.shape[:2]
    candidates = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < min_area or area > width * height * 0.03:
            continue
        perimeter = float(cv2.arcLength(contour, True))
        if perimeter <= 0:
            continue
        circularity = 4 * math.pi * area / (perimeter ** 2)
        if circularity < min_circularity:
            continue
        x, y, box_width, box_height = cv2.boundingRect(contour)
        aspect = box_width / box_height
        if not 0.3 <= aspect <= 3.0:
            continue
        candidates.append({
            "box_px": [x, y, x + box_width, y + box_height],
            "area_px": area,
            "circularity": circularity,
        })
    candidates.sort(key=lambda item: (item["circularity"], item["area_px"]), reverse=True)
    return candidates[:max_candidates]


def candidate_crop(frame: np.ndarray, box: list[int], size: int = 192) -> np.ndarray:
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    center_x, center_y = (x1 + x2) / 2, (y1 + y2) / 2
    side = max(64, 6 * max(x2 - x1, y2 - y1))
    left = max(0, round(center_x - side / 2))
    top = max(0, round(center_y - side / 2))
    right = min(width, round(center_x + side / 2))
    bottom = min(height, round(center_y + side / 2))
    crop = frame[top:bottom, left:right]
    return cv2.resize(crop, (size, size), interpolation=cv2.INTER_LANCZOS4)


def contact_sheet(frame: np.ndarray, candidates: list[dict], tile_size: int = 192) -> np.ndarray:
    columns = min(4, max(1, len(candidates)))
    rows = math.ceil(len(candidates) / columns)
    sheet = np.full((rows * (tile_size + 28), columns * tile_size, 3), 245, dtype=np.uint8)
    for index, candidate in enumerate(candidates):
        row, column = divmod(index, columns)
        top, left = row * (tile_size + 28), column * tile_size
        sheet[top:top + tile_size, left:left + tile_size] = candidate_crop(frame, candidate["box_px"], tile_size)
        cv2.putText(
            sheet, f"C{index}", (left + 5, top + tile_size + 21),
            cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 0), 2, cv2.LINE_AA,
        )
    return sheet


def review_candidates(image: np.ndarray, url: str, model: str, max_tokens: int) -> str:
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 94])
    if not ok:
        raise RuntimeError("Could not encode fuel contact sheet")
    payload = json.dumps({
        "model": model,
        "prompt": FUEL_REVIEW_PROMPT,
        "images": [base64.b64encode(encoded.tobytes()).decode("ascii")],
        "stream": False,
        "format": "json",
        "think": False,
        "options": {"temperature": 0, "num_predict": max_tokens},
    }).encode()
    request = Request(f"{url}/api/generate", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=300) as response:
        return str(json.load(response).get("response") or "")


def detection_from_candidate(candidate: dict, frame_shape, review: dict) -> dict:
    height, width = frame_shape[:2]
    x1, y1, x2, y2 = candidate["box_px"]
    return {
        "class_id": 2,
        "class_name": "fuel",
        "box_0_1000": [
            round(x1 * 1000 / width), round(y1 * 1000 / height),
            round(x2 * 1000 / width), round(y2 * 1000 / height),
        ],
        "confidence": review["confidence"],
        "visible_fraction": 1.0,
        "occlusion": "none",
        "distance": "unknown",
        "motion_blur": "unknown",
        "truncated": False,
        "team_number": None,
        "team_number_confidence": 0.0,
        "state_tags": [],
        "evidence": review["evidence"],
        "candidate_circularity": candidate["circularity"],
        "candidate_area_px": candidate["area_px"],
        "label_status": "auto_accepted",
        "rejection_reasons": [],
    }


def parse_triplet(raw: str) -> tuple[int, int, int]:
    values = tuple(int(value) for value in raw.split(","))
    if len(values) != 3 or not all(0 <= value <= 255 for value in values):
        raise argparse.ArgumentTypeError("HSV values must be h,s,v bytes")
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--ollama-model", default="qwen3-vl:32b-instruct")
    parser.add_argument("--sample-fps", type=float, default=1.0)
    parser.add_argument("--start-seconds", type=float, default=0)
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument("--hsv-lower", type=parse_triplet, default=(20, 100, 100))
    parser.add_argument("--hsv-upper", type=parse_triplet, default=(35, 255, 255))
    parser.add_argument("--min-area", type=float, default=12)
    parser.add_argument("--min-circularity", type=float, default=0.35)
    parser.add_argument("--max-candidates", type=int, default=8,
                        help="Top HSV candidates per contact sheet; dense sheets hurt VLM recall")
    parser.add_argument("--accept-confidence", type=float, default=0.85)
    parser.add_argument("--max-new-tokens", type=int, default=500)
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()
    if args.sample_fps <= 0 or args.start_seconds < 0 or args.max_frames < 0:
        parser.error("sample FPS must be positive and frame/start limits nonnegative")
    if not 0 <= args.accept_confidence <= 1:
        parser.error("--accept-confidence must be in 0..1")

    os.umask(0o077)
    url = validate_ollama_url(args.ollama_url)
    videos = [video.expanduser().resolve() for video in args.videos]
    output = args.output.expanduser().resolve()
    frames_dir = output / "frames"
    labels_dir = output / "accepted_labels"
    frames_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)
    output.chmod(0o700)
    manifest_path = output / "pseudo-label-manifest.json"
    manifest = {
        "format_version": 2, "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(), "complete": False,
        "backend": "hsv_qwen_contact_sheet", "model": args.ollama_model,
        "model_digest": ollama_model_digest(url, args.ollama_model),
        "classes": list(CLASS_NAMES), "task": "fuel_candidates",
        "policy": {"approved_as_human_ground_truth": False,
                   "training_use": "accepted_labels_only",
                   "accept_confidence": args.accept_confidence},
        "items": [],
    }
    if args.resume and manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        if previous.get("model") != manifest["model"] or previous.get("task") != "fuel_candidates":
            raise SystemExit("Refusing to resume: model or task changed")
        manifest = previous
        manifest["complete"] = False
    items = manifest["items"]
    completed = {(item["source_video"], item["frame_index"]) for item in items}

    for video in videos:
        if not video.is_file():
            raise SystemExit(f"Missing video: {video}")
        fps = probe_video_fps(video)
        decoded = 0
        for _, timestamp_ms, frame in iter_sampled_frames(
            video, args.sample_fps, args.max_frames, args.start_seconds,
        ):
            decoded += 1
            frame_index = round(timestamp_ms * fps / 1000)
            if (str(video), frame_index) in completed:
                continue
            candidates = find_candidates(
                frame, args.hsv_lower, args.hsv_upper, args.min_area,
                args.min_circularity, args.max_candidates,
            )
            raw_response = ""
            parse_error = None
            accepted_reviews = {}
            if candidates:
                raw_response = review_candidates(
                    contact_sheet(frame, candidates), url, args.ollama_model, args.max_new_tokens,
                )
                try:
                    accepted_reviews = normalize_acceptances(parse_model_json(raw_response), len(candidates))
                except (ValueError, json.JSONDecodeError) as error:
                    parse_error = str(error)
            detections = [
                detection_from_candidate(candidate, frame.shape, accepted_reviews[index])
                for index, candidate in enumerate(candidates)
                if index in accepted_reviews and accepted_reviews[index]["confidence"] >= args.accept_confidence
            ]
            stem = f"{source_id(video)}__{timestamp_ms:09d}ms"
            image_path = frames_dir / f"{stem}.jpg"
            label_path = labels_dir / f"{stem}.txt"
            cv2.imwrite(str(image_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            label_path.write_text(
                "\n".join(to_yolo_line(detection) for detection in detections)
                + ("\n" if detections else ""), encoding="utf-8",
            )
            items.append({
                "source_video": str(video), "frame_index": frame_index,
                "timestamp_ms": timestamp_ms, "image": str(image_path.relative_to(output)),
                "accepted_label": str(label_path.relative_to(output)),
                "candidate_count": len(candidates),
                "result": {"detections": detections}, "parse_error": parse_error,
                "raw_response": raw_response,
                "label_status": "auto_labeled" if detections else "no_accepted_labels",
            })
            manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
            write_manifest(manifest_path, manifest)
            print(
                f"{video.name} {timestamp_ms}ms: {len(detections)} accepted, "
                f"{len(accepted_reviews)} model-positive, {len(candidates)} candidates",
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
    raise SystemExit(main())
