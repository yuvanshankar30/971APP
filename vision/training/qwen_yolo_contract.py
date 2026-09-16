"""Validation and YOLO conversion for review-required Qwen box proposals."""
from __future__ import annotations

import json
import re


CLASS_NAMES = ("robot_red", "robot_blue")
SYSTEM_PROMPT = """You propose object-detection labels for human review.
Return only valid JSON. Never invent an object hidden by blur or occlusion.
Boxes use [x1,y1,x2,y2] normalized to 0..1000. Include the complete robot,
not only its bumper. Every output remains unreviewed until a human corrects it."""
TASK_PROMPT = """Find every clearly visible FRC competition robot on the field.
Classify alliance from bumper color as robot_red or robot_blue. Ignore people,
score graphics, robots outside the field, and game pieces. For a robot cut off by
the frame edge, include it only when more than half is visible.
Return exactly: {"detections":[{"class_name":"robot_red|robot_blue",
"box":[0,0,0,0],"confidence":0.0,"evidence":"brief visible reason"}],
"image_quality":"good|limited|unusable","review_notes":"brief text"}"""


def parse_json_response(text: str):
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I | re.S)
    try:
        return json.loads(stripped), None
    except json.JSONDecodeError as error:
        match = re.search(r"\{.*\}", stripped, flags=re.S)
        if match:
            try:
                return json.loads(match.group()), None
            except json.JSONDecodeError:
                pass
        return None, f"Invalid model JSON: {error}"


def normalize_result(parsed):
    if not isinstance(parsed, dict) or not isinstance(parsed.get("detections"), list):
        return None, "Response lacks a detections array"
    detections = []
    for item in parsed["detections"]:
        if not isinstance(item, dict) or item.get("class_name") not in CLASS_NAMES:
            continue
        box = item.get("box")
        if not isinstance(box, list) or len(box) != 4:
            continue
        try:
            x1, y1, x2, y2 = [max(0.0, min(1000.0, float(value))) for value in box]
            confidence = max(0.0, min(1.0, float(item.get("confidence", 0))))
        except (TypeError, ValueError):
            continue
        if x2 <= x1 or y2 <= y1:
            continue
        detections.append({
            "class_id": CLASS_NAMES.index(item["class_name"]),
            "class_name": item["class_name"],
            "box_0_1000": [round(x1), round(y1), round(x2), round(y2)],
            "confidence": confidence,
            "evidence": str(item.get("evidence", ""))[:500],
            "review_status": "unreviewed",
        })
    quality = parsed.get("image_quality")
    return {
        "detections": detections,
        "image_quality": quality if quality in {"good", "limited", "unusable"} else "limited",
        "review_notes": str(parsed.get("review_notes", ""))[:1000],
    }, None


def to_yolo_line(detection: dict) -> str:
    x1, y1, x2, y2 = detection["box_0_1000"]
    center_x = (x1 + x2) / 2000
    center_y = (y1 + y2) / 2000
    width = (x2 - x1) / 1000
    height = (y2 - y1) / 1000
    return f"{detection['class_id']} {center_x:.6f} {center_y:.6f} {width:.6f} {height:.6f}"
