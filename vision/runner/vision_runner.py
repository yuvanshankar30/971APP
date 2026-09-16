#!/usr/bin/env python3
"""Post-match multi-view ML runner.

Requires custom YOLO weights whose class names use this vocabulary:
robot_red, robot_blue, climb_attempt, climb_success. (Fuel is intentionally
NOT a YOLO class - see "Hybrid game-piece detection" below.)
Robot tracks are never assigned a team unless the queued run config contains
identity_map entries of the form "<view uuid>:<tracker id>": "frc971".

Hybrid game-piece detection and scoring attribution, and the robot
occlusion-recovery (ReID) logic, are adapted from community R&D shared on
Chief Delphi ("Computer Vision Scouting",
chiefdelphi.com/t/computer-vision-scouting/511642) - see
docs/guides/scoutingvision.md for the full writeup of what changed and why.
"""
from __future__ import annotations

import base64
import json
import math
import os
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
import requests
from ultralytics import YOLO

from apriltag_calibration import probe_recording
from fuel_tracking import PieceTracker, goal_entry, nearest_pixel_track

API = os.environ["VISION_API_URL"].rstrip("/") + "/api/vision-runner"
TOKEN = os.environ["VISION_RUNNER_TOKEN"]
RUNNER_ID = os.environ.get("VISION_RUNNER_ID", "vision-runner-local")
WEIGHTS = os.environ["VISION_MODEL_PATH"]
POLL_SECONDS = int(os.environ.get("VISION_POLL_SECONDS", "10"))
QWEN_URL = os.environ.get("VISION_QWEN_URL", "").rstrip("/")
QWEN_TOKEN = os.environ.get("VISION_QWEN_TOKEN", "")
QWEN_MODEL = os.environ.get("VISION_QWEN_MODEL", "Qwen/Qwen3-VL-30B-A3B-Instruct")
QWEN_REVISION = os.environ.get("VISION_QWEN_REVISION", "9c4b90e1e4ba969fd3b5378b57d966d725f1b86c")
QWEN_REQUIRED = os.environ.get("VISION_QWEN_REQUIRED", "true").lower() in {"1", "true", "yes"}
QWEN_CLIP_SECONDS = float(os.environ.get("VISION_QWEN_CLIP_SECONDS", "5"))
QWEN_FRAMES_PER_CLIP = int(os.environ.get("VISION_QWEN_FRAMES_PER_CLIP", "8"))
QWEN_MAX_IMAGES = max(2, int(os.environ.get("VISION_QWEN_MAX_IMAGES", "8")))
QWEN_JPEG_WIDTH = int(os.environ.get("VISION_QWEN_JPEG_WIDTH", "1280"))
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# Defaults for the hybrid game-piece pipeline. All overridable per run via
# vision_runs.config - a single hardcoded HSV range doesn't survive a venue
# with different lighting, which is exactly the calibration problem the
# source community post flags ("HSV thresholds tuned per venue").
DEFAULT_HSV_LOWER = (20, 100, 100)   # yellow/orange game piece, generic starting point
DEFAULT_HSV_UPPER = (35, 255, 255)
DEFAULT_MIN_PIECE_AREA = 40
DEFAULT_MIN_CIRCULARITY = 0.55


def api(action: str, **payload):
    response = requests.post(API, headers=HEADERS, json={"action": action, **payload}, timeout=120)
    response.raise_for_status()
    return response.json()


def qwen_health():
    if not QWEN_URL:
        return {"ready": False, "error": "VISION_QWEN_URL is not configured"}
    try:
        response = requests.get(f"{QWEN_URL}/health", timeout=5)
        response.raise_for_status()
        return response.json()
    except Exception as error:
        return {"ready": False, "error": str(error)}


def download(url: str, target: Path):
    with requests.get(url, stream=True, timeout=3600) as response:
        response.raise_for_status()
        with target.open("wb") as output:
            for chunk in response.iter_content(1024 * 1024):
                output.write(chunk)


def phase_for_timestamp(timestamp_ms, config):
    if timestamp_ms < int(config.get("auto_end_ms", 15_000)):
        return "auto"
    if timestamp_ms >= int(config.get("endgame_start_ms", 135_000)):
        return "endgame"
    return "teleop"


def sample_qwen_clip(video_path, start_ms, end_ms, count):
    capture = cv2.VideoCapture(str(video_path))
    timestamps = [round(start_ms + (end_ms - start_ms) * index / (count - 1)) for index in range(count)]
    frames = []
    for timestamp_ms in timestamps:
        capture.set(cv2.CAP_PROP_POS_MSEC, timestamp_ms)
        ok, frame = capture.read()
        if not ok:
            continue
        if frame.shape[1] > QWEN_JPEG_WIDTH:
            scale = QWEN_JPEG_WIDTH / frame.shape[1]
            frame = cv2.resize(frame, (QWEN_JPEG_WIDTH, round(frame.shape[0] * scale)), interpolation=cv2.INTER_AREA)
        encoded, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
        if encoded:
            frames.append({"timestamp_ms": timestamp_ms, "jpeg_base64": base64.b64encode(jpeg).decode("ascii")})
    capture.release()
    return frames


