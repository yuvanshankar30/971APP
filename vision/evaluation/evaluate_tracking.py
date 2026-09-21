#!/usr/bin/env python3
"""Compare current and candidate trackers on a private held-out manifest."""
from __future__ import annotations

import argparse
import html
import json
from collections import defaultdict
from pathlib import Path


def iou(left, right):
    ax1, ay1, ax2, ay2 = map(float, left)
    bx1, by1, bx2, by2 = map(float, right)
    intersection = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    union = max(0, ax2 - ax1) * max(0, ay2 - ay1) + max(0, bx2 - bx1) * max(0, by2 - by1) - intersection
    return intersection / union if union else 0


def _group(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[(str(row.get("clip_id")), int(row["frame"]))].append(row)
    return grouped


def load_predictions(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = payload.get("detections", payload) if isinstance(payload, dict) else payload
    return dict(_group(rows))


def evaluate(manifest, predictions, threshold=0.5):
    counts = defaultdict(int)
    mappings = defaultdict(list)
    challenge = defaultdict(lambda: defaultdict(int))
    for clip in manifest.get("clips", []):
        clip_id = str(clip["id"])
        tags = clip.get("challenges") or ["ordinary"]
        truth_by_frame = _group([{**row, "clip_id": clip_id} for row in clip.get("truth", [])])
        frames = sorted({frame for _clip, frame in truth_by_frame} | {frame for _clip, frame in predictions if _clip == clip_id})
        for frame in frames:
            truth = truth_by_frame.get((clip_id, frame), [])
            predicted = predictions.get((clip_id, frame), [])
            remaining = set(range(len(predicted)))
            for actual in truth:
                counts["truth"] += 1
                for tag in tags:
                    challenge[tag]["truth"] += 1
                candidates = [(iou(actual["box"], predicted[index]["box"]), index) for index in remaining]
                score, best = max(candidates, default=(0, -1))
                if score < threshold:
                    counts["missed"] += 1
                    continue
                remaining.remove(best)
                proposal = predicted[best]
                counts["matched"] += 1
                for tag in tags:
                    challenge[tag]["matched"] += 1
                actual_alliance = actual.get("alliance", "unknown")
                proposed_alliance = proposal.get("alliance", "unknown")
                if proposed_alliance == "unknown":
                    counts["alliance_unknown"] += 1
                elif proposed_alliance == actual_alliance:
                    counts["alliance_correct"] += 1
                else:
                    counts["alliance_wrong"] += 1
                mappings[(clip_id, str(actual.get("track_id")))].append((frame, str(proposal.get("track_id"))))
            for index in remaining:
                proposal = predicted[index]
                if any(iou(proposal["box"], actual["box"]) >= threshold for actual in truth):
                    counts["duplicates"] += 1
                else:
                    counts["false_positive"] += 1
    fragments = switches = 0
    for history in mappings.values():
        ordered = [track_id for _, track_id in sorted(history)]
        fragments += max(0, len(set(ordered)) - 1)
        switches += sum(left != right for left, right in zip(ordered, ordered[1:]))
    alliance_total = counts["alliance_correct"] + counts["alliance_wrong"] + counts["alliance_unknown"]
    return {
        "truth_detections": counts["truth"], "matched_detections": counts["matched"],
        "detector_recall": counts["matched"] / counts["truth"] if counts["truth"] else None,
        "false_positives": counts["false_positive"], "duplicate_detections": counts["duplicates"],
        "track_fragmentations": fragments, "id_switches": switches,
        "alliance_color": {
            "correct": counts["alliance_correct"], "wrong": counts["alliance_wrong"],
            "unknown": counts["alliance_unknown"],
            "accuracy": counts["alliance_correct"] / alliance_total if alliance_total else None,
        },
        "challenging_scenes": {
            tag: {"truth": values["truth"], "matched": values["matched"],
                  "recall": values["matched"] / values["truth"] if values["truth"] else None}
            for tag, values in sorted(challenge.items())
        },
    }


def html_report(report):
    rows = []
    for name in ("current", "candidate"):
        metrics = report[name]
        rows.append("<tr><th>{}</th><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
            name, f'{metrics["detector_recall"]:.3f}' if metrics["detector_recall"] is not None else "n/a",
            metrics["duplicate_detections"], metrics["track_fragmentations"], metrics["id_switches"],
            f'{metrics["alliance_color"]["accuracy"]:.3f}' if metrics["alliance_color"]["accuracy"] is not None else "n/a"))
    details = html.escape(json.dumps(report, indent=2))
    return f"<!doctype html><meta charset='utf-8'><title>Vision tracking evaluation</title><h1>Current vs candidate</h1><table border='1'><tr><th>Model</th><th>Recall</th><th>Duplicates</th><th>Fragmentations</th><th>ID switches</th><th>Alliance accuracy</th></tr>{''.join(rows)}</table><h2>Full metrics</h2><pre>{details}</pre>"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--current", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--iou", type=float, default=0.5)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    report = {
        "manifest": str(Path(args.manifest).resolve()), "iou_threshold": args.iou,
        "current": evaluate(manifest, load_predictions(args.current), args.iou),
        "candidate": evaluate(manifest, load_predictions(args.candidate), args.iou),
    }
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    (output / "tracking-evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (output / "tracking-evaluation.html").write_text(html_report(report), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
