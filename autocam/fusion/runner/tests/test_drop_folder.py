import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock


spec = importlib.util.spec_from_file_location(
    "dropFolder", Path(__file__).parents[1] / "workflows/dropFolder.py"
)
dropFolder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dropFolder)


def fake_app():
    app = MagicMock()
    app.log = MagicMock()
    return app


class OfflineSettingsRetryTests(unittest.TestCase):
    def test_recognizes_offline_settings_error(self):
        self.assertTrue(dropFolder._is_offline_settings_error(RuntimeError("3 : CB_NA - System in offline settings")))
        self.assertTrue(dropFolder._is_offline_settings_error(RuntimeError("System In Offline Settings")))

    def test_does_not_misclassify_other_runtime_errors(self):
        self.assertFalse(
            dropFolder._is_offline_settings_error(
                RuntimeError("2 : InternalValidationError : status.isOk() && folders")
            )
        )

    def test_retries_until_success_on_offline_error(self):
        app = fake_app()
        retry = dropFolder._retry_on_offline(app, attempts=4, initial_delay_seconds=0)
        calls = {"count": 0}

        def flaky():
            calls["count"] += 1
            if calls["count"] < 3:
                raise RuntimeError("3 : CB_NA - System in offline settings")
            return "folder"

        result = retry(flaky, "test call")
        self.assertEqual(result, "folder")
        self.assertEqual(calls["count"], 3)

    def test_does_not_retry_a_non_offline_error(self):
        app = fake_app()
        retry = dropFolder._retry_on_offline(app, attempts=4, initial_delay_seconds=0)
        calls = {"count": 0}

        def always_fails():
            calls["count"] += 1
            raise RuntimeError("2 : InternalValidationError : status.isOk() && folders")

        with self.assertRaises(RuntimeError):
            retry(always_fails, "test call")
        self.assertEqual(calls["count"], 1)

    def test_exhausts_attempts_and_raises_the_last_offline_error(self):
        app = fake_app()
        retry = dropFolder._retry_on_offline(app, attempts=3, initial_delay_seconds=0)
        calls = {"count": 0}

        def always_offline():
            calls["count"] += 1
            raise RuntimeError("3 : CB_NA - System in offline settings")

        with self.assertRaises(RuntimeError):
            retry(always_offline, "test call")
        self.assertEqual(calls["count"], 3)


if __name__ == "__main__":
    unittest.main()