def qwen_box_point(box_0_1000, frame_shape, homography):
    """Qwen boxes are [x1,y1,x2,y2] normalized to 0..1000 of whatever frame the
    model was shown, so they survive sample_qwen_clip()'s JPEG downscale
    unchanged. Convert the box centre back to pixels and push it through the
    same homography the robot tracks used, so both end up in one space."""
    if not box_0_1000 or len(box_0_1000) != 4:
        return None
    height, width = frame_shape[:2]
    center = (
        (float(box_0_1000[0]) + float(box_0_1000[2])) / 2 / 1000 * width,
        (float(box_0_1000[1]) + float(box_0_1000[3])) / 2 / 1000 * height,
    )
    x, y, _calibrated = field_point(center, homography)
    return x, y


# Qwen events whose box sits on the robot performing the action, so matching it
# to the nearest robot track is meaningful. fuel_scored is deliberately absent:
# its box is at the goal, not at the shooter, and attributing it to whichever
# robot is closest to the goal is the exact mistake attribute_scores() traces
# piece trajectories back to their origin to avoid. Qwen fuel stays
# alliance-level and serves only as a cross-check against the classical-CV
# pipeline, which remains the sole source of truth for who scored fuel.
ROBOT_CENTRED_QWEN_EVENTS = {"climb_attempt", "climb_success", "disabled_or_immobile"}


def nearest_track(point, robot_tracks, timestamp_ms, alliance=None, max_distance=None, window_ms=500):
    """The robot track closest to `point` at `timestamp_ms`, as (track,
    distance). Shared by every attribution path so they agree on what "the
    robot this happened to" means: same alliance if one is known, a trajectory
    sample within `window_ms`, then nearest by distance in whatever space
    field_point() put both in."""
    best_track, best_distance = None, None
    for track in robot_tracks:
        if alliance and track.get("alliance") != alliance:
            continue
        closest = min(track["trajectory"], key=lambda p: abs(p["t"] - timestamp_ms), default=None)
        if not closest or abs(closest["t"] - timestamp_ms) > window_ms:
            continue
        distance = math.hypot(closest["x"] - point[0], closest["y"] - point[1])
        if best_distance is None or distance < best_distance:
            best_track, best_distance = track, distance
    if best_track is not None and max_distance is not None and best_distance > float(max_distance):
        return None, best_distance
    return best_track, best_distance


def attribute_qwen_event(event, robot_tracks, timestamp_ms, frame_shape, homography, max_distance):
    """Resolve a Qwen event to the robot track it happened on. Returns
    (track, distance); track is None when nothing matched. Attribution is only
    ever a pre-filled suggestion - the observation still lands as
    review_status=unreviewed and cannot reach scouting data until a human
    accepts or corrects it."""
    if event.get("type") not in ROBOT_CENTRED_QWEN_EVENTS or frame_shape is None:
        return None, None
    point = qwen_box_point(event.get("box_0_1000"), frame_shape, homography)
    if point is None:
        return None, None
    alliance = event.get("alliance") if event.get("alliance") in {"red", "blue"} else None
    return nearest_track(point, robot_tracks, timestamp_ms, alliance, max_distance)


def qwen_event_to_observation(event, view, config, clip, response, robot_tracks=(), frame_shape=None):
    event_type = event.get("type")
    observation_type = {
        "fuel_scored": "fuel_scored",
        "climb_attempt": "climb_attempt",
        "climb_success": "climb_success",
        "disabled_or_immobile": "disabled",
    }.get(event_type)
    if not observation_type:
        return None
    timestamp_ms = int(event["timestamp_ms"]) + int(view.get("sync_offset_ms") or 0)
    value = {"count": 1} if observation_type == "fuel_scored" else {}
    if observation_type.startswith("climb"):
        value["level"] = event.get("climb_level") or config.get("default_climb_level")
    track, distance = attribute_qwen_event(
        event, robot_tracks, timestamp_ms, frame_shape, view.get("homography"),
        config.get("qwen_attribution_max_distance"),
    )
    alliance = event.get("alliance") if event.get("alliance") in {"red", "blue"} else None
    return {
        "view_id": view["id"],
        "team_key": track["team_key"] if track else None,
        "track_key": track.get("track_key") if track else None,
        "alliance": alliance or (track["alliance"] if track else None),
        "phase": phase_for_timestamp(timestamp_ms, config),
        "observation_type": observation_type, "value": value,
        "started_ms": timestamp_ms, "ended_ms": timestamp_ms,
        "confidence": float(event.get("confidence") or 0),
        "source": "qwen3_vl", "review_status": "unreviewed",
        "evidence": {
            "source": "qwen3_vl", "model": response.get("model", QWEN_MODEL),
            "revision": response.get("revision", QWEN_REVISION),
            "dtype": response.get("dtype", "bfloat16"),
            "box_0_1000": event.get("box_0_1000"),
            "explanation": event.get("evidence"),
            "clip_start_ms": clip[0], "clip_end_ms": clip[1],
            "latency_ms": response.get("latency_ms"),
            "attribution_distance": distance,
            "attributed_from_track": bool(track),
            "review_required": True,
        },
    }


