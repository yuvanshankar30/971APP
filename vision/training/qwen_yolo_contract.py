"""Validation, metadata normalization, and acceptance gates for Qwen labels."""
from __future__ import annotations

import json
import re


CLASS_NAMES = ("robot_red", "robot_blue", "fuel")
OCCLUSIONS = {"none", "partial", "heavy"}
DISTANCES = {"near", "medium", "far"}
MOTION_BLUR = {"none", "moderate", "heavy"}
CAMERA_VIEWS = {"full_field", "close_up", "replay", "scoreboard", "unknown"}
MATCH_PHASES = {"auto", "teleop", "endgame", "postmatch", "unknown"}
STATE_TAGS = {
    "stationary", "moving", "intaking", "shooting", "defending",
    "climbing", "disabled", "unknown",
}

SYSTEM_PROMPT = """You create conservative object-detection pseudo-labels for
FRC 2026 REBUILT match footage. Return only valid JSON. Never invent objects
hidden by blur, glare, graphics, people, or field structures. Boxes use
[x1,y1,x2,y2] normalized to 0..1000 and must tightly enclose the complete
visible object. Confidence means confidence in both class and box geometry."""
TASK_PROMPT = """Find every visible competition robot and every visible yellow
FUEL game piece that is physically on or above the field.

Use robot_red only when the robot's red alliance bumper is visible. Use
robot_blue only when its blue alliance bumper is visible. Do not guess alliance
from field position. Ignore robots outside the competition field, people,
scoreboard graphics, logos, lights, yellow tape, and printed images. A fuel box
must enclose one physical yellow ball; touching balls get separate boxes when
their boundaries are distinguishable. Include partly occluded objects only when
their visible pixels establish the object and its box location.

team_number is a 1-5 digit bumper number only when readable, otherwise null.
state_tags are metadata guesses, never additional detector classes.
Return exactly:
{"detections":[{"class_name":"robot_red|robot_blue|fuel",
"box":[0,0,0,0],"confidence":0.0,"visible_fraction":0.0,
"occlusion":"none|partial|heavy","distance":"near|medium|far",
"motion_blur":"none|moderate|heavy","truncated":false,
"team_number":null,"team_number_confidence":0.0,
"state_tags":["stationary|moving|intaking|shooting|defending|climbing|disabled|unknown"],
"evidence":"brief visible reason"}],
"image_quality":"good|limited|unusable",
"camera_view":"full_field|close_up|replay|scoreboard|unknown",
"match_phase":"auto|teleop|endgame|postmatch|unknown",
"scene_cut":false,"review_notes":"brief text"}"""

ROBOT_TASK_PROMPT = """Locate every visible FRC competition robot on the field.
Return a tight box around the whole visible robot, not only its bumper. Use
robot_red only when a red bumper is visible and robot_blue only when a blue
bumper is visible. Ignore people, graphics, field structures, and robots outside
the field. Return only JSON:
{"detections":[{"class_name":"robot_red|robot_blue","box":[0,0,0,0],
"confidence":0.0,"visible_fraction":0.0,"occlusion":"none|partial|heavy",
"distance":"near|medium|far","motion_blur":"none|moderate|heavy",
"truncated":false,"team_number":null,"team_number_confidence":0.0,
"state_tags":[],"evidence":"brief visible reason"}],
"image_quality":"good|limited|unusable","camera_view":"full_field|close_up|replay|scoreboard|unknown",
"match_phase":"auto|teleop|endgame|postmatch|unknown","scene_cut":false,"review_notes":""}"""

