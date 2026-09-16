import unittest

from qwen_yolo_contract import acceptance_decision, normalize_result, parse_json_response, to_yolo_line


class QwenYoloContractTests(unittest.TestCase):
    def test_normalizes_and_converts_valid_detection(self):
        result, error = normalize_result({
            "detections": [{
                "class_name": "robot_red", "box": [100, 200, 500, 800],
                "confidence": 1.2, "visible_fraction": 0.9,
                "occlusion": "none", "distance": "far", "motion_blur": "none",
                "team_number": "971", "team_number_confidence": 0.8,
                "state_tags": ["moving", "shooting", "nonsense"],
                "evidence": "red bumper",
            }],
            "image_quality": "good",
            "camera_view": "full_field", "match_phase": "teleop",
        })
        self.assertIsNone(error)
        self.assertEqual(result["detections"][0]["confidence"], 1.0)
        self.assertEqual(to_yolo_line(result["detections"][0]), "0 0.300000 0.500000 0.400000 0.600000")
        self.assertEqual(result["detections"][0]["label_status"], "proposed")
        self.assertEqual(result["detections"][0]["team_number"], "971")
        self.assertEqual(result["detections"][0]["state_tags"], ["moving", "shooting"])
        accepted, reasons = acceptance_decision(result["detections"][0], result["image_quality"])
        self.assertTrue(accepted)
        self.assertEqual(reasons, [])

    def test_drops_unknown_classes_and_invalid_boxes(self):
        result, error = normalize_result({"detections": [
            {"class_name": "person", "box": [0, 0, 10, 10]},
            {"class_name": "robot_blue", "box": [500, 500, 100, 100]},
        ]})
        self.assertIsNone(error)
        self.assertEqual(result["detections"], [])

    def test_accepts_clear_fuel_and_rejects_ambiguous_fuel(self):
        result, error = normalize_result({"detections": [
            {"class_name": "fuel", "box": [100, 100, 130, 135], "confidence": 0.97,
             "visible_fraction": 1, "occlusion": "none", "motion_blur": "moderate"},
            {"class_name": "fuel", "box": [200, 200, 205, 260], "confidence": 0.99,
             "visible_fraction": 0.5, "occlusion": "heavy", "motion_blur": "heavy"},
        ], "image_quality": "good"})
        self.assertIsNone(error)
        accepted, reasons = acceptance_decision(result["detections"][0], "good")
        self.assertTrue(accepted)
        self.assertEqual(to_yolo_line(result["detections"][0]).split()[0], "2")
        accepted, reasons = acceptance_decision(result["detections"][1], "good")
        self.assertFalse(accepted)
        self.assertIn("heavy_occlusion", reasons)
        self.assertIn("implausible_fuel_geometry", reasons)

    def test_extracts_json_from_code_fence(self):
        parsed, error = parse_json_response('```json\n{"detections": []}\n```')
        self.assertIsNone(error)
        self.assertEqual(parsed, {"detections": []})


if __name__ == "__main__":
    unittest.main()
