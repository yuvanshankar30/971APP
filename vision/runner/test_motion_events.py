import unittest

from motion_events import track_motion_candidates


def track(points):
    return {"track_key": "view:7", "team_key": "frc971", "alliance": "blue", "trajectory": points}


def point(t, x, y, calibrated=True, confidence=.9):
    return {"t": t, "x": x, "y": y, "calibrated": calibrated, "confidence": confidence}


class MotionEventTests(unittest.TestCase):
    def test_marks_continuously_visible_stationary_robot_dead_after_fifty_seconds(self):
        candidate = track_motion_candidates(track([point(t, 2, 3) for t in range(15_000, 67_000, 1_000)]), "view", {})
        dead = [row for row in candidate if row["observation_type"] == "disabled"]
        self.assertEqual(len(dead), 1)
        self.assertEqual(dead[0]["value"]["status"], "dead")
        self.assertGreaterEqual(dead[0]["value"]["duration_ms"], 50_000)
        self.assertTrue(dead[0]["evidence"]["review_required"])

    def test_gap_never_becomes_dead(self):
        points = [point(t, 2, 3) for t in list(range(15_000, 40_000, 1_000)) + list(range(45_000, 95_000, 1_000))]
        candidate = track_motion_candidates(track(points), "view", {})
        self.assertFalse(any(row["observation_type"] == "disabled" for row in candidate))

    def test_high_speed_reverse_creates_review_collision_candidate(self):
        candidate = track_motion_candidates(track([
            point(15_000, 0, 0), point(15_400, .8, 0), point(15_800, 1.6, 0),
            point(16_200, 1.15, 0), point(16_600, .7, 0),
        ]), "view", {})
        collisions = [row for row in candidate if row["observation_type"] == "collision"]
        self.assertEqual(len(collisions), 1)
        self.assertEqual(collisions[0]["value"]["kind"], "abrupt_reverse")
        self.assertTrue(collisions[0]["evidence"]["review_required"])

    def test_slow_or_uncalibrated_turn_is_not_a_collision(self):
        slow = track([point(15_000, 0, 0), point(15_400, .1, 0), point(15_800, 0, 0)])
        uncalibrated = track([point(15_000, 0, 0, False), point(15_400, 1, 0, False), point(15_800, 0, 0, False)])
        self.assertFalse(any(row["observation_type"] == "collision" for row in track_motion_candidates(slow, "view", {})))
        self.assertFalse(any(row["observation_type"] == "collision" for row in track_motion_candidates(uncalibrated, "view", {})))


if __name__ == "__main__":
    unittest.main()