def qwen_error_detail(error):
    """Prefer the service's own response body - a 422 carries the raw model
    text that failed to parse, which is what a reviewer actually needs."""
    response = getattr(error, "response", None)
    if response is not None:
        try:
            return response.text[:4000]
        except Exception:
            pass
    return str(error)[:4000]


def analyze_view_with_qwen(view, config, video_path, match_key=None, robot_tracks=(), on_progress=None):
    if not QWEN_URL:
        if QWEN_REQUIRED:
            raise RuntimeError("VISION_QWEN_URL is required but not configured")
        return [], []
    capture = cv2.VideoCapture(str(video_path))
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frame_shape = (
        int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
        int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
    )
    capture.release()
    if fps <= 0 or frame_count <= 0:
        raise RuntimeError(f"Could not read video for Qwen: {video_path}")
    if frame_shape[0] <= 0 or frame_shape[1] <= 0:
        frame_shape = None  # no usable dimensions, so no box->track attribution
    duration_ms = round(frame_count * 1000 / fps)
    clip_ms = max(1000, round(float(config.get("qwen_clip_seconds", QWEN_CLIP_SECONDS)) * 1000))
    frame_count_per_clip = max(
        2,
        min(QWEN_MAX_IMAGES, int(config.get("qwen_frames_per_clip", QWEN_FRAMES_PER_CLIP))),
    )
    observations = []
    clips = []
    start_ms = 0
    analyzed = 0
    failed = 0
    while start_ms < duration_ms:
        end_ms = min(start_ms + clip_ms, duration_ms)
        frames = sample_qwen_clip(video_path, start_ms, end_ms, frame_count_per_clip)
        if len(frames) < 2:
            start_ms = end_ms
            continue
        try:
            response = requests.post(
                f"{QWEN_URL}/analyze",
                headers={"Authorization": f"Bearer {QWEN_TOKEN}", "Content-Type": "application/json"},
                json={
                    "match_key": match_key, "view_id": view["id"],
                    "view_label": view.get("label"), "clip_start_ms": start_ms,
                    "clip_end_ms": end_ms, "frames": frames,
                }, timeout=900,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as error:
            # The service answers 422 whenever the model emits unparseable
            # JSON, which over dozens of clips is a matter of when, not if.
            # Losing one clip must not discard the whole run's YOLO tracks and
            # classical-CV work, so record the gap as an unusable clip a
            # reviewer can see and carry on.
            failed += 1
            clips.append({
                "view_id": view["id"], "started_ms": start_ms, "ended_ms": end_ms,
                "model": QWEN_MODEL, "revision": QWEN_REVISION, "dtype": "bfloat16",
                "latency_ms": None, "clip_quality": "unusable", "event_count": 0,
                "normalized_result": {"error": str(error)[:500]},
                "raw_response": qwen_error_detail(error),
            })
            start_ms = end_ms
            if on_progress:
                on_progress()
            continue
        analyzed += 1
        result = payload.get("result", {})
        clips.append({
            "view_id": view["id"], "started_ms": start_ms, "ended_ms": end_ms,
            "model": payload.get("model", QWEN_MODEL),
            "revision": payload.get("revision", QWEN_REVISION),
            "dtype": payload.get("dtype", "bfloat16"),
            "latency_ms": payload.get("latency_ms"),
            "clip_quality": result.get("clip_quality"),
            "event_count": len(result.get("events", [])),
            "normalized_result": result,
            "raw_response": payload.get("raw_response", ""),
        })
        for event in result.get("events", []):
            observation = qwen_event_to_observation(
                event, view, config, (start_ms, end_ms), payload, robot_tracks, frame_shape,
            )
            if observation:
                observations.append(observation)
        start_ms = end_ms
        # A whole-match Qwen pass is dozens of serialized inferences and can
        # run for many minutes. Without a ping per clip the fleet dashboard's
        # 60s online threshold reads a hard-at-work runner as offline, and a
        # genuinely hung one becomes indistinguishable from a busy one.
        if on_progress:
            on_progress()
    # Tolerating individual clips is not the same as tolerating a dead service:
    # a run where nothing succeeded would otherwise complete "successfully"
    # with no Qwen data at all, and its silence would read as agreement with
    # the deterministic pipeline instead of an outage.
    if failed and not analyzed:
        raise RuntimeError(
            f"Every Qwen clip failed for view {view.get('label') or view['id']} ({failed} clips)"
        )
    return observations, clips


def field_point(center, homography):
    if not homography:
        return float(center[0]), float(center[1]), False
    matrix = np.asarray(homography, dtype=np.float64).reshape(3, 3)
    point = cv2.perspectiveTransform(np.asarray([[center]], dtype=np.float32), matrix)[0][0]
    return float(point[0]), float(point[1]), True


def build_mask(polygon_points, frame_shape):
    """polygon_points are normalized (0-1) [x, y] pairs - resolution-
    independent so the same calibration works regardless of capture
    resolution. Returns None (no masking) if no polygon was calibrated."""
    if not polygon_points:
        return None
    height, width = frame_shape[:2]
    pixels = np.array([[int(x * width), int(y * height)] for x, y in polygon_points], dtype=np.int32)
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(mask, [pixels], 255)
    return mask


def point_in_zone(point, polygon_points, frame_shape):
    if not polygon_points:
        return False
    height, width = frame_shape[:2]
    pixels = np.array([[px * width, py * height] for px, py in polygon_points], dtype=np.float32)
    return cv2.pointPolygonTest(pixels, (float(point[0]), float(point[1])), False) >= 0


def bumper_histogram(frame, box_xyxy):
    """Color histogram of a robot's bumper region (bottom third of its
    bounding box - the most consistent, least-occluded, alliance-colored
    surface), used to re-identify a robot across a brief occlusion. HSV
    hue+saturation only (ignores value/brightness), so it's stable across
    shadows and camera exposure drift within one recording."""
    x1, y1, x2, y2 = [int(v) for v in box_xyxy]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
    if x2 <= x1 or y2 <= y1:
        return None
    bumper_top = y1 + int((y2 - y1) * 0.66)
    crop = frame[bumper_top:y2, x1:x2]
    if crop.size == 0:
        return None
    hsv_crop = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv_crop], [0, 1], None, [30, 32], [0, 180, 0, 256])
    cv2.normalize(histogram, histogram, 0, 1, cv2.NORM_MINMAX)
    return histogram


