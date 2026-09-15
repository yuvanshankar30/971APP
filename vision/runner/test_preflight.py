import argparse
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from preflight import collect


class PreflightTest(unittest.TestCase):
    def test_secret_is_reported_without_being_printed(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "model.pt"
            model.write_bytes(b"0" * 1_000_000)
            args = argparse.Namespace(api_url="https://example.test/api/vision-runner", model_path=str(model), qwen_url="http://127.0.0.1:8000", skip_network=True)
            with patch.dict(os.environ, {"VISION_RUNNER_TOKEN": "do-not-print-this"}, clear=True):
                checks = collect(args)
            token = next(check for check in checks if check["name"] == "VISION_RUNNER_TOKEN")
            self.assertTrue(token["ok"])
            self.assertEqual(token["detail"], "set")
            self.assertNotIn("do-not-print-this", str(checks))

    def test_placeholder_sized_model_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "model.pt"
            model.write_bytes(b"placeholder")
            args = argparse.Namespace(api_url="x", model_path=str(model), qwen_url="x", skip_network=True)
            with patch.dict(os.environ, {"VISION_RUNNER_TOKEN": "set"}, clear=True):
                checks = collect(args)
            self.assertFalse(next(check for check in checks if check["name"] == "model is not placeholder-sized")["ok"])


if __name__ == "__main__":
    unittest.main()
