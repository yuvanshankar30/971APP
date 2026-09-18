"""Review-required motion evidence derived from calibrated robot trajectories."""

from __future__ import annotations

from math import hypot


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _points(track, minimum_confidence):
    points = []
    for point in track.get("trajectory") or []:
        confidence = _number(point.get("confidence", 1))
        if not point.get("calibrated") or confidence is None or confidence < minimum_confidence:
            continue
        t, x, y = (_number(point.get(key)) for key in ("t", "x", "y"))
        if t is not None and x is not None and y is not None:
            points.append({"t": t, "x": x, "y": y, "confidence": confidence})
    return sorted(points, key=lambda point: point["t"])


def _observation(track, view_id, started_ms, ended_ms, observation_type, value, evidence):
    return {
        "view_id": view_id,
        "track_key": track.get("track_key"),
        "team_key": track.get("team_key"),
        "alliance": track.get("alliance"),
        "observation_type": observation_type,
        "phase": "auto" if started_ms < 15_000 else "teleop",
        "started_ms": round(started_ms),
        "ended_ms": round(ended_ms),
        "value": value,
        "confidence": min(.95, max(.5, sum(point["confidence"] for point in evidence.get("points", [])) / max(1, len(evidence.get("points", []))))),
        "evidence": {"source": "trajectory", "review_required": True, **evidence},
    }


def sustained_stationary_candidates(track, view_id, config):
    """Flag continuously visible, calibrated robots that remain still for 50s.

    This intentionally rejects tracking gaps: occlusion is not evidence that a
    robot died. A reviewer must accept the candidate before it reaches Match
    Scouting.
    """
    minimum_confidence = float(config.get("motion_min_confidence", .65))
    points = _points(track, minimum_confidence)
    auto_end_ms = float(config.get("auto_end_ms", 15_000))
    max_gap_ms = float(config.get("dead_max_track_gap_ms", 1_500))
    minimum_duration_ms = float(config.get("dead_stationary_ms", 50_000))
    maximum_speed = float(config.get("dead_stationary_speed_mps", .12))
    if len(points) < 2:
        return []

    candidates = []
    episode_start = None
    episode_points = []
    previous = None
    for point in points:
        if point["t"] < auto_end_ms:
            previous = point
            continue
        if previous is None or previous["t"] < auto_end_ms:
            episode_start, episode_points = point["t"], [point]
            previous = point
            continue
        elapsed_ms = point["t"] - previous["t"]
        distance = hypot(point["x"] - previous["x"], point["y"] - previous["y"])
        speed = distance / (elapsed_ms / 1000) if elapsed_ms > 0 else float("inf")
        if elapsed_ms <= max_gap_ms and speed <= maximum_speed:
            if episode_start is None:
                episode_start, episode_points = previous["t"], [previous]
            episode_points.append(point)
        else:
            episode_start, episode_points = point["t"], [point]
        duration = point["t"] - episode_start
        if duration >= minimum_duration_ms:
            candidates.append(_observation(
                track, view_id, episode_start, point["t"], "disabled",
                {"status": "dead", "duration_ms": round(duration), "threshold_ms": round(minimum_duration_ms)},
                {"rule": "continuous_stationary_track", "points": episode_points[-12:], "max_speed_mps": maximum_speed},
            ))
            # The one observation is sufficient. More would merely duplicate it.
            break
        previous = point
    return candidates


def _segment(first, second):
    elapsed_ms = second["t"] - first["t"]
    if elapsed_ms <= 0:
        return None
    dx, dy = second["x"] - first["x"], second["y"] - first["y"]
    speed = hypot(dx, dy) / (elapsed_ms / 1000)
    if speed == 0:
        return None
    return {"start": first, "end": second, "dx": dx, "dy": dy, "speed": speed}


def collision_reversal_candidates(track, view_id, config):
    """Find abrupt high-speed reversals worth reviewing as collisions.

    The signal is deliberately labelled a *candidate*, not a confirmed crash:
    geometry cannot distinguish bumper contact from an intentional driver turn.
    """
    points = _points(track, float(config.get("motion_min_confidence", .65)))
    auto_end_ms = float(config.get("auto_end_ms", 15_000))
    max_gap_ms = float(config.get("collision_max_track_gap_ms", 1_500))
    min_approach = float(config.get("collision_min_approach_speed_mps", 1.4))
    min_reverse = float(config.get("collision_min_reverse_speed_mps", .35))
    min_change = float(config.get("collision_min_velocity_change_mps", 2.0))
    max_cosine = float(config.get("collision_max_direction_cosine", -.60))
    window_ms = float(config.get("collision_reversal_window_ms", 2_500))
    cooldown_ms = float(config.get("collision_candidate_cooldown_ms", 5_000))
    segments = [segment for segment in (_segment(points[index], points[index + 1]) for index in range(len(points) - 1)) if segment and segment["end"]["t"] - segment["start"]["t"] <= max_gap_ms]
    candidates, last_candidate = [], float("-inf")
    for index, incoming in enumerate(segments):
        if incoming["end"]["t"] < auto_end_ms or incoming["speed"] < min_approach:
            continue
        if incoming["end"]["t"] - last_candidate < cooldown_ms:
            continue
        for outgoing in segments[index + 1:]:
            if outgoing["end"]["t"] - incoming["end"]["t"] > window_ms:
                break
            if outgoing["speed"] < min_reverse:
                continue
            cosine = (incoming["dx"] * outgoing["dx"] + incoming["dy"] * outgoing["dy"]) / (hypot(incoming["dx"], incoming["dy"]) * hypot(outgoing["dx"], outgoing["dy"]))
            velocity_change = incoming["speed"] + outgoing["speed"]
            if cosine > max_cosine or velocity_change < min_change:
                continue
            started, ended = incoming["end"]["t"], outgoing["end"]["t"]
            candidates.append(_observation(
                track, view_id, started, ended, "collision",
                {"kind": "abrupt_reverse", "incoming_speed_mps": round(incoming["speed"], 2), "reverse_speed_mps": round(outgoing["speed"], 2), "velocity_change_mps": round(velocity_change, 2)},
                {"rule": "high_speed_reverse", "points": [incoming["start"], incoming["end"], outgoing["end"]], "direction_cosine": round(cosine, 3), "window_ms": round(ended - started)},
            ))
            last_candidate = started
            break
    return candidates


def track_motion_candidates(track, view_id, config):
    return sustained_stationary_candidates(track, view_id, config) + collision_reversal_candidates(track, view_id, config)