class RobotReId:
    """Recovers a robot's tracker identity across a brief occlusion instead
    of letting the tracker mint a brand-new id for the same physical robot
    (which would otherwise silently split one robot's real trajectory/
    identity_map entry into two unrelated tracks).

    Two independent signals must both agree before a recovery is accepted:
    1. Position: the lost track's last known velocity projects forward to
       roughly where the new detection actually is.
    2. Appearance: the new detection's bumper-color histogram is similar
       enough to the lost track's - position alone is ambiguous whenever
       multiple same-alliance robots are near each other.
    """

    def __init__(self, max_lost_frames=45, max_position_error_px=150, min_histogram_similarity=0.55):
        self.max_lost_frames = max_lost_frames
        self.max_position_error_px = max_position_error_px
        self.min_histogram_similarity = min_histogram_similarity
        self._lost = {}   # canonical_id -> {position, velocity, histogram, alliance, lost_at_frame}
        self._remap = {}  # this run's raw tracker_id -> canonical_id it was recovered as

    def resolve(self, raw_tracker_id, frame_index, position, histogram, alliance):
        """Call once per detection per frame. Returns the canonical id to
        track this detection under - either raw_tracker_id itself, or a
        recovered id from a track that had gone missing."""
        if raw_tracker_id in self._remap:
            return self._remap[raw_tracker_id]
        recovered = self._best_lost_match(frame_index, position, histogram, alliance)
        if recovered is not None:
            self._remap[raw_tracker_id] = recovered
            del self._lost[recovered]
            return recovered
        return raw_tracker_id

    def _best_lost_match(self, frame_index, position, histogram, alliance):
        if histogram is None:
            return None
        best_id, best_similarity = None, self.min_histogram_similarity
        for lost_id, lost in self._lost.items():
            if lost["alliance"] != alliance:
                continue
            frames_gone = frame_index - lost["lost_at_frame"]
            if not (0 < frames_gone <= self.max_lost_frames):
                continue
            predicted_x = lost["position"][0] + lost["velocity"][0] * frames_gone
            predicted_y = lost["position"][1] + lost["velocity"][1] * frames_gone
            position_error = math.hypot(position[0] - predicted_x, position[1] - predicted_y)
            if position_error > self.max_position_error_px:
                continue
            if lost["histogram"] is None:
                continue
            similarity = cv2.compareHist(histogram, lost["histogram"], cv2.HISTCMP_CORREL)
            if similarity > best_similarity:
                best_id, best_similarity = lost_id, similarity
        return best_id

    def mark_lost(self, canonical_id, frame_index, position, velocity, histogram, alliance):
        """Call for every canonical id that was tracked last frame but had
        no matching detection this frame - it may be occluded and about to
        reappear, or it may be genuinely gone (left the ROI, match ended).
        Either way it's cheap to remember for max_lost_frames and harmless
        if never reclaimed."""
        self._lost[canonical_id] = {
            "position": position, "velocity": velocity, "histogram": histogram,
            "alliance": alliance, "lost_at_frame": frame_index
        }


# --- Hybrid game-piece detection ------------------------------------------
# Chosen over a YOLO class for game pieces specifically: per the source
# community R&D, training a detector for small, fast-moving balls at a
# distance needs reviewed labels. HSV is a cheap baseline, NOT a proven
# accuracy winner: lighting, blur, occlusion and overlapping balls can defeat
# it. Compare against a trained fuel detector on whole-match held-out footage.

def detect_game_pieces(frame, mask, hsv_lower, hsv_upper, min_area, min_circularity):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    color_mask = cv2.inRange(hsv, np.array(hsv_lower, dtype=np.uint8), np.array(hsv_upper, dtype=np.uint8))
    if mask is not None:
        color_mask = cv2.bitwise_and(color_mask, mask)
    contours, _ = cv2.findContours(color_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    centers = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area:
            continue
        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            continue
        # 1.0 is a perfect circle; this is a minimum-similarity filter, not
        # an equality check - real detections are never exact circles.
        circularity = 4 * math.pi * area / (perimeter ** 2)
        if circularity < min_circularity:
            continue
        moments = cv2.moments(contour)
        if moments["m00"] == 0:
            continue
        centers.append((moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]))
    return centers


