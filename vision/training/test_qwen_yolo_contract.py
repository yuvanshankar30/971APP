import unittest

from qwen_yolo_contract import normalize_result, parse_json_response, to_yolo_line


class QwenYoloContractTests(unittest.TestCase):
    def test_normalizes_and_converts_valid_detection(self):
        result, error = normalize_result({
            "detections": [{
                "class_name": "robot_red", "box": [100, 200, 500, 800],
                "confidence": 1.2, "evidence": "red bumper",
            }],
            "image_quality": "good",
        })
        self.assertIsNone(error)
        self.assertEqual(result["detections"][0]["confidence"], 1.0)
        self.assertEqual(to_yolo_line(result["detections"][0]), "0 0.300000 0.500000 0.400000 0.600000")
        self.assertEqual(result["detections"][0]["review_status"], "unreviewed")

    def test_drops_unknown_classes_and_invalid_boxes(self):
        result, error = normalize_result({"detections": [
            {"class_name": "fuel", "box": [0, 0, 10, 10]},
            {"class_name": "robot_blue", "box": [500, 500, 100, 100]},
        ]})
        self.assertIsNone(error)
        self.assertEqual(result["detections"], [])

    def test_extracts_json_from_code_fence(self):
        parsed, error = parse_json_response('```json\n{"detections": []}\n```')
        self.assertIsNone(error)
        self.assertEqual(parsed, {"detections": []})


if __name__ == "__main__":
    unittest.main()
