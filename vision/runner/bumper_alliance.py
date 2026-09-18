"""Alliance classification from the visible bumper band of a robot box.

This is deliberately a small second stage after a robot detector.  It never
creates a robot detection and returns ``None`` when the bumper is too dark,
desaturated, occluded, or visually ambiguous.  A wrong alliance would poison
the roster-constrained team-number reader, so an unknown result is preferable
to a clever-looking guess.
"""
from __future__ import annotations


def infer_bumper_alliance(frame, box_xyxy, *, min_colored_pixels=24,
                          min_share=.12, min_margin=.08):
    """Return (``red`` | ``blue`` | None, diagnostic evidence).

    FRC bumpers appear near the low edge of a normal broadcast robot box. We
    inspect the lower 42%, ignore gray/black pixels, then compare saturated
    red and blue pixels.  The HSV thresholds intentionally use broad hue
    bands; saturation/value filters are what prevent the field, tower, and
    shadows from becoming alliances.
    """
    import cv2
    import numpy as np

    height, width = frame.shape[:2]
    x1, y1, x2, y2 = (round(float(value)) for value in box_xyxy)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(width, x2), min(height, y2)
    if x2 - x1 < 12 or y2 - y1 < 12:
        return None, {"reason": "robot box too small"}

    bumper_top = y1 + round((y2 - y1) * .58)
    # Avoid the outermost edge where field carpet and the bounding box's
    # background frequently dominate a partially visible robot.
    inset = max(1, round((x2 - x1) * .06))
    crop = frame[bumper_top:y2, x1 + inset:x2 - inset]
    if crop.size == 0:
        return None, {"reason": "empty bumper crop"}

    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    saturated = (hsv[:, :, 1] >= 80) & (hsv[:, :, 2] >= 55)
    # OpenCV hue is 0..179. Red wraps at zero; blue is approximately 100-135.
    red = saturated & ((hsv[:, :, 0] <= 12) | (hsv[:, :, 0] >= 168))
    blue = saturated & (hsv[:, :, 0] >= 95) & (hsv[:, :, 0] <= 138)
    colored = int(red.sum() + blue.sum())
    total = crop.shape[0] * crop.shape[1]
    red_share, blue_share = int(red.sum()) / total, int(blue.sum()) / total
    winner = "red" if red_share >= blue_share else "blue"
    winner_share, loser_share = (red_share, blue_share) if winner == "red" else (blue_share, red_share)
    evidence = {
        "bumper_crop": [x1 + inset, bumper_top, x2 - inset, y2],
        "red_share": round(red_share, 4), "blue_share": round(blue_share, 4),
        "colored_pixels": colored,
    }
    if colored < min_colored_pixels:
        return None, {**evidence, "reason": "too few saturated alliance-color pixels"}
    if winner_share < min_share:
        return None, {**evidence, "reason": "alliance color covers too little of bumper crop"}
    if winner_share - loser_share < min_margin:
        return None, {**evidence, "reason": "red/blue bumper evidence is ambiguous"}
    return winner, {**evidence, "confidence": round(min(1.0, (winner_share - loser_share) * 3), 3)}
