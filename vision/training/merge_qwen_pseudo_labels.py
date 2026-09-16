#!/usr/bin/env python3
"""Merge aligned focused Qwen passes into one accepted-label dataset."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from qwen_yolo_contract import CLASS_NAMES, to_yolo_line


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def item_key(item: dict) -> tuple[str, int]:
    return str(item["source_video"]), int(item["frame_index"])


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("classes") != list(CLASS_NAMES):
        raise SystemExit(f"Class vocabulary mismatch in {path}")
    if not manifest.get("complete"):
        raise SystemExit(f"Refusing incomplete manifest: {path}")
    return manifest


def link_or_copy(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifests", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    manifests = [(path.resolve(), load_manifest(path.resolve())) for path in args.manifests]
    output = args.output.resolve()
    frames_dir = output / "frames"
    labels_dir = output / "accepted_labels"
    frames_dir.mkdir(parents=True, exist_ok=False)
    labels_dir.mkdir(parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    os.chmod(frames_dir, 0o700)
    os.chmod(labels_dir, 0o700)

    grouped: dict[tuple[str, int], list[tuple[Path, dict]]] = {}
    for manifest_path, manifest in manifests:
        for item in manifest["items"]:
            grouped.setdefault(item_key(item), []).append((manifest_path.parent, item))

    merged_items = []
    for index, (key, sources) in enumerate(sorted(grouped.items())):
        source_images = [root / item["image"] for root, item in sources]
        hashes = {file_sha256(path) for path in source_images}
        if len(hashes) != 1:
            raise SystemExit(f"Focused passes produced different pixels for {key}")
        stem = f"frame_{index:07d}"
        image_destination = frames_dir / f"{stem}.jpg"
        label_destination = labels_dir / f"{stem}.txt"
        link_or_copy(source_images[0], image_destination)

        detections = []
        for _, item in sources:
            result = item.get("result") or {}
            detections.extend(
                detection for detection in result.get("detections") or []
                if detection.get("label_status") == "auto_accepted"
            )
        detections.sort(key=lambda detection: (
            detection["class_id"], detection["box_0_1000"][0], detection["box_0_1000"][1]
        ))
        label_destination.write_text(
            "\n".join(to_yolo_line(detection) for detection in detections)
            + ("\n" if detections else ""),
            encoding="utf-8",
        )
        merged_items.append({
            "source_video": key[0], "frame_index": key[1],
            "image": str(image_destination.relative_to(output)),
            "accepted_label": str(label_destination.relative_to(output)),
            "detections": detections,
            "source_passes": len(sources),
            "image_sha256": next(iter(hashes)),
        })

    manifest = {
        "format_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "classes": list(CLASS_NAMES),
        "label_type": "merged_qwen_pseudo_label",
        "approved_as_human_ground_truth": False,
        "source_manifests": [str(path) for path, _ in manifests],
        "items": merged_items,
    }
    manifest_path = output / "dataset-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest_path.chmod(0o600)
    print(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
