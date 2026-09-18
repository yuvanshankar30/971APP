#!/usr/bin/env python3
"""Add high-confidence v2 pseudo-labels to v2's training split only.

Validation and test images are hard-linked unchanged from v2, which makes the
v2/v3 comparison meaningful and prevents pseudo-label leakage into evaluation.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
from collections import Counter
from pathlib import Path


def link(source: Path, destination: Path):
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manual-dataset", required=True, type=Path)
    parser.add_argument("--pseudo-dataset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manual, pseudo, output = (path.resolve() for path in (args.manual_dataset, args.pseudo_dataset, args.output))
    if output.exists():
        raise SystemExit(f"Refusing to overwrite {output}")
    manifest = json.loads((pseudo / "bootstrap-review.json").read_text())
    items = manifest.get("review_queue", [])
    if len(items) != 1000:
        raise SystemExit(f"Expected exactly 1000 pseudo-label frames, found {len(items)}")
    if any(item.get("priority") != "spot_check" for item in items):
        raise SystemExit("Pseudo dataset contains uncertain detections")
    for split in ("train", "val", "test"):
        for kind in ("images", "labels"):
            destination = output / kind / split
            destination.mkdir(parents=True, mode=0o700)
            for source in (manual / kind / split).iterdir():
                link(source, destination / source.name)
    counts = Counter()
    for item in items:
        image = pseudo / item["image"]
        label = pseudo / item["label"]
        lines = [line for line in label.read_text().splitlines() if line.strip()]
        if not lines:
            raise SystemExit(f"Pseudo-label unexpectedly empty: {label}")
        for line in lines:
            cls, *values = line.split()
            if cls not in {"0", "1"} or len(values) != 4:
                raise SystemExit(f"Invalid pseudo label: {label}")
            counts[int(cls)] += 1
        stem = "pseudo__" + Path(item["image"]).stem
        link(image, output / "images" / "train" / f"{stem}.jpg")
        shutil.copy2(label, output / "labels" / "train" / f"{stem}.txt")
    yaml = output / "robot-data.yaml"
    yaml.write_text(f"path: {output}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n  0: robot_red\n  1: robot_blue\n")
    report = {"source": "manual-v2-plus-v2-high-confidence-pseudo-labels", "manual_dataset": str(manual),
              "pseudo_frames": len(items), "pseudo_labels": {"robot_red": counts[0], "robot_blue": counts[1]},
              "evaluation": "v2 validation and test copied unchanged; pseudo labels train-only"}
    (output / "dataset-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