def resolve_auto_start_zone(pixel_center, start_zones, frame_shape):
    """Name the region a robot was sitting in when auto began.

    Done here rather than server-side because the comparison only makes sense
    in this coordinate space: start_zones polygons are normalized 0-1, and
    point_in_zone scales them by frame_shape to match a *pixel* centre. A
    stored trajectory point is in field units whenever a homography is
    calibrated, so the same check server-side would silently never match."""
    if not start_zones or pixel_center is None or frame_shape is None:
        return None
    for zone in start_zones:
        if point_in_zone(pixel_center, zone.get("polygon"), frame_shape):
            return zone.get("label")
    return None


def attribute_climbs(detections, robot_tracks, view, config):
    """YOLO's climb classes fire on the climbing structure, not on a tracked
    robot, so they arrive with no identity of their own and used to be released
    as permanently unattributed. Resolve each to the robot track nearest it at
    that moment, which gives it a team as soon as that robot is named."""
    homography = view.get("homography")
    max_distance = config.get("climb_attribution_max_distance")
    observations = []
    for detection in detections:
        x, y, _calibrated = field_point(detection["center"], homography)
        track, distance = nearest_track(
            (x, y), robot_tracks, detection["timestamp_ms"], detection["alliance"], max_distance,
        )
        observations.append({
            "view_id": view["id"],
            "team_key": track["team_key"] if track else None,
            "track_key": track.get("track_key") if track else None,
            "alliance": detection["alliance"] or (track["alliance"] if track else None),
            "phase": None, "observation_type": detection["event_type"],
            "value": {"level": config.get("default_climb_level")},
            "started_ms": detection["timestamp_ms"], "ended_ms": detection["timestamp_ms"],
            "confidence": detection["confidence"],
            "source": "yolo", "review_status": "unreviewed",
            "evidence": {
                "source": "yolo", "frame": detection["frame_index"],
                "box": detection["coords"], "class_name": detection["class_name"],
                "attribution_distance": distance, "attributed_from_track": bool(track),
                "review_required": True,
            },
        })
    return observations


def attribute_scores(piece_trajectories, robot_tracks, goal_zones, frame_shape, view_id, max_distance_px=120):
    """Propose one score candidate for an observed entry into a goal zone.
    Attribution walks back to the trajectory's *origin* point (where the
    piece started, i.e. left the shooting robot) and finds whichever robot
    track was physically closest at that same moment - the shooter, not
    whichever robot happens to be nearest the goal when it lands."""
    observations = []
    for trajectory in piece_trajectories:
        if len(trajectory) < 2:
            continue
        entries = [(entry, zone) for zone in goal_zones
                   if (entry := goal_entry(trajectory, lambda point: point_in_zone(point, zone.get("polygon"), frame_shape))) is not None]
        if not entries:
            continue
        (end_t, end_x, end_y), scoring_zone = min(entries, key=lambda item: item[0][0])
        start_t, start_x, start_y = trajectory[0]
        best_track, best_distance = nearest_pixel_track((start_x, start_y), robot_tracks, start_t, max_distance_px)
        observations.append({
            "view_id": view_id,
            "team_key": best_track["team_key"] if best_track else None,
            "track_key": best_track.get("track_key") if best_track else None,
            "alliance": best_track["alliance"] if best_track else scoring_zone.get("alliance"),
            "phase": None,
            "observation_type": "fuel_scored",
            "value": {"count": 1, "attribution_distance_px": best_distance},
            "started_ms": start_t,
            "ended_ms": end_t,
            "confidence": 0.7 if best_track else 0.4,  # lower confidence when no robot track could be matched to the origin
            "source": "classical_cv", "review_status": "unreviewed",
            "evidence": {"source": "classical_cv", "zone": scoring_zone.get("label"), "trajectory_points": len(trajectory), "goal_entry_candidate": True, "review_required": True}
        })
    return observations


