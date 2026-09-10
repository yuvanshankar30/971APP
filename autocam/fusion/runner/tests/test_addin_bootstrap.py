import json
from pathlib import Path
import unittest


RUNNER_DIR = Path(__file__).parents[1]


class DependencyBootstrapTests(unittest.TestCase):
    def test_dependency_path_is_added_before_workflow_imports(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()

        self.assertLess(
            entrypoint.index("from .config import *"),
            entrypoint.index("from .workflows import importPlate"),
        )

    def test_config_inserts_the_override_path_at_the_front_of_sys_path(self):
        config = (RUNNER_DIR / "config.py").read_text()

        self.assertIn("sys.path.insert(0, OVERRIDE_PATH)", config)

    def test_stored_api_key_does_not_pump_fusion_events_during_startup(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()
        gate = entrypoint[entrypoint.index("def _startup_key_gate"):entrypoint.index("_FOLDER_SYNC_INTERVAL_SEC")]

        self.assertNotIn("createProgressDialog(", gate)
        self.assertNotIn("adsk.doEvents(", gate)

    def test_runner_manifest_starts_the_addin_automatically(self):
        manifest = json.loads((RUNNER_DIR / "SpartanRoboticsAutoCAM.manifest").read_text())

        self.assertTrue(manifest["runOnStartup"])

    def test_idle_runner_checks_for_updates_before_claiming_more_work(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()
        server = entrypoint[entrypoint.index("def handleServer"):]

        self.assertIn("_UPDATE_CHECK_INTERVAL_SEC = 300.0", entrypoint)
        self.assertLess(
            server.index("now - _last_update_check >= _UPDATE_CHECK_INTERVAL_SEC"),
            server.index("action=claim"),
        )
        self.assertIn("stopping job claims until Fusion restarts", server)
        self.assertIn("while _pending_update_version and not stop_event.wait(5)", server)

    def test_documents_default_to_the_season_project_root(self):
        config = (RUNNER_DIR / "config.py").read_text()

        self.assertIn('FUSION_DROP_FOLDER_PATH = _read_env_value("FUSION_DROP_FOLDER_PATH")', config)

    def test_folder_picker_browses_from_the_same_root_saves_default_to(self):
        # The picker's tree walk must start at FUSION_DROP_FOLDER_PATH (the
        # project root when unset), not a hardcoded subtree - the walk's
        # own max_folders budget (see list_data_folder_tree) already bounds
        # the real cost, so narrowing the start point here isn't needed and
        # previously hid everything outside "Offseason Projects/AutoCAM"
        # from the picker.
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()

        self.assertIn("FolderTreeWalker", entrypoint)
        self.assertIn("_advance_folder_sync()", entrypoint)
        self.assertNotIn("Offseason Projects/AutoCAM", entrypoint)

    def test_folder_sync_yields_between_data_panel_calls(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()
        self.assertIn("_FOLDER_SYNC_CHUNK_DELAY_SEC", entrypoint)
        self.assertIn("_schedule_folder_sync_chunk()", entrypoint)
        self.assertIn("FusionFolderSyncUpload", entrypoint)

    def test_active_cam_jobs_do_not_starve_folder_refreshes(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()
        loop = entrypoint[entrypoint.index("def handleServer"):]

        self.assertLess(
            loop.index("if now - _last_folder_sync >= _FOLDER_SYNC_INTERVAL_SEC:"),
            loop.index("if _job_processing.is_set():"),
        )

    def test_folder_sync_never_touches_data_panel_while_a_modal_command_is_active(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()
        advance = entrypoint[entrypoint.index("def _advance_folder_sync"):entrypoint.index("def handleServer")]

        self.assertIn('_IDLE_COMMAND_IDS = {"", "SelectCommand", "Select"}', entrypoint)
        self.assertIn("def _can_advance_folder_sync()", entrypoint)
        self.assertLess(advance.index("if not _can_advance_folder_sync()"), advance.index("FolderTreeWalker("))
        self.assertIn("_schedule_folder_sync_chunk()", advance)

    def test_folder_sync_request_is_never_starved_by_sustained_job_traffic(self):
        # Real, confirmed live bug: the periodic folder-sync-interval check
        # used to sit AFTER the _job_processing.is_set()/_job_queue.empty()
        # early-continues in handleServer's loop - with jobs queued and
        # processed back-to-back (this shop's actual usage pattern), that
        # line was never reached at all, so _folder_sync_requested never
        # got set, ever, for as long as jobs kept coming. The synced tree
        # sat on one stale, incorrectly-subfolder-rooted value for the
        # Runner's entire uptime as a direct result - not a slow refresh,
        # a permanently stuck one. Setting the request flag is cheap (no
        # Fusion API calls); it must be checked unconditionally, ahead of
        # both job-state early-continues.
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()
        server = entrypoint[entrypoint.index("def handleServer"):]
        server = server[:server.index("\ndef ", 1)]

        self.assertLess(
            server.index("_folder_sync_requested.set()"),
            server.index("if _job_processing.is_set()"),
        )
        self.assertLess(
            server.index("_folder_sync_requested.set()"),
            server.index("if not _job_queue.empty()"),
        )


if __name__ == "__main__":
    unittest.main()
