import unittest

from evaluate_tracking import evaluate


class EvaluateTrackingTest(unittest.TestCase):
    def test_reports_recall_duplicates_switches_and_alliance_quality(self):
        manifest = {"clips": [{"id": "occluded", "challenges": ["occlusion"], "truth": [
            {"frame": 1, "track_id": "truth-1", "alliance": "red", "box": [0, 0, 10, 10]},
            {"frame": 2, "track_id": "truth-1", "alliance": "red", "box": [1, 0, 11, 10]},
            {"frame": 2, "track_id": "truth-2", "alliance": "blue", "box": [20, 0, 30, 10]},
        ]}]}
        predictions = {
            ("occluded", 1): [
                {"track_id": "a", "alliance": "red", "box": [0, 0, 10, 10]},
                {"track_id": "duplicate", "alliance": "red", "box": [0, 0, 10, 10]},
            ],
            ("occluded", 2): [{"track_id": "b", "alliance": "unknown", "box": [1, 0, 11, 10]}],
        }
        metrics = evaluate(manifest, predictions)
        self.assertEqual(metrics["detector_recall"], 2 / 3)
        self.assertEqual(metrics["duplicate_detections"], 1)
        self.assertEqual(metrics["track_fragmentations"], 1)
        self.assertEqual(metrics["id_switches"], 1)
        self.assertEqual(metrics["alliance_color"]["unknown"], 1)
        self.assertEqual(metrics["challenging_scenes"]["occlusion"]["recall"], 2 / 3)


if __name__ == "__main__":
    unittest.main()
