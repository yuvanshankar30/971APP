"""Versioned detector-to-runner class contract."""
from __future__ import annotations

import json
from pathlib import Path

CONTRACT_VERSION = "vision-detector/v1"
ROBOT_CLASSES = ("robot_red", "robot_blue")
GENERIC_ROBOT_CLASSES = ("robot",)
OPTIONAL_CLIMB_CLASSES = (
    "climb_attempt", "climb_success", "climb_attempt_red", "climb_attempt_blue",
    "climb_success_red", "climb_success_blue",
)


def ordered_names(names):
    if isinstance(names, dict):
        return tuple(str(names[index]) for index in sorted(names))
    return tuple(str(name) for name in names)


def validate_model_classes(names):
    """Validate semantic names instead of trusting opaque class indexes."""
    classes = ordered_names(names)
    class_set = set(classes)
    if "fuel" in class_set or "fuel_scored" in class_set:
        raise ValueError("Fuel is owned by the trajectory pipeline, not the robot detector")
    unknown = class_set - set(ROBOT_CLASSES) - set(GENERIC_ROBOT_CLASSES) - set(OPTIONAL_CLIMB_CLASSES)
    if unknown:
        raise ValueError(f"Unsupported detector classes: {sorted(unknown)}")
    if set(ROBOT_CLASSES).issubset(class_set):
        profile = "alliance_robot"
    elif class_set.intersection(ROBOT_CLASSES):
        raise ValueError("robot_red and robot_blue must be present together")
    elif "robot" in class_set:
        profile = "generic_robot"
    else:
        raise ValueError("Detector has no supported robot class")
    return {
        "contractVersion": CONTRACT_VERSION,
        "profile": profile,
        "classes": list(classes),
        "capabilities": {
            "robotTracking": True,
            "allianceFromClass": profile == "alliance_robot",
            "climbDetection": any(name in class_set for name in OPTIONAL_CLIMB_CLASSES),
            "fuelDetection": False,
        },
    }


def write_manifest(path, names, *, model_version=None):
    manifest = validate_model_classes(names)
    manifest["modelVersion"] = model_version
    Path(path).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest
