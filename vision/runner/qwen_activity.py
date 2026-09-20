"""Deterministic clip selection for expensive semantic video analysis."""


def _inside(point, polygon):
    x, y = point
    inside = False
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = previous
        x2, y2 = current
        if ((y1 > y) != (y2 > y)) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
        previous = current
    return inside


def select_clip(start_ms, end_ms, robot_tracks, regions, frame_shape, *,
                sync_offset_ms=0, clip_index=0, fallback_every=12):
    """Return an auditable selection decision for one local-video clip.

    Track timestamps are match-relative while clip timestamps are local to the
    recording, so the view sync offset is applied before testing the window.
    With no calibrated regions we fail open; silent coverage loss would be
    worse than spending more inference time.
    """
    polygons = [region.get("polygon") for region in (regions or [])
                if len(region.get("polygon") or []) >= 3]
    if not polygons or not frame_shape:
        return {"selected": True, "reason": "no_regions_configured", "nearby_samples": 0}
    height, width = frame_shape[:2]
    match_start = start_ms + sync_offset_ms
    match_end = end_ms + sync_offset_ms
    nearby = 0
    for track in robot_tracks or []:
        for sample in track.get("trajectory", []):
            if not match_start <= sample.get("t", -1) <= match_end:
                continue
            px = sample.get("pixel_x")
            py = sample.get("pixel_y")
            if px is None or py is None:
                continue
            if any(_inside((px / width, py / height), polygon) for polygon in polygons):
                nearby += 1
    if nearby:
        return {"selected": True, "reason": "robot_near_scoring_region", "nearby_samples": nearby}
    if fallback_every > 0 and clip_index % fallback_every == 0:
        return {"selected": True, "reason": "low_rate_fallback", "nearby_samples": 0}
    return {"selected": False, "reason": "no_relevant_activity", "nearby_samples": 0}
