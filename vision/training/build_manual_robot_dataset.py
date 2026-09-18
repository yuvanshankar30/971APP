#!/usr/bin/env python3
"""Build a match-level YOLO dataset solely from manually drawn robot boxes."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from collections import Counter
from pathlib import Path


ROOTS = (
    ('/home/snagaraja/vision-data/datasets/2026-self-label-v1-robot-baseline-audit-v2', 'audit-report.json', 'manual-box-reviews.json'),
    ('/home/snagaraja/vision-data/datasets/2026-self-label-v1-robot-baseline-audit-v2', 'review-assignment-arin.json', 'manual-box-reviews-arin.json'),
    ('/home/snagaraja/vision-data/datasets/2026-self-label-v1-robot-baseline-audit-v2', 'review-assignment-yuvan-shankar.json', 'manual-box-reviews-yuvan-shankar.json'),
    ('/home/snagaraja/vision-data/datasets/manual-review-round2', 'review-assignment-arin-round2.json', 'manual-box-reviews-arin-round2.json'),
)


def split_matches(keys):
    ordered = sorted(keys, key=lambda key: hashlib.sha256(key.encode()).hexdigest())
    holdout = max(1, round(len(ordered) * .15)); validation = max(1, round(len(ordered) * .15))
    return {key: 'train' if index < len(ordered)-holdout-validation else 'val' if index < len(ordered)-holdout else 'test' for index, key in enumerate(ordered)}


def link(source, destination):
    try: os.link(source, destination)
    except OSError: shutil.copy2(source, destination)


def main():
    output = Path('/home/snagaraja/vision-data/datasets/2026-manual-robots-v1')
    if output.exists(): raise SystemExit(f'Refusing to overwrite {output}')
    records = []
    for root_text, manifest_name, review_name in ROOTS:
        root = Path(root_text); manifest = json.loads((root / manifest_name).read_text())
        assignment = manifest['review_sample'] if isinstance(manifest, dict) else manifest
        reviews = json.loads((root / review_name).read_text())
        for item in assignment:
            row = reviews.get(item['image'])
            if not row: continue
            records.append((root, item, row))
    paths = [item['image'] for _root, item, _row in records]
    if len(paths) != len(set(paths)): raise SystemExit('Duplicate annotation image paths')
    matches = sorted({item['match_key'] for _root, item, _row in records})
    splits = split_matches(matches)
    for split in ('train','val','test'):
        (output/'images'/split).mkdir(parents=True, mode=0o700)
        (output/'labels'/split).mkdir(parents=True, mode=0o700)
    counts = Counter(); split_counts = Counter(); negatives = 0
    for root, item, row in records:
        source = root / item['image']; split = splits[item['match_key']]
        stem = Path(item['image']).stem
        destination = output/'images'/split/f"{item['match_key']}__{stem}.jpg"
        link(source, destination)
        lines = []
        for box in row.get('manual_boxes', []):
            cls = {'red': 0, 'blue': 1}.get(box.get('class_name'))
            x,y,w,h = (float(box[key]) for key in ('x','y','w','h'))
            if cls is None or w <= 0 or h <= 0 or x < 0 or y < 0 or x+w > 1 or y+h > 1: raise SystemExit(f'Invalid manual box in {item["image"]}')
            lines.append(f'{cls} {x+w/2:.6f} {y+h/2:.6f} {w:.6f} {h:.6f}'); counts[cls] += 1
        if not lines: negatives += 1
        (output/'labels'/split/f"{item['match_key']}__{stem}.txt").write_text('\n'.join(lines) + ('\n' if lines else ''))
        split_counts[split] += 1
    (output/'robot-data.yaml').write_text(f'path: {output}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n  0: robot_red\n  1: robot_blue\n')
    report = {'source': 'manual-only', 'frames': len(records), 'matches': matches, 'split_frames': dict(split_counts), 'labels': {'robot_red': counts[0], 'robot_blue': counts[1]}, 'negative_frames': negatives, 'excluded_pseudo_labels': True}
    (output/'dataset-report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))


if __name__ == '__main__': main()
