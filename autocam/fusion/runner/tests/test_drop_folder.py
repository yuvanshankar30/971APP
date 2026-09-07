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

    def test_does_not_log_one_line_per_attempt(self):
        # Six near-identical lines per folder segment made every Fusion
        # launch look like a serious fault. One at the start, one on giving
        # up.
        app = fake_app()
        retry = dropFolder._retry_on_offline(app, attempts=6, initial_delay_seconds=0)

        def always_offline():
            raise RuntimeError("3 : CB_NA - System in offline settings")

        with self.assertRaises(RuntimeError):
            retry(always_offline, "test call")
        self.assertEqual(app.log.call_count, 2)


class OfflineMustNotCreateFoldersTests(unittest.TestCase):
    """An offline lookup failure means we do not KNOW whether a folder
    exists. Treating it as "not found" made resolve_drop_folder go on to
    create a folder that already exists in the team's real Data Panel -
    confirmed in a real startup log, where an offline
    itemByName('Offseason Projects') was followed immediately by
    "'Offseason Projects' folder not found ... creating it".
    """

    def setUp(self):
        # resolve_drop_folder builds its own retry with the real 1s-doubling
        # backoff (31s across 6 attempts). These tests are about which branch
        # is taken, not the waiting, so the sleep is stubbed out.
        self._real_sleep = dropFolder.time.sleep
        dropFolder.time.sleep = lambda _seconds: None

    def tearDown(self):
        dropFolder.time.sleep = self._real_sleep

    def test_offline_lookup_raises_instead_of_creating_a_duplicate(self):
        root = MagicMock()
        root.name = "2026 Season CAM"
        root.dataFolders.itemByName.side_effect = RuntimeError(
            "3 : CB_NA - System in offline settings"
        )
        app = fake_app()
        project = MagicMock()
        project.name = "2026 Season CAM"
        project.rootFolder = root
        app.data.dataProjects.count = 1
        app.data.dataProjects.item.return_value = project

        with self.assertRaises(RuntimeError):
            dropFolder.resolve_drop_folder(app, "2026 Season CAM", "Offseason Projects")

        root.dataFolders.add.assert_not_called()

    def test_a_real_not_found_still_creates_the_folder(self):
        # The InternalValidationError flavor genuinely does mean "missing",
        # and creating it is the correct next step - that behavior must
        # survive the fix above.
        created = MagicMock()
        root = MagicMock()
        root.name = "2026 Season CAM"
        root.dataFolders.itemByName.side_effect = RuntimeError(
            "2 : InternalValidationError : status.isOk() && folders"
        )
        root.dataFolders.add.return_value = created
        app = fake_app()
        project = MagicMock()
        project.name = "2026 Season CAM"
        project.rootFolder = root
        app.data.dataProjects.count = 1
        app.data.dataProjects.item.return_value = project

        _project, folder = dropFolder.resolve_drop_folder(app, "2026 Season CAM", "Offseason Projects")

        root.dataFolders.add.assert_called_once_with("Offseason Projects")
        self.assertIs(folder, created)


if __name__ == "__main__":
    unittest.main()


class OfflineDuringAnotherErrorTests(unittest.TestCase):
    """The real fresh-launch sequence, reproduced: itemByName raises the
    InternalValidationError "not found" flavor, the code correctly moves on
    to create the folder, and add() then fails because the cloud isn't up
    yet. Before this, the post-add fallback ran anyway and raised its own
    validation error, which is what printed a full traceback on every
    Fusion launch.
    """

    def setUp(self):
        self._real_sleep = dropFolder.time.sleep
        dropFolder.time.sleep = lambda _seconds: None

    def tearDown(self):
        dropFolder.time.sleep = self._real_sleep

    def _app_and_project(self, root):
        app = fake_app()
        project = MagicMock()
        project.name = "2026 Season CAM"
        project.rootFolder = root
        app.data.dataProjects.count = 1
        app.data.dataProjects.item.return_value = project
        return app

    def test_offline_add_does_not_run_the_race_fallback(self):
        root = MagicMock()
        root.name = "2026 Season CAM"
        root.dataFolders.itemByName.side_effect = RuntimeError(
            "2 : InternalValidationError : status.isOk() && folders"
        )
        root.dataFolders.add.side_effect = RuntimeError("3 : CB_NA - System in offline settings")
        app = self._app_and_project(root)

        with self.assertRaises(RuntimeError) as caught:
            dropFolder.resolve_drop_folder(app, "2026 Season CAM", "Offseason Projects")

        # The offline cause must survive to the caller so it can be
        # recognized and reported calmly instead of as a crash.
        self.assertTrue(dropFolder._is_offline_settings_error(caught.exception))
        # itemByName ran only for the initial lookup, never as a post-add
        # fallback that cannot succeed while offline.
        self.assertEqual(root.dataFolders.itemByName.call_count, 1)

    def test_detects_offline_buried_in_an_exception_chain(self):
        offline = RuntimeError("3 : CB_NA - System in offline settings")
        try:
            try:
                raise offline
            except RuntimeError:
                raise RuntimeError("2 : InternalValidationError : status.isOk() && folders")
        except RuntimeError as chained:
            self.assertTrue(dropFolder._is_offline_settings_error(chained))

    def test_still_false_when_nothing_in_the_chain_is_offline(self):
        try:
            try:
                raise RuntimeError("some other failure")
            except RuntimeError:
                raise RuntimeError("2 : InternalValidationError : status.isOk() && folders")
        except RuntimeError as chained:
            self.assertFalse(dropFolder._is_offline_settings_error(chained))
