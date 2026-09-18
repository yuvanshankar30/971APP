#!/usr/bin/env python3
"""Create reviewed pseudo-labels from one or more match recordings."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import cv2
from ultralytics import YOLO

VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", nargs="+", help="Recordings from one or more camera views")
    parser.add_argument("--weights", required=True, help="Seed YOLO weights trained on reviewed FRC labels")
    parser.add_argument("--output", required=True, help="Output dataset directory")
    parser.add_argument("--sample-fps", type=float, default=2.0)
    parser.add_argument("--accept-confidence", type=float, default=0.75)
    parser.add_argument("--review-confidence", type=float, default=0.25)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--device", default=None, help="Ultralytics device, such as 0, cpu, or mps")
    parser.add_argument("--match-key", help="Optional match key shared by all supplied views")
    parser.add_argument("--include-empty", action="store_true")
    parser.add_argument("--accepted-only", action="store_true",
                        help="Export only frames where every detected object passed --accept-confidence")
    parser.add_argument("--max-frames", type=int, default=0,
                        help="Stop after this many exported frames across all sources (0 means unlimited)")
    args = parser.parse_args()
    if not 0 <= args.review_confidence <= args.accept_confidence <= 1:
        parser.error("confidence thresholds must satisfy 0 <= review <= accept <= 1")
    if args.sample_fps <= 0:
        parser.error("--sample-fps must be positive")
    if args.max_frames < 0:
        parser.error("--max-frames cannot be negative")
    return args


def safe_source_id(path: Path):
    digest = hashlib.sha256(str(path).encode()).hexdigest()[:8]
    return f"{path.stem.replace(' ', '_')}__{digest}"


def yolo_line(class_id, xywhn):
    values = " ".join(f"{float(value):.6f}" for value in xywhn)
    return f"{int(class_id)} {values}"


def main():
    args = parse_args()
    output = Path(args.output).resolve()
    image_dir = output / "images" / "unreviewed"
    label_dir = output / "labels" / "unreviewed"
    image_dir.mkdir(parents=True, exist_ok=True)
    label_dir.mkdir(parents=True, exist_ok=True)

    model = YOLO(args.weights)
    class_names = {int(key): str(value) for key, value in model.names.items()}
    review_items = []
    sources = []
    totals = Counter()

    stop = False
    for raw_video in args.videos:
        video = Path(raw_video).resolve()
        if not video.is_file() or video.suffix.lower() not in VIDEO_SUFFIXES:
            raise SystemExit(f"Unsupported or missing video: {video}")
        capture = cv2.VideoCapture(str(video))
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if fps <= 0:
            raise SystemExit(f"Could not read frame rate: {video}")
        sample_every = max(1, round(fps / args.sample_fps))
        source_id = safe_source_id(video)
        source_match_key = args.match_key or video.parent.name
        source_counts = Counter()
        options = {"verbose": False, "conf": args.review_confidence, "imgsz": args.imgsz}
        if args.device is not None:
            options["device"] = args.device

        # Decode every frame but invoke the GPU only for the requested sample
        # rate. Calling predict(source=video, stream=True) would infer every
        # 60fps frame and turn a 1,000-frame job into tens of thousands.
        frame_index = -1
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_index += 1
            if frame_index % sample_every:
                continue
            result = model.predict(source=frame, **options)[0]
            timestamp_ms = round(frame_index * 1000 / fps)
            stem = f"{source_id}__{timestamp_ms:09d}ms"
            accepted = []
            candidates = []
            if result.boxes is not None:
                for box in result.boxes:
                    confidence = float(box.conf.item())
                    class_id = int(box.cls.item())
                    status = "accepted" if confidence >= args.accept_confidence else "needs_review"
                    candidate = {
                        "class_id": class_id,
                        "class_name": class_names[class_id],
                        "confidence": confidence,
                        "track_id": int(box.id.item()) if box.id is not None else None,
                        "xyxy": [round(float(value), 2) for value in box.xyxy[0].tolist()],
                        "xywhn": [float(value) for value in box.xywhn[0].tolist()],
                        "status": status,
                    }
                    candidates.append(candidate)
                    source_counts[status] += 1
                    if status == "accepted":
                        accepted.append(yolo_line(class_id, candidate["xywhn"]))

            needs_review = any(item["status"] == "needs_review" for item in candidates)
            if args.accepted_only and needs_review:
                source_counts["frames_rejected_uncertain"] += 1
                continue
            if not (accepted or candidates or args.include_empty):
                continue
            image_path = image_dir / f"{stem}.jpg"
            label_path = label_dir / f"{stem}.txt"
            if not cv2.imwrite(str(image_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 92]):
                raise RuntimeError(f"Could not write {image_path}")
            label_path.write_text("\n".join(accepted) + ("\n" if accepted else ""), encoding="utf-8")
            review_items.append({
                "priority": "review" if needs_review else "spot_check",
                "match_key": source_match_key, "source_video": str(video),
                "source_id": source_id, "frame_index": frame_index,
                "timestamp_ms": timestamp_ms,
                "image": str(image_path.relative_to(output)),
                "label": str(label_path.relative_to(output)),
                "predictions": candidates,
            })
            source_counts["frames_exported"] += 1
            if args.max_frames and totals["frames_exported"] + source_counts["frames_exported"] >= args.max_frames:
                stop = True
                break
        capture.release()

        totals.update(source_counts)
        sources.append({
            "video": str(video), "source_id": source_id, "match_key": source_match_key, "fps": fps,
            "frame_count": frame_count, "counts": dict(source_counts),
        })
        print(f"{video.name}: {source_counts['frames_exported']} frames, {source_counts['needs_review']} uncertain objects")
        if stop:
            break

    review_items.sort(key=lambda item: (
        item["priority"] != "review",
        min((prediction["confidence"] for prediction in item["predictions"]), default=1),
    ))
    manifest = {
        "format_version": 1, "weights": str(Path(args.weights).resolve()),
        "class_names": class_names,
        "thresholds": {"review": args.review_confidence, "accept": args.accept_confidence},
        "sampling_fps": args.sample_fps, "match_key": args.match_key,
        "sources": sources, "totals": dict(totals), "review_queue": review_items,
    }
    manifest_path = output / "bootstrap-review.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Review manifest: {manifest_path}")


if __name__ == "__main__":
    main()
