#!/usr/bin/env python3
"""Keep the existing model unless a self-training candidate wins every metric."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text())
    candidate = json.loads(args.candidate.read_text())
    old, new = baseline["metrics"], candidate["metrics"]
    # Requiring both localization metrics to improve rejects the common
    # self-training failure where loose copied boxes lift mAP50 but degrade
    # precise localization. Recall may drop at most 0.5 percentage points.
    accepted = (new["map50"] > old["map50"] and new["map50_95"] > old["map50_95"]
                and new["recall"] >= old["recall"] - .005)
    chosen = candidate if accepted else baseline
    result = {"chosen_model_version": chosen["model_version"], "chosen_weights": chosen["weights"],
              "self_training_candidate_accepted": accepted,
              "baseline_metrics": old, "candidate_metrics": new,
              "reason": "candidate improved mAP50 and mAP50-95 without material recall regression" if accepted else
                        "kept baseline: candidate did not beat it on the locked held-out metrics"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
