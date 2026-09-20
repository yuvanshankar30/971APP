import json
import tempfile
import unittest
from pathlib import Path

from model_contract import validate_model_classes, write_manifest


class ModelContractTest(unittest.TestCase):
    def test_accepts_two_class_robot_checkpoint_and_disables_only_climbs(self):
        contract = validate_model_classes({0: "robot_red", 1: "robot_blue"})
        self.assertEqual(contract["profile"], "alliance_robot")
        self.assertFalse(contract["capabilities"]["climbDetection"])
        self.assertTrue(contract["capabilities"]["robotTracking"])

    def test_accepts_optional_climb_classes(self):
        contract = validate_model_classes(["robot_red", "robot_blue", "climb_success"])
        self.assertTrue(contract["capabilities"]["climbDetection"])

    def test_rejects_fuel_and_incomplete_robot_classes(self):
        with self.assertRaisesRegex(ValueError, "trajectory pipeline"):
            validate_model_classes(["robot_red", "robot_blue", "fuel"])
        with self.assertRaisesRegex(ValueError, "present together"):
            validate_model_classes(["robot_red"])

    def test_writes_versioned_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            write_manifest(path, ["robot_red", "robot_blue"], model_version="abc")
            saved = json.loads(path.read_text())
            self.assertEqual(saved["contractVersion"], "vision-detector/v1")
            self.assertEqual(saved["modelVersion"], "abc")


if __name__ == "__main__":
    unittest.main()
