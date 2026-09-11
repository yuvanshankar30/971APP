import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "local_cam_assets", Path(__file__).parents[1] / "workflows/localCamAssets.py"
)
local_cam_assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_cam_assets)


class SingleToolLibraryTests(unittest.TestCase):
    def test_uses_only_the_selected_numbered_endmill_in_single_tool_mode(self):
        with tempfile.TemporaryDirectory() as output_dir:
            tool, path = local_cam_assets.load_local_tool_library_json(
                {
                    "payload": {"single_tool_mode": True},
                    "cam_tools": {
                        "diameter": 0.1575,
                        "tool_type": "endmill",
                        "tool_number": 1,
                        "fusion_tool_library_file": "Normal router tools (use this).tools",
                    },
                },
                output_dir,
            )
            self.assertEqual(tool["tool_number"], 1)
            entries = json.loads(Path(path).read_text())["data"]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["post-process"]["number"], 1)
            self.assertIn("end mill", entries[0]["type"].lower())

    def test_rejects_a_drill_selected_for_single_tool_mode(self):
        with tempfile.TemporaryDirectory() as output_dir:
            with self.assertRaisesRegex(ValueError, "requires an endmill"):
                local_cam_assets.load_local_tool_library_json(
                    {
                        "payload": {"single_tool_mode": True},
                        "cam_tools": {
                            "diameter": 0.201,
                            "tool_type": "drill",
                            "fusion_tool_library_file": "Normal router tools (use this).tools",
                        },
                    },
                    output_dir,
                )

    def test_multi_tool_mode_has_no_joined_tool_at_all_and_must_not_crash(self):
        # Real, confirmed live case: New Router's Auto multi-tool mode sends
        # tool_id=null (the planner resolves from every loaded candidate
        # server-side, not one manual selection), so data["cam_tools"] is
        # None on the claimed job row - there is no single tool to read a
        # fusion_tool_library_file or diameter from at all. This used to
        # crash outright ("Selected CAM tool has no local Fusion tool
        # library configured").
        endmill_guid = "e7813c26-af06-4d6c-9aba-324fa1b402c1"  # ShopSabre 6, 4mm
        with tempfile.TemporaryDirectory() as output_dir:
            tool, path = local_cam_assets.load_local_tool_library_json(
                {
                    "payload": {"multi_tool_mode": True, "tool_items": [{"tool_guid": endmill_guid}]},
                    "cam_tools": None,
                },
                output_dir,
            )
            self.assertEqual(tool, {})
            entries = json.loads(Path(path).read_text())["data"]
            self.assertIn(endmill_guid, [entry.get("guid") for entry in entries])

    def test_multi_tool_mode_only_includes_a_drill_that_is_actually_a_loaded_candidate(self):
        # A drill NOT in candidate_guids (jobPayload.js only puts genuinely
        # loaded endmill/drill tools there) must stay excluded - unlike
        # single-tool mode, multi-tool mode has no separate "keep every
        # drill" fallback, since the whole point is only ever using what's
        # actually loaded on the machine.
        drill_guid = "24cf5076-1599-42d4-ab65-d7abf5119cfe"
        with tempfile.TemporaryDirectory() as output_dir:
            _tool, path = local_cam_assets.load_local_tool_library_json(
                {
                    "payload": {"multi_tool_mode": True, "tool_items": [
                        {"tool_guid": "29331875-1efc-47c5-9742-f39efcb697ed"}  # 6mm endmill only
                    ]},
                    "cam_tools": None,
                },
                output_dir,
            )
            entries = json.loads(Path(path).read_text())["data"]
            self.assertNotIn(drill_guid, [entry.get("guid") for entry in entries])
            _tool2, path2 = local_cam_assets.load_local_tool_library_json(
                {
                    "payload": {"multi_tool_mode": True, "tool_items": [
                        {"tool_guid": "29331875-1efc-47c5-9742-f39efcb697ed"},
                        {"tool_guid": drill_guid},
                    ]},
                    "cam_tools": None,
                },
                output_dir,
            )
            entries2 = json.loads(Path(path2).read_text())["data"]
            self.assertIn(drill_guid, [entry.get("guid") for entry in entries2])


class PostProcessorSelectionTests(unittest.TestCase):
    def test_new_router_uses_the_bundled_shopsabre_post_when_the_profile_value_is_missing(self):
        path = Path(local_cam_assets.resolve_local_post_processor({
            "cam_machines": {"name": "New Router", "post_processor": None}
        }))

        self.assertEqual(path.name, "shopsabre.cps")
        post = path.read_text()
        self.assertIn('description = "ShopSabre with WinCNC control"', post)
        self.assertIn('extension = "tap"', post)

    def test_new_router_rejects_a_conflicting_post_processor(self):
        with self.assertRaisesRegex(ValueError, r"New Router must use shopsabre\.cps"):
            local_cam_assets.resolve_local_post_processor({
                "cam_machines": {"name": "New Router", "post_processor": "971_emc.cps"}
            })

    def test_unc_router_keeps_its_linuxcnc_post_processor(self):
        path = Path(local_cam_assets.resolve_local_post_processor({
            "cam_machines": {"name": "UNC Router", "post_processor": None}
        }))
        self.assertEqual(path.name, "971_emc.cps")

    def test_971_lathe_uses_the_bundled_haas_turning_post(self):
        # Direct bug report: the lathe's controller kept getting silently
        # reset to 'linuxcnc' by a UI bug, and Fusion's own bundled generic
        # 'linuxcnc' post is CAPABILITY_MILLING only - it cannot turn at
        # all. The lathe is a physical-machine invariant now, same as New
        # Router/UNC Router, so a stale profile can't silently post through
        # the wrong dialect again.
        path = Path(local_cam_assets.resolve_local_post_processor({
            "cam_machines": {"name": "971 Lathe", "post_processor": "haas turning"}
        }))
        self.assertEqual(path.name, "haas_turning.cps")
        post = path.read_text()
        self.assertIn('description = "HAAS Turning"', post)
        self.assertIn("capabilities = CAPABILITY_TURNING", post)

    def test_971_lathe_rejects_a_conflicting_post_processor(self):
        with self.assertRaisesRegex(ValueError, r"971 Lathe must use haas_turning\.cps"):
            local_cam_assets.resolve_local_post_processor({
                "cam_machines": {"name": "971 Lathe", "post_processor": "linuxcnc"}
            })

    def test_971_lathe_still_resolves_with_no_configured_post_processor(self):
        path = Path(local_cam_assets.resolve_local_post_processor({
            "cam_machines": {"name": "971 Lathe", "post_processor": None}
        }))
        self.assertEqual(path.name, "haas_turning.cps")


if __name__ == "__main__":
    unittest.main()
