"""Dependency-free ball association and pixel-space shooter matching.

These heuristics produce review candidates, never verified scores. A 2D
goal-region entry cannot establish that an airborne ball went through a hub.
"""
import math


class PieceTracker:
    """Constant-velocity prediction with globally distance-ordered matches.

    Association is still greedy, not a full assignment solver. Dense crossing
    balls and prolonged occlusion require whole-video validation.
    """

    def __init__(self, max_match_distance_px=80, max_missed_frames=5):
        self.max_match_distance_px = max_match_distance_px
        self.max_missed_frames = max_missed_frames
        self._next_id = 0
        self._active = {}
        self.finished = []

    def update(self, timestamp_ms, detections):
        candidates = []
        for piece_id, track in self._active.items():
            last_t, last_x, last_y = track['points'][-1]
            predicted_x, predicted_y = last_x, last_y
            if len(track['points']) > 1:
                previous_t, previous_x, previous_y = track['points'][-2]
                dt = last_t - previous_t
                if dt > 0:
                    elapsed = max(0, timestamp_ms - last_t) / dt
                    predicted_x += (last_x - previous_x) * elapsed
                    predicted_y += (last_y - previous_y) * elapsed
            for index, (x, y) in enumerate(detections):
                distance = math.hypot(x - predicted_x, y - predicted_y)
                if distance <= self.max_match_distance_px:
                    candidates.append((distance, piece_id, index))
        matched_tracks, matched_detections = set(), set()
        for _, piece_id, index in sorted(candidates):
            if piece_id in matched_tracks or index in matched_detections:
                continue
            x, y = detections[index]
            self._active[piece_id]['points'].append((timestamp_ms, x, y))
            self._active[piece_id]['missed'] = 0
            matched_tracks.add(piece_id)
            matched_detections.add(index)
        for piece_id, track in list(self._active.items()):
            if piece_id not in matched_tracks:
                track['missed'] += 1
                if track['missed'] > self.max_missed_frames:
                    self.finished.append(track['points'])
                    del self._active[piece_id]
        for index, (x, y) in enumerate(detections):
            if index not in matched_detections:
                self._active[self._next_id] = {'points': [(timestamp_ms, x, y)], 'missed': 0}
                self._next_id += 1

    def all_trajectories(self):
        return self.finished + [track['points'] for track in self._active.values()]


def nearest_pixel_track(point, robot_tracks, timestamp_ms, max_distance_px=120, window_ms=500):
    """Never compare a ball's pixels to a robot's field-space metres.

    New tracks carry pixel_x/pixel_y. Legacy uncalibrated points are already
    pixels; legacy calibrated points without pixel coordinates are skipped.
    """
    best_track, best_distance = None, None
    for track in robot_tracks:
        samples = [p for p in track.get('trajectory', [])
                   if abs(p['t'] - timestamp_ms) <= window_ms
                   and (('pixel_x' in p and 'pixel_y' in p) or not p.get('calibrated'))]
        closest = min(samples, key=lambda p: abs(p['t'] - timestamp_ms), default=None)
        if closest is None:
            continue
        x, y = closest.get('pixel_x', closest['x']), closest.get('pixel_y', closest['y'])
        distance = math.hypot(x - point[0], y - point[1])
        if distance <= max_distance_px and (best_distance is None or distance < best_distance):
            best_track, best_distance = track, distance
    return best_track, best_distance


def goal_entry(trajectory, contains):
    """First observed outside-to-inside transition, or None.

    Rejects stationary goal blobs and tracks first detected inside the goal.
    Stops at the first entry so lingering/re-entry doesn't double count.
    """
    for previous, current in zip(trajectory, trajectory[1:]):
        if not contains((previous[1], previous[2])) and contains((current[1], current[2])):
            return current
    return None
