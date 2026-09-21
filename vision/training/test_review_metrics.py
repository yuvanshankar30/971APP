import unittest

from review_metrics import calculate_review_metrics


class ReviewMetricsTest(unittest.TestCase):
    def test_counts_box_outcomes_misses_and_excludes_unobservable_frames(self):
        sample = [{"image": "a.jpg"}, {"image": "b.jpg"}]
        reviews = {
            "a.jpg": {"verdict": "reviewed", "missed_robots": 1, "boxes": [
                {"class_name": "robot_red", "verdict": "correct"},
                {"class_name": "robot_blue", "verdict": "wrong_class"},
                {"class_name": "robot_red", "verdict": "false_positive"},
                {"class_name": "robot_blue", "verdict": "poor_geometry"},
            ]},
            "b.jpg": {"verdict": "unobservable", "unobservable": True,
                      "boxes": [{"class_name": "robot_red", "verdict": "false_positive"}]},
        }
        metrics = calculate_review_metrics(sample, reviews)
        self.assertEqual(metrics["true_positive"], 1)
        self.assertEqual(metrics["false_positive"], 1)
        self.assertEqual(metrics["false_negative"], 1)
        self.assertEqual(metrics["wrong_alliance"], 1)
        self.assertEqual(metrics["poor_geometry"], 1)
        self.assertEqual(metrics["observable_frames"], 1)
        self.assertEqual(metrics["precision"], 0.5)
        self.assertEqual(metrics["recall"], 0.5)

    def test_requires_exactly_thirty_reviewed_frames_for_completion(self):
        sample = [{"image": f"{index}.jpg"} for index in range(30)]
        reviews = {item["image"]: {"verdict": "reviewed"} for item in sample}
        self.assertTrue(calculate_review_metrics(sample, reviews)["complete"])


if __name__ == "__main__":
    unittest.main()
