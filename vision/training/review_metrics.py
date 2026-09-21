"""Metrics for the private independent robot-box review."""
from __future__ import annotations


VALID_BOX_VERDICTS = {"correct", "wrong_class", "poor_geometry", "false_positive"}


def calculate_review_metrics(sample, reviews):
    counts = {
        "true_positive": 0, "false_positive": 0, "false_negative": 0,
        "wrong_alliance": 0, "poor_geometry": 0, "unobservable_frames": 0,
    }
    reviewed_frames = 0
    alliance = {"robot_red": {"reviewed": 0, "correct": 0}, "robot_blue": {"reviewed": 0, "correct": 0}}
    for item in sample:
        review = reviews.get(item["image"], {})
        if not review or review.get("verdict") == "unreviewed":
            continue
        reviewed_frames += 1
        if review.get("unobservable") or review.get("verdict") == "unobservable":
            counts["unobservable_frames"] += 1
            continue
        box_reviews = review.get("boxes") or []
        for box in box_reviews:
            verdict = box.get("verdict")
            if verdict not in VALID_BOX_VERDICTS:
                continue
            class_name = box.get("class_name")
            if class_name in alliance:
                alliance[class_name]["reviewed"] += 1
            if verdict == "correct":
                counts["true_positive"] += 1
                if class_name in alliance:
                    alliance[class_name]["correct"] += 1
            elif verdict == "false_positive":
                counts["false_positive"] += 1
            elif verdict == "wrong_class":
                counts["wrong_alliance"] += 1
            elif verdict == "poor_geometry":
                counts["poor_geometry"] += 1
        counts["false_negative"] += max(0, int(review.get("missed_robots") or 0))
    tp, fp, fn = counts["true_positive"], counts["false_positive"], counts["false_negative"]
    observable = reviewed_frames - counts["unobservable_frames"]
    return {
        "sample_frames": len(sample), "reviewed_frames": reviewed_frames,
        "observable_frames": observable, "complete": len(sample) == 30 and reviewed_frames == 30,
        **counts,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "wrong_alliance_rate": counts["wrong_alliance"] / max(1, tp + counts["wrong_alliance"]),
        "poor_geometry_rate": counts["poor_geometry"] / max(1, tp + counts["poor_geometry"]),
        "per_alliance": alliance,
    }