def autocalibrate_view(view, config, video_path, max_frames=30):
    """Solve this view's field homography from the AprilTags already on the
    field, when nobody hand-calibrated one.

    Explicitly opt-in twice over. It requires `apriltag_autocalibrate: true`
    AND a layout path, because a homography derived from a guessed focal
    length is confidently wrong rather than obviously wrong, and silently
    swapping pixel coordinates for slightly-wrong metres is worse than leaving
    a view uncalibrated. Manual calibration always wins - the caller only
    reaches here when the view has no stored homography.

    Returns (homography_or_None, diagnostics) and never raises: automatic
    calibration is an enhancement, and no failure in it may take down ordinary
    vision processing.
    """
    diagnostics = {"attempted": False, "tags_matched": 0}
    if not config.get("apriltag_autocalibrate"):
        diagnostics["reason"] = "automatic calibration not enabled (set config.apriltag_autocalibrate)"
        return None, diagnostics
    layout_path = config.get("apriltag_layout_path")
    if not layout_path:
        diagnostics["reason"] = "no apriltag_layout_path configured"
        return None, diagnostics

    diagnostics["attempted"] = True
    try:
        from apriltag_calibration import (
            DEFAULT_MAX_REPROJECTION_PX, DEFAULT_TAG_FAMILY, DEFAULT_TAG_SIZE_M,
            aruco_unavailable, calibrate_from_frame, load_field_layout, tag_dictionary,
        )

        family = config.get("apriltag_family", DEFAULT_TAG_FAMILY)
        diagnostics["tag_family"] = family
        unavailable = aruco_unavailable() or tag_dictionary(family)[1]
        if unavailable:
            diagnostics["reason"] = unavailable
            return None, diagnostics

        layout = load_field_layout(layout_path)
        if not layout.get("tags"):
            diagnostics["reason"] = f"no tags in layout {layout_path}"
            return None, diagnostics
        diagnostics["layout_tags"] = len(layout["tags"])

        fov = config.get("camera_horizontal_fov_deg") or view.get("camera_horizontal_fov_deg")
        if not fov:
            diagnostics["reason"] = "no camera_horizontal_fov_deg configured, and intrinsics can't be guessed"
            return None, diagnostics

        tag_size = float(config.get("apriltag_size_m", DEFAULT_TAG_SIZE_M))
        max_error = float(config.get("apriltag_max_reprojection_px", DEFAULT_MAX_REPROJECTION_PX))
        capture = cv2.VideoCapture(str(video_path))
        best = (None, dict(diagnostics, reason="no frame in the sampled window contained enough tags"))
        frames_read = 0
        try:
            for _ in range(max_frames):
                ok, frame = capture.read()
                if not ok:
                    break
                frames_read += 1
                solved, result = calibrate_from_frame(
                    frame, layout, horizontal_fov_deg=fov, tag_size_m=tag_size,
                    family=family, max_reprojection_px=max_error,
                )
                merged = dict(diagnostics, **result)
                # More tags in view means a better-conditioned pose, so keep
                # looking rather than taking the first frame that happens to
                # work. A frame that saw nothing never displaces a real
                # failure reason from one that did.
                if solved is not None and merged.get("tags_matched", 0) > best[1].get("tags_matched", 0):
                    best = (solved.tolist(), merged)
                elif best[0] is None and merged.get("tags_detected", 0) >= best[1].get("tags_detected", 0):
                    best = (None, merged)
        finally:
            capture.release()
        best[1]["frames_sampled"] = frames_read
        if not frames_read:
            best[1]["reason"] = "recording produced no readable frames"
        return best
    except Exception as error:
        diagnostics["reason"] = f"apriltag calibration failed: {error}"
        return None, diagnostics


def resolve_view_calibration(view, config, video_path, solver=None):
    """Decide this view's homography, manual first.

    Split out from process_view so the precedence rule is directly testable:
    a human who measured this camera outranks anything solved from tags, and
    the solver must not even be consulted when a manual homography exists.
    Returns (homography_or_None, diagnostics).
    """
    if view.get("homography"):
        return view["homography"], {"attempted": False, "reason": "manual homography already set"}
    return (solver or autocalibrate_view)(view, config, video_path)


