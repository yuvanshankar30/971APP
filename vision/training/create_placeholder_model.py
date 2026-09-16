#!/usr/bin/env python3
"""Creates a NON-FUNCTIONAL placeholder model for exercising the vision
pipeline's plumbing (claim/heartbeat/complete, runner<->API wiring) before a
real trained model exists. This model has the correct class vocabulary and
detection-head shape but has never seen a single real training example - its
detections are meaningless noise. Never point a real VISION_MODEL_PATH
deployment at this; it exists purely so someone can prove the runner<->API
plumbing works end to end before investing in real data collection/labeling/
training (see ../../docs/plans/scoutingvision-remaining-work.md).

Verified during development: this actually runs (built a real 3-class
checkpoint from yolo11n.pt in a temp dir, confirmed the resulting model
loads with the right class names AND survives a real model.track(...) call
the same way vision_runner.py's process_view() calls it - which surfaced a
real, separate gap: ByteTrack's `lap` dependency wasn't in
requirements.txt and had to auto-install at runtime; now pinned there).

Usage:
    pip install -r requirements.txt   # Pillow + ultralytics already listed here
    python create_placeholder_model.py --output /tmp/placeholder.pt
"""
import argparse
import shutil
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from ultralytics import YOLO

# Must match data.example.yaml and the class-name handling in
# vision/runner/vision_runner.py's process_view().
CLASS_NAMES = [
    "robot_red", "robot_blue", "fuel",
]


def build_dummy_dataset(root: Path, image_size: int = 64):
    """One tiny synthetic black image + one dummy centered box per class,
    identically for train/val. This exists ONLY to make ultralytics' own
    trainer reshape the detection head to len(CLASS_NAMES) and produce a
    loadable checkpoint with the right names - it is not real training data.
    A real dataset needs real, distinct, correctly-labeled examples; see
    README.md."""
    for split in ("train", "val"):
        images_dir = root / "images" / split
        labels_dir = root / "labels" / split
        images_dir.mkdir(parents=True, exist_ok=True)
        labels_dir.mkdir(parents=True, exist_ok=True)
        for index, _ in enumerate(CLASS_NAMES):
            image = Image.fromarray(np.zeros((image_size, image_size, 3), dtype=np.uint8))
            image.save(images_dir / f"dummy_{index}.jpg")
            # "class cx cy w h", normalized 0-1 - an arbitrary centered box.
            (labels_dir / f"dummy_{index}.txt").write_text(f"{index} 0.5 0.5 0.4 0.4\n")

    data_yaml = root / "data.yaml"
    names_block = "\n".join(f"  {i}: {name}" for i, name in enumerate(CLASS_NAMES))
    data_yaml.write_text(f"path: {root}\ntrain: images/train\nval: images/val\nnames:\n{names_block}\n")
    return data_yaml


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="yolo11n.pt", help="Base checkpoint to start from (auto-downloaded if not already local)")
    parser.add_argument("--output", default="placeholder-frc-vision.pt", help="Where to write the placeholder weights")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="vision-placeholder-") as tmp:
        tmp_path = Path(tmp)
        data_yaml = build_dummy_dataset(tmp_path)
        model = YOLO(args.base)
        # 1 epoch on the dummy set is enough for ultralytics to reshape the
        # detect head to len(CLASS_NAMES) and emit a loadable checkpoint -
        # this is a shape/plumbing exercise, NOT meaningful training.
        model.train(
            data=str(data_yaml), epochs=1, imgsz=64, batch=2,
            project=str(tmp_path / "runs"), name="placeholder", verbose=False, plots=False,
        )
        trained_weights = tmp_path / "runs" / "placeholder" / "weights" / "best.pt"
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(trained_weights, output_path)

    print(f"\nWrote a NON-FUNCTIONAL placeholder model to {output_path}")
    print("Right class vocabulary and shape; never saw real training data -")
    print("its detections are meaningless. Use it only to test the")
    print("claim/heartbeat/complete plumbing end to end, then replace it with")
    print("a real trained model (see README.md).")


if __name__ == "__main__":
    main()
