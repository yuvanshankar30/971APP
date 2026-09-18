#!/usr/bin/env python3
"""Audit private Qwen labels and prepare a robot-only, match-level YOLO split.

Fuel stays in the audit report but is intentionally omitted from this detector
dataset: the production runner's fuel source of truth is classical HSV/CV.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from collections import Counter, defaultdict
from pathlib import Path


SOURCE_CLASSES = ("robot_red", "robot_blue", "fuel")
ROBOT_CLASSES = ("robot_red", "robot_blue")


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def match_key(source_video: str) -> str:
    # Download names start with the TBA match key and may then contain a video
    # source and hash. All camera sources of the same match must stay together.
    return Path(source_video).stem.split("__", 1)[0]


def split_matches(keys: list[str]) -> dict[str, str]:
    if len(keys) < 5:
        raise SystemExit("Need at least five matches for train/validation/test splits")
    ordered = sorted(keys, key=lambda key: hashlib.sha256(key.encode()).hexdigest())
    holdout = max(1, round(len(ordered) * 0.15))
    validation = max(1, round(len(ordered) * 0.15))
    if holdout + validation >= len(ordered):
        validation = 1
        holdout = 1
    result = {}
    for index, key in enumerate(ordered):
        result[key] = "train" if index < len(ordered) - validation - holdout else "val" if index < len(ordered) - holdout else "test"
    return result


def read_labels(path: Path) -> tuple[list[tuple[int, float, float, float, float]], list[str]]:
    labels, errors = [], []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 5:
            errors.append(f"{path.name}:{line_number}: expected five YOLO fields")
            continue
        try:
            class_id = int(fields[0])
            x, y, width, height = (float(value) for value in fields[1:])
        except ValueError:
            errors.append(f"{path.name}:{line_number}: non-numeric label")
            continue
        if class_id not in range(len(SOURCE_CLASSES)) or not all(0 <= value <= 1 for value in (x, y, width, height)) or width <= 0 or height <= 0:
            errors.append(f"{path.name}:{line_number}: invalid class or normalized box")
            continue
        if x - width / 2 < 0 or x + width / 2 > 1 or y - height / 2 < 0 or y + height / 2 > 1:
            errors.append(f"{path.name}:{line_number}: box extends outside image")
            continue
        labels.append((class_id, x, y, width, height))
    return labels, errors


def link_or_copy(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Merged pseudo-label dataset root")
    parser.add_argument("--output", type=Path, required=True, help="New private robot-only YOLO dataset")
    parser.add_argument("--review-count", type=int, default=30)
    args = parser.parse_args()
    source = args.dataset.expanduser().resolve()
    manifest = json.loads((source / "dataset-manifest.json").read_text(encoding="utf-8"))
    if tuple(manifest.get("classes") or []) != SOURCE_CLASSES:
        raise SystemExit(f"Expected classes {SOURCE_CLASSES}, got {manifest.get('classes')}")
    if args.output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {args.output}")

    items = manifest.get("items") or []
    if not items:
        raise SystemExit("Dataset manifest contains no items")
    keys = sorted({match_key(item["source_video"]) for item in items})
    splits = split_matches(keys)
    digest_matches: dict[str, set[str]] = defaultdict(set)
    for item in items:
        digest = str(item.get("image_sha256") or "")
        if digest:
            digest_matches[digest].add(match_key(item["source_video"]))
    cross_match_duplicates = {digest for digest, keys_for_digest in digest_matches.items() if len(keys_for_digest) > 1}
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, mode=0o700)
    os.chmod(output, 0o700)
    for split in ("train", "val", "test"):
        for kind in ("images", "labels"):
            directory = output / kind / split
            directory.mkdir(parents=True, mode=0o700)
            os.chmod(directory, 0o700)

    errors, warnings = [], []
    source_counts, robot_counts = Counter(), Counter()
    boxes = {name: {"area": [], "aspect": []} for name in SOURCE_CLASSES}
    split_counts, match_counts = Counter(), Counter()
    excluded = Counter()
    review_candidates: list[dict] = []

    for item in items:
        source_image = source / item["image"]
        source_label = source / item["accepted_label"]
        key = match_key(item["source_video"])
        split = splits[key]
        if not source_image.is_file() or not source_label.is_file():
            errors.append(f"Missing image or label for {item.get('image')}")
            continue
        labels, label_errors = read_labels(source_label)
        errors.extend(label_errors)
        robot_total = sum(1 for label in labels if label[0] in (0, 1))
        if robot_total > 6:
            warnings.append(f"{item['image']}: {robot_total} robot labels (more than six robots); excluded")
        for class_id, _x, _y, width, height in labels:
            name = SOURCE_CLASSES[class_id]
            source_counts[name] += 1
            boxes[name]["area"].append(width * height)
            boxes[name]["aspect"].append(width / height)
        digest = str(item.get("image_sha256") or "")
        if digest in cross_match_duplicates:
            warnings.append(f"Exact duplicate image spans match boundaries; excluded")
        if robot_total > 6:
            excluded["more_than_six_robots"] += 1
            continue
        if digest in cross_match_duplicates:
            excluded["cross_match_exact_duplicate"] += 1
            continue

        stem = f"{key}__{Path(item['image']).stem}"
        destination_image = output / "images" / split / f"{stem}.jpg"
        destination_label = output / "labels" / split / f"{stem}.txt"
        link_or_copy(source_image, destination_image)
        robot_lines = [f"{class_id} {x:.6f} {y:.6f} {width:.6f} {height:.6f}" for class_id, x, y, width, height in labels if class_id in (0, 1)]
        for class_id, _x, _y, _width, _height in labels:
            if class_id in (0, 1):
                robot_counts[ROBOT_CLASSES[class_id]] += 1
        destination_label.write_text("\n".join(robot_lines) + ("\n" if robot_lines else ""), encoding="utf-8")
        destination_label.chmod(0o600)
        split_counts[split] += 1
        match_counts[key] += 1
        review_candidates.append({"match_key": key, "split": split, "image": str(destination_image.relative_to(output)), "label": str(destination_label.relative_to(output)), "robot_labels": robot_total})

    if errors:
        raise SystemExit("Audit failed:\n" + "\n".join(errors[:50]))

    # Pick a deterministic, match-diverse sample for independent human review.
    ordered_review = sorted(review_candidates, key=lambda item: hashlib.sha256(item["image"].encode()).hexdigest())
    selected, seen_matches = [], set()
    for item in ordered_review:
        if item["match_key"] not in seen_matches:
            selected.append(item)
            seen_matches.add(item["match_key"])
        if len(selected) >= args.review_count:
            break
    for item in ordered_review:
        if len(selected) >= args.review_count:
            break
        if item not in selected:
            selected.append(item)

    yaml = "\n".join([
        f"path: {output}", "train: images/train", "val: images/val", "test: images/test", "names:",
        "  0: robot_red", "  1: robot_blue", "",
    ])
    (output / "robot-data.yaml").write_text(yaml, encoding="utf-8")
    (output / "robot-data.yaml").chmod(0o600)
    report = {
        "source_dataset": str(source),
        "source_classes": list(SOURCE_CLASSES),
        "training_classes": list(ROBOT_CLASSES),
        "fuel_policy": "excluded_from_yolo_training; retained_for_hsv_comparison",
        "frames": len(items),
        "matches": len(keys),
        "split_frames": dict(split_counts),
        "split_matches": {split: sorted(key for key, value in splits.items() if value == split) for split in ("train", "val", "test")},
        "labels": {"source": dict(source_counts), "robot_training": dict(robot_counts)},
        "excluded_frames": dict(excluded),
        "box_distributions": {name: {metric: {"p05": percentile(values, 0.05), "p50": percentile(values, 0.5), "p95": percentile(values, 0.95)} for metric, values in stats.items()} for name, stats in boxes.items()},
        "warnings": warnings,
        "review_sample": selected,
        "approved_as_human_ground_truth": False,
        "ready_for_baseline": True,
        "not_ready_for_production": ["pseudo-labels are not independent ground truth", "no climb classes", "requires 30-frame human review and held-out evaluation"],
    }
    (output / "audit-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (output / "audit-report.json").chmod(0o600)
    print(json.dumps({"source_frames": len(items), "training_frames": sum(split_counts.values()), "matches": len(keys), "split_frames": dict(split_counts), "robot_labels": dict(robot_counts), "fuel_labels_excluded": source_counts["fuel"], "excluded_frames": dict(excluded), "warnings": len(warnings), "review_sample": len(selected)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