def process_view(model, view, config, video_path):
    tracks = {}
    identity_map = config.get("identity_map", {})
    confidence_floor = float(config.get("confidence_floor", 0.35))
    hsv_lower = config.get("hsv_lower", DEFAULT_HSV_LOWER)
    hsv_upper = config.get("hsv_upper", DEFAULT_HSV_UPPER)
    min_piece_area = float(config.get("min_piece_area", DEFAULT_MIN_PIECE_AREA))
    min_circularity = float(config.get("min_circularity", DEFAULT_MIN_CIRCULARITY))
    goal_zones = view.get("goal_zones") or []
    start_zones = view.get("start_zones") or []
    auto_end_ms = int(config.get("auto_end_ms", 15_000))
    field_mask_polygon = view.get("field_mask")

    capture = cv2.VideoCapture(str(video_path))
    fps = float(view.get("frame_rate") or capture.get(cv2.CAP_PROP_FPS) or 30)
    capture.release()
    names = model.names

    # Preflight the recording before spending GPU time on it, so an unusable
    # upload is visible in the run's diagnostics rather than inferred later
    # from strange results.
    view["preflight"] = probe_recording(video_path)
    for warning in view["preflight"].get("warnings", []):
        print(f"[preflight] {view.get('label') or view['id']}: {warning}", flush=True)

    # Manual calibration always wins; automatic calibration exists to make an
    # uncalibrated view usable, never to second-guess a human who measured
    # this camera. Without either, field_point() passes pixels straight
    # through and every derived distance is in pixels rather than metres. The
    # solved matrix is written back onto the view so every downstream
    # field_point() call in this run picks it up.
    solved, diagnostics = resolve_view_calibration(view, config, video_path)
    if solved is not None:
        view["homography"] = solved
    view["autocalibration"] = diagnostics
    if diagnostics.get("attempted"):
        print(
            f"[calibration] {view.get('label') or view['id']}: "
            f"{'accepted' if solved is not None else 'rejected'} - {diagnostics.get('reason')} "
            f"(tags matched {diagnostics.get('tags_matched', 0)}, "
            f"error {diagnostics.get('reprojection_error_px')})",
            flush=True,
        )

    reid = RobotReId()
    piece_tracker = PieceTracker(
        max_match_distance_px=float(config.get("piece_max_match_distance_px", 80)),
        max_missed_frames=int(config.get("piece_max_missed_frames", 5)),
    )
    climb_detections = []
    mask = None
    frame_shape = None
    # Per-canonical-id last-known snapshot, kept live regardless of whether
    # the id was actually seen this frame - RobotReId needs it at the exact
    # moment a track disappears (to record where/how fast it was moving and
    # what it looked like), not reconstructed later.
    robot_state = {}
    previously_seen_ids = set()

    # Each call is a different camera/video. Track within this source, but do
    # not carry a previous camera's IDs/state into it via persist=True.
    for frame_index, result in enumerate(model.track(source=str(video_path), stream=True, persist=False, verbose=False, conf=confidence_floor, tracker="bytetrack.yaml")):
        timestamp_ms = round(frame_index * 1000 / fps) + int(view.get("sync_offset_ms") or 0)
        frame = result.orig_img
        if frame_shape is None:
            frame_shape = frame.shape
            mask = build_mask(field_mask_polygon, frame_shape)

        seen_ids_this_frame = set()
        if result.boxes is not None:
            for box in result.boxes:
                class_name = str(names[int(box.cls.item())]).lower()
                confidence = float(box.conf.item())
                coords = box.xyxy[0].tolist()
                center = ((coords[0] + coords[2]) / 2, (coords[1] + coords[3]) / 2)
                if mask is not None and mask[min(int(center[1]), mask.shape[0] - 1), min(int(center[0]), mask.shape[1] - 1)] == 0:
                    continue  # outside the calibrated field ROI - audience/background, discard

                if class_name in ("robot_red", "robot_blue") and box.id is not None:
                    alliance = class_name.removeprefix("robot_")
                    histogram = bumper_histogram(frame, coords)
                    raw_tracker_id = int(box.id.item())
                    canonical_id = reid.resolve(raw_tracker_id, frame_index, center, histogram, alliance)
                    seen_ids_this_frame.add(canonical_id)

                    key = f"{view['id']}:{canonical_id}"
                    x, y, calibrated = field_point(center, view.get("homography"))
                    track = tracks.setdefault(key, {
                        "view_id": view["id"], "team_key": identity_map.get(key),
                        # Local, run-scoped handle for this robot. The server
                        # swaps it for the real vision_tracks UUID once the
                        # rows are inserted, which is what lets naming one
                        # robot attribute every event it produced.
                        "track_key": key,
                        "alliance": alliance, "started_ms": timestamp_ms,
                        "ended_ms": timestamp_ms, "identity_confidence": 1 if identity_map.get(key) else 0,
                        "tracking_confidence": confidence, "trajectory": []
                    })
                    track["needs_review"] = not bool(identity_map.get(key))
                    track["ended_ms"] = timestamp_ms
                    # First pixel centre seen during auto, kept for start-zone
                    # naming after the loop. Stored in pixels, not the
                    # trajectory's (possibly field-space) coordinates, because
                    # that is the space start_zones are compared in.
                    if timestamp_ms < auto_end_ms and "auto_start_pixel" not in track:
                        track["auto_start_pixel"] = center
                    track["tracking_confidence"] = min(track["tracking_confidence"], confidence)
                    track["trajectory"].append({"t": timestamp_ms, "x": x, "y": y, "pixel_x": center[0], "pixel_y": center[1], "confidence": confidence, "calibrated": calibrated})

                    previous_state = robot_state.get(canonical_id)
                    velocity = (
                        (center[0] - previous_state["position"][0], center[1] - previous_state["position"][1])
                        if previous_state else (0.0, 0.0)
                    )
                    robot_state[canonical_id] = {"position": center, "velocity": velocity, "histogram": histogram, "alliance": alliance}
                elif class_name.startswith(("climb_attempt", "climb_success")):
                    # Held raw and attributed after the loop: these classes fire
                    # on the climbing structure rather than on a tracked robot,
                    # so they need the finished tracks to find an owner.
                    climb_detections.append({
                        "event_type": "climb_success" if class_name.startswith("climb_success") else "climb_attempt",
                        "alliance": "red" if class_name.endswith("_red") else "blue" if class_name.endswith("_blue") else None,
                        "timestamp_ms": timestamp_ms, "center": center, "coords": coords,
                        "confidence": confidence, "frame_index": frame_index, "class_name": class_name,
                    })
                # fuel_scored is deliberately not handled here even if legacy
                # weights still emit it - the classical-CV pipeline below is
                # the sole source of truth for fuel, so an old-style YOLO
                # detection is silently ignored rather than double-counted.

        # Any id seen last frame but not this one just went into occlusion
        # (or left the ROI / match ended) - snapshot it as lost exactly once,
        # at the frame the gap starts, so RobotReId's frames-gone math for a
        # later reappearance is measured from the right origin.
        for lost_id in previously_seen_ids - seen_ids_this_frame:
            state = robot_state.get(lost_id)
            if state:
                reid.mark_lost(lost_id, frame_index, state["position"], state["velocity"], state["histogram"], state["alliance"])
        previously_seen_ids = seen_ids_this_frame

        pixel_pieces = detect_game_pieces(frame, mask, hsv_lower, hsv_upper, min_piece_area, min_circularity)
        piece_tracker.update(timestamp_ms, pixel_pieces)

    finished_tracks = list(tracks.values())
    for track in finished_tracks:
        track["auto_start_zone"] = resolve_auto_start_zone(
            track.pop("auto_start_pixel", None), start_zones, frame_shape,
        )
    climb_observations = attribute_climbs(climb_detections, finished_tracks, view, config)
    fuel_observations = attribute_scores(piece_tracker.all_trajectories(), finished_tracks, goal_zones, frame_shape or (1, 1), view["id"], float(config.get("fuel_attribution_distance_px", 120)))
    return finished_tracks, climb_observations + fuel_observations


