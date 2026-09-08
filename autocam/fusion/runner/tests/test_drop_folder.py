import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, call, patch


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


def _fake_folder(name, children=()):
    """A MagicMock standing in for a Fusion DataFolder: .name, and
    .dataFolders.count/.item(i) backed by `children` (also _fake_folder
    instances), matching how list_data_folder_tree's walk() actually
    reads a real folder.
    """
    folder = MagicMock()
    folder.name = name
    folder.dataFolders.count = len(children)
    folder.dataFolders.item.side_effect = lambda i, _c=children: _c[i]
    return folder


class FolderTreeBudgetTests(unittest.TestCase):
    """list_data_folder_tree can now be pointed at the project ROOT
    (FUSION_DROP_FOLDER_PATH defaults to "" - see config.py), not just a
    pre-scoped subfolder - direct instruction: the picker should show
    every folder under the project, not just the configured drop folder's
    own subtree. A full, unbounded walk from the root was confirmed live
    to time out the MCP bridge, so max_folders bounds the real cost driver
    (dataFolders.item() calls, each a genuine Fusion cloud round-trip)
    instead of relying on scope alone to keep this fast.
    """

    def setUp(self):
        # The walk now paces real dataFolders.item() calls with a real
        # sleep (see _FOLDER_WALK_CALL_PACING_SEC) - genuinely useful
        # against Fusion's live API, pure overhead in a unit test with a
        # mocked one. Patched to a no-op for every test in this class
        # rather than per-test, since it's not what any of them are
        # actually testing.
        patcher = patch.object(dropFolder.time, "sleep")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _app_for(self, root):
        app = fake_app()
        project = MagicMock()
        project.name = "2026 Season CAM"
        project.rootFolder = root
        app.data.dataProjects.count = 1
        app.data.dataProjects.item.return_value = project
        return app

    def test_walks_the_whole_tree_when_well_under_budget(self):
        leaf_a = _fake_folder("Turning")
        leaf_b = _fake_folder("Tubes")
        root = _fake_folder("2026 Season CAM", [leaf_a, leaf_b])
        app = self._app_for(root)

        result = dropFolder.list_data_folder_tree(app, "2026 Season CAM", "", max_folders=200)

        names = sorted(child["name"] for child in result["root"]["children"])
        self.assertEqual(names, ["Tubes", "Turning"])
        self.assertNotIn("truncated", result["root"])
        for child in result["root"]["children"]:
            self.assertNotIn("truncated", child)

    def test_resumable_walker_makes_one_cloud_call_per_chunk(self):
        root = _fake_folder("2026 Season CAM", [_fake_folder("One"), _fake_folder("Two")])
        app = self._app_for(root)
        walker = dropFolder.FolderTreeWalker(app, "2026 Season CAM", "", max_folders=10)

        self.assertFalse(walker.run_chunk())  # root.dataFolders.count
        self.assertEqual(root.dataFolders.item.call_count, 0)
        self.assertFalse(walker.run_chunk())  # first child
        self.assertEqual(root.dataFolders.item.call_count, 1)
        self.assertFalse(walker.run_chunk())  # second child
        self.assertEqual(root.dataFolders.item.call_count, 2)
        while not walker.run_chunk():
            pass
        self.assertEqual([child["name"] for child in walker.result()["root"]["children"]], ["One", "Two"])

    def test_stops_early_and_marks_truncation_once_the_budget_runs_out(self):
        # 5 real folders at the root; a budget of 2 must not visit the
        # other 3 (each unvisited .item() call is exactly the cost this
        # budget exists to bound) or hang trying to.
        children = [_fake_folder(f"Folder{i}") for i in range(5)]
        root = _fake_folder("2026 Season CAM", children)
        app = self._app_for(root)

        result = dropFolder.list_data_folder_tree(app, "2026 Season CAM", "", max_folders=2)

        self.assertEqual(len(result["root"]["children"]), 2)
        self.assertTrue(result["root"]["truncated"])
        root.dataFolders.item.assert_has_calls([call(0), call(1)])
        self.assertEqual(root.dataFolders.item.call_count, 2)

    def test_budget_is_shared_across_the_whole_walk_not_per_node(self):
        # A wide-then-deep tree: 3 folders at the root, one of which has 3
        # of its own children. A budget of 4 must spend some on the root's
        # own siblings and leave only 1 for that subfolder's children -
        # confirming the budget is a single running total, not reset per
        # recursion level (which would let a pathological tree blow past
        # it depth by depth).
        grandchildren = [_fake_folder(f"Sub{i}") for i in range(3)]
        child_with_kids = _fake_folder("HasKids", grandchildren)
        siblings = [child_with_kids, _fake_folder("Plain1"), _fake_folder("Plain2")]
        root = _fake_folder("2026 Season CAM", siblings)
        app = self._app_for(root)

        result = dropFolder.list_data_folder_tree(app, "2026 Season CAM", "", max_folders=4)

        self.assertEqual(root.dataFolders.item.call_count, 3)
        self.assertFalse(result["root"].get("truncated", False))
        has_kids_node = next(c for c in result["root"]["children"] if c["name"] == "HasKids")
        self.assertEqual(len(has_kids_node["children"]), 1)
        self.assertTrue(has_kids_node["truncated"])

    def test_max_depth_still_bounds_recursion_independent_of_budget(self):
        deep_child = _fake_folder("TooDeep")
        mid = _fake_folder("Mid", [deep_child])
        root = _fake_folder("2026 Season CAM", [mid])
        app = self._app_for(root)

        result = dropFolder.list_data_folder_tree(app, "2026 Season CAM", "", max_depth=1, max_folders=200)

        mid_node = result["root"]["children"][0]
        self.assertEqual(mid_node["name"], "Mid")
        self.assertEqual(mid_node["children"], [])
        self.assertNotIn("truncated", mid_node)
        # A budget-exhaustion truncation would look identical in shape to
        # a depth cutoff if this weren't checked - depth stopping must not
        # spend budget it didn't need to.
        deep_child.dataFolders.item.assert_not_called()

    def test_offseason_projects_gets_first_claim_on_a_tight_budget(self):
        # Live-confirmed bug: raising max_folders alone (60 -> 150) still
        # left "Offseason Projects" - where AutoCAM documents actually
        # live - with zero children, because it happened to be listed
        # after two other top-level folders whose own children (5 each)
        # consumed the whole remaining budget first. Reproduced here with
        # the same shape, "Offseason Projects" deliberately LAST in the
        # root's own child order (the worst case) - it must still get its
        # children listed, at its siblings' expense if the budget is
        # tight, not the other way around.
        offseason_children = [_fake_folder(f"OffseasonSub{i}") for i in range(3)]
        offseason = _fake_folder("Offseason Projects", offseason_children)
        other_a = _fake_folder("Field Elements", [_fake_folder(f"FieldSub{i}") for i in range(5)])
        other_b = _fake_folder("Renders", [_fake_folder(f"RenderSub{i}") for i in range(5)])
        # Deliberately last, not first - the whole point of this test.
        root = _fake_folder("2026 Season CAM", [other_a, other_b, offseason])
        app = self._app_for(root)

        # 3 for the root's own 3 children, leaving exactly 3 for depth-2 -
        # enough for Offseason Projects' own 3 children and nothing else.
        result = dropFolder.list_data_folder_tree(app, "2026 Season CAM", "", max_folders=6)

        offseason_node = next(c for c in result["root"]["children"] if c["name"] == "Offseason Projects")
        self.assertEqual(len(offseason_node["children"]), 3)
        self.assertNotIn("truncated", offseason_node)
        for name in ("Field Elements", "Renders"):
            sibling_node = next(c for c in result["root"]["children"] if c["name"] == name)
            self.assertEqual(sibling_node["children"], [])
            self.assertTrue(sibling_node["truncated"])


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
