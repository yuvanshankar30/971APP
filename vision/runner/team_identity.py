"""Private, confidence-gated FRC robot identity from bumper-number crops.

This deliberately never treats alliance colour as identity.  It sends only a
small number of in-memory robot crops to the loopback Qwen service and accepts
a team only after repeated roster-constrained reads.
"""
from __future__ import annotations

import base64
from collections import Counter, defaultdict



def team_key(value):
    text = str(value or "").strip().lower()
    if text.isdigit():
        text = f"frc{text}"
    return text if text.startswith("frc") and text[3:].isdigit() else None


def roster_for(team_roster, alliance):
    values = (team_roster or {}).get(alliance, []) if alliance in {"red", "blue"} else []
    return {key for value in values if (key := team_key(value))}


def crop_robot(frame, coords):
    """Return an enlarged robot crop and quality score, or None if too small."""
    import cv2  # runtime dependency of the runner; keep consensus tests pure
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = [float(value) for value in coords]
    robot_width, robot_height = x2 - x1, y2 - y1
    if robot_width < 42 or robot_height < 42:
        return None
    # Bumper numbers can sit at either edge. Preserve the whole detection plus
    # a small margin rather than assuming a fixed bumper orientation.
    x1 = max(0, int(x1 - robot_width * .12)); x2 = min(width, int(x2 + robot_width * .12))
    y1 = max(0, int(y1 - robot_height * .12)); y2 = min(height, int(y2 + robot_height * .12))
    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    sharpness = float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
    scale = min(4.0, max(1.0, 720 / max(crop.shape[:2])))
    if scale > 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    encoded, jpeg = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 94])
    if not encoded:
        return None
    # Area rejects distant robots; sharpness breaks ties between similarly
    # sized candidates. The number is only used for sampling, never trust.
    score = min(1.0, (robot_width * robot_height) / 50_000) + min(1.0, sharpness / 300) * .2
    return jpeg.tobytes(), score


class CropCollector:
    def __init__(self, max_per_track=3, min_frame_gap=30):
        self.max_per_track = max_per_track
        self.min_frame_gap = min_frame_gap
        self.crops = defaultdict(list)

    def offer(self, track_key, alliance, frame_index, timestamp_ms, frame, coords):
        existing = self.crops[track_key]
        if any(abs(frame_index - row["frame_index"]) < self.min_frame_gap for row in existing):
            return
        result = crop_robot(frame, coords)
        if not result:
            return
        jpeg, score = result
        existing.append({"track_key": track_key, "alliance": alliance, "frame_index": frame_index,
                         "timestamp_ms": timestamp_ms, "jpeg": jpeg, "score": score})
        existing.sort(key=lambda row: row["score"], reverse=True)
        del existing[self.max_per_track:]

    def flattened(self):
        return [crop for values in self.crops.values() for crop in values]


def decide_identity(reads, min_reads=3, min_confidence=.65, min_share=.70):
    """Return a confidence-gated identity decision from OCR reads for one track."""
    valid = [row for row in reads if row.get("team_key") and float(row.get("confidence", 0)) >= min_confidence]
    if not valid:
        return None, {"read_count": 0, "reason": "no high-confidence bumper-number reads"}
    weighted = Counter()
    counts = Counter()
    for row in valid:
        weighted[row["team_key"]] += float(row["confidence"])
        counts[row["team_key"]] += 1
    team, weight = weighted.most_common(1)[0]
    share = weight / sum(weighted.values())
    if counts[team] < min_reads:
        return None, {"read_count": counts[team], "candidate": team, "share": share, "reason": "not enough repeated reads"}
    if share < min_share:
        return None, {"read_count": counts[team], "candidate": team, "share": share, "reason": "conflicting reads"}
    return team, {"read_count": counts[team], "candidate": team, "share": share,
                  "confidence": min(1.0, share * (weight / counts[team]))}


def resolve_identities(tracks, collector, team_roster, qwen_url, qwen_token, *, timeout=180,
                       min_reads=3, min_confidence=.65, min_share=.70):
    """Ask local Qwen to read crops and apply only consensus assignments.

    This function is safe to call on every completed view: missing roster,
    disabled endpoint, malformed replies, or an OCR outage leave tracks
    unidentified and reviewable.
    """
    import requests  # runner dependency; keep decision-rule tests dependency-free
    by_key = {track["track_key"]: track for track in tracks}
    crops = [row for row in collector.flattened() if roster_for(team_roster, row["alliance"])]
    evidence = defaultdict(list)
    for offset in range(0, len(crops), 8):
        batch = crops[offset:offset + 8]
        payload_crops = []
        permitted = {}
        for index, crop in enumerate(batch):
            crop_id = f"{crop['track_key']}:{crop['frame_index']}:{index}"
            crop["crop_id"] = crop_id
            candidates = sorted(roster_for(team_roster, crop["alliance"]))
            permitted[crop_id] = candidates
            payload_crops.append({"crop_id": crop_id, "track_key": crop["track_key"], "alliance": crop["alliance"],
                                  "candidate_team_keys": candidates,
                                  "jpeg_base64": base64.b64encode(crop["jpeg"]).decode("ascii")})
        try:
            response = requests.post(f"{qwen_url.rstrip('/')}/read-team-numbers",
                headers={"Authorization": f"Bearer {qwen_token}", "Content-Type": "application/json"},
                json={"crops": payload_crops}, timeout=timeout)
            response.raise_for_status()
            reads = response.json().get("reads", [])
        except Exception as error:
            for crop in batch:
                by_key[crop["track_key"]].setdefault("metrics", {}).setdefault("teamIdentity", {})["error"] = str(error)[:300]
            continue
        crop_by_id = {crop["crop_id"]: crop for crop in batch}
        for read in reads:
            crop = crop_by_id.get(read.get("crop_id"))
            if crop and read.get("team_key") in permitted[crop["crop_id"]]:
                evidence[crop["track_key"]].append(read)
    for key, track in by_key.items():
        if track.get("team_key"):  # a human identity_map always wins
            continue
        identity, details = decide_identity(evidence[key], min_reads, min_confidence, min_share)
        track.setdefault("metrics", {})["teamIdentity"] = {**details, "reads": evidence[key]}
        if identity:
            track["team_key"] = identity
            track["identity_confidence"] = details["confidence"]
            track["needs_review"] = True  # still never auto-released
    return tracks