def run_job(model, run):
    if run.get("qwen_model") and run["qwen_model"] != QWEN_MODEL:
        raise RuntimeError(f"Run requires Qwen model {run['qwen_model']}, runner serves {QWEN_MODEL}")
    if run.get("qwen_revision") and run["qwen_revision"] != QWEN_REVISION:
        raise RuntimeError(f"Run requires Qwen revision {run['qwen_revision']}, runner serves {QWEN_REVISION}")
    api("processing", run_id=run["id"])
    all_tracks, all_observations, all_qwen_clips = [], [], []
    view_diagnostics = []
    with tempfile.TemporaryDirectory(prefix="spartans-vision-") as directory:
        directory = Path(directory)
        for index, view in enumerate(run.get("views", [])):
            if not view.get("signed_url"):
                raise RuntimeError(f"View {view['id']} has no signed download URL")
            path = directory / f"view-{index}.mp4"
            heartbeat(current_run_id=run["id"])
            download(view["signed_url"], path)
            tracks, observations = process_view(model, view, run.get("config") or {}, path)
            heartbeat(current_run_id=run["id"])
            qwen_observations, qwen_clips = analyze_view_with_qwen(
                view, run.get("config") or {}, path,
                (run.get("vision_matches") or {}).get("match_key"), tracks,
                on_progress=lambda: heartbeat(current_run_id=run["id"]),
            )
            all_tracks.extend(tracks)
            all_observations.extend(observations)
            all_observations.extend(qwen_observations)
            all_qwen_clips.extend(qwen_clips)
            # Per-view calibration and recording diagnostics travel with the
            # run so a reviewer can see why a view produced pixel coordinates
            # instead of metres without reading the runner's logs.
            view_diagnostics.append({
                "view_id": view["id"], "label": view.get("label"),
                "preflight": view.get("preflight"),
                "calibration": view.get("autocalibration"),
                "calibrated": bool(view.get("homography")),
            })
    api(
        "complete", run_id=run["id"], tracks=all_tracks, observations=all_observations,
        qwen_clips=all_qwen_clips, view_diagnostics=view_diagnostics,
    )


def heartbeat(current_run_id=None, last_error=None):
    # Fleet visibility only - a dashboard reads vision_runners to show
    # online/offline instead of inferring it from "jobs stopped moving."
    # Best-effort: a heartbeat failure (network blip, server restart) must
    # never take down the actual processing loop over a status ping.
    try:
        qwen_status = qwen_health() if QWEN_URL else None
        api(
            "heartbeat", runner_id=RUNNER_ID, model_path=WEIGHTS,
            qwen_model=QWEN_MODEL, qwen_endpoint=QWEN_URL or None,
            runtime_metrics={"qwen": qwen_status},
            current_run_id=current_run_id, last_error=last_error,
        )
    except Exception:
        pass


def main():
    if QWEN_REQUIRED and (not QWEN_URL or not QWEN_TOKEN):
        raise RuntimeError("VISION_QWEN_URL and VISION_QWEN_TOKEN are required")
    model = YOLO(WEIGHTS)
    last_error = None
    while True:
        heartbeat(last_error=last_error)
        status = qwen_health()
        if QWEN_REQUIRED and (
            not status.get("ready") or status.get("model") != QWEN_MODEL
            or status.get("revision") != QWEN_REVISION or status.get("dtype") != "bfloat16"
        ):
            last_error = f"Qwen service not ready or mismatched: {status}"
            time.sleep(POLL_SECONDS)
            continue
        if last_error and last_error.startswith("Qwen service not ready or mismatched:"):
            last_error = None
        claimed = api("claim", runner_id=RUNNER_ID).get("run")
        if not claimed:
            time.sleep(POLL_SECONDS)
            continue
        heartbeat(current_run_id=claimed["id"])
        try:
            run_job(model, claimed)
            last_error = None
        except Exception as exc:  # runner must always terminate the claimed job
            last_error = str(exc)
            api("fail", run_id=claimed["id"], error=last_error)


if __name__ == "__main__":
    main()
