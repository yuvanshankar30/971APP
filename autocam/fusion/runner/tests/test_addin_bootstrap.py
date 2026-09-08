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

    def test_folder_sync_never_touches_data_panel_while_a_modal_command_is_active(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()
        advance = entrypoint[entrypoint.index("def _advance_folder_sync"):entrypoint.index("def handleServer")]

        self.assertIn('_IDLE_COMMAND_IDS = {"", "SelectCommand", "Select"}', entrypoint)
        self.assertIn("def _can_advance_folder_sync()", entrypoint)
        self.assertLess(advance.index("if not _can_advance_folder_sync()"), advance.index("FolderTreeWalker("))
        self.assertIn("_schedule_folder_sync_chunk()", advance)


if __name__ == "__main__":
    unittest.main()