FUEL_TASK_PROMPT = """Locate every clearly visible physical yellow FUEL ball on
or above the FRC competition field. Put a separate tight box around each ball.
Ignore yellow tape, lights, graphics, logos, and printed images. Return only JSON:
{"detections":[{"class_name":"fuel","box":[0,0,0,0],"confidence":0.0,
"visible_fraction":0.0,"occlusion":"none|partial|heavy","distance":"near|medium|far",
"motion_blur":"none|moderate|heavy","truncated":false,"team_number":null,
"team_number_confidence":0.0,"state_tags":[],"evidence":"brief visible reason"}],
"image_quality":"good|limited|unusable","camera_view":"full_field|close_up|replay|scoreboard|unknown",
"match_phase":"auto|teleop|endgame|postmatch|unknown","scene_cut":false,"review_notes":""}"""


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
            visible_fraction = max(0.0, min(1.0, float(item.get("visible_fraction", 1))))
            team_number_confidence = max(0.0, min(1.0, float(item.get("team_number_confidence", 0))))
        except (TypeError, ValueError):
            continue
        if x2 <= x1 or y2 <= y1:
            continue
        team_number = str(item.get("team_number") or "").strip()
        if not re.fullmatch(r"\d{1,5}", team_number):
            team_number = None
            team_number_confidence = 0.0
        state_tags = item.get("state_tags")
        if not isinstance(state_tags, list):
            state_tags = []
        state_tags = list(dict.fromkeys(str(tag) for tag in state_tags if str(tag) in STATE_TAGS))
        occlusion = item.get("occlusion") if item.get("occlusion") in OCCLUSIONS else "partial"
        distance = item.get("distance") if item.get("distance") in DISTANCES else "medium"
        motion_blur = item.get("motion_blur") if item.get("motion_blur") in MOTION_BLUR else "moderate"
        detections.append({
            "class_id": CLASS_NAMES.index(item["class_name"]),
            "class_name": item["class_name"],
            "box_0_1000": [round(x1), round(y1), round(x2), round(y2)],
            "confidence": confidence,
            "visible_fraction": visible_fraction,
            "occlusion": occlusion,
            "distance": distance,
            "motion_blur": motion_blur,
            "truncated": bool(item.get("truncated", False)),
            "team_number": team_number,
            "team_number_confidence": team_number_confidence,
            "state_tags": state_tags,
            "evidence": str(item.get("evidence", ""))[:500],
            "label_status": "proposed",
        })
    quality = parsed.get("image_quality")
    return {
        "detections": detections,
        "image_quality": quality if quality in {"good", "limited", "unusable"} else "limited",
        "camera_view": parsed.get("camera_view") if parsed.get("camera_view") in CAMERA_VIEWS else "unknown",
        "match_phase": parsed.get("match_phase") if parsed.get("match_phase") in MATCH_PHASES else "unknown",
        "scene_cut": bool(parsed.get("scene_cut", False)),
        "review_notes": str(parsed.get("review_notes", ""))[:1000],
    }, None


def acceptance_decision(detection: dict, image_quality: str,
                        robot_confidence: float = 0.85,
                        fuel_confidence: float = 0.92) -> tuple[bool, list[str]]:
    """Conservative single-model gate; temporal/ensemble gates can add evidence."""
    reasons = []
    threshold = fuel_confidence if detection["class_name"] == "fuel" else robot_confidence
    if image_quality == "unusable":
        reasons.append("unusable_image")
    if detection["confidence"] < threshold:
        reasons.append("low_confidence")
    if detection["occlusion"] == "heavy":
        reasons.append("heavy_occlusion")
    if detection["motion_blur"] == "heavy":
        reasons.append("heavy_motion_blur")
    if detection["visible_fraction"] < (0.7 if detection["class_name"] == "fuel" else 0.5):
        reasons.append("insufficient_visible_fraction")
    if detection["class_name"] == "fuel" and detection["truncated"]:
        reasons.append("truncated_fuel")
    x1, y1, x2, y2 = detection["box_0_1000"]
    width, height = x2 - x1, y2 - y1
    area = width * height / 1_000_000
    aspect = width / height
    if detection["class_name"] == "fuel":
        if area <= 0 or area > 0.08 or not 0.25 <= aspect <= 4.0:
            reasons.append("implausible_fuel_geometry")
    elif area < 0.0001 or area > 0.65 or not 0.15 <= aspect <= 6.0:
        reasons.append("implausible_robot_geometry")
    return not reasons, reasons


def to_yolo_line(detection: dict) -> str:
    x1, y1, x2, y2 = detection["box_0_1000"]
    center_x = (x1 + x2) / 2000
    center_y = (y1 + y2) / 2000
    width = (x2 - x1) / 1000
    height = (y2 - y1) / 1000
    return f"{detection['class_id']} {center_x:.6f} {center_y:.6f} {width:.6f} {height:.6f}"
