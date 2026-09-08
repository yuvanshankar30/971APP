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

    def test_includes_only_the_explicit_countersink_in_the_generated_library(self):
        countersink_guid = "61a8645a-9015-4aba-958b-70297d26b19e"
        with tempfile.TemporaryDirectory() as output_dir:
            _, path = local_cam_assets.load_local_tool_library_json(
                {
                    "payload": {"single_tool_mode": True, "countersink_tool": {"guid": countersink_guid}},
                    "cam_tools": {
                        "diameter": 0.1575,
                        "tool_type": "endmill",
                        "tool_number": 1,
                        "fusion_tool_library_file": "Normal router tools (use this).tools",
                    },
                },
                output_dir,
            )
            entries = json.loads(Path(path).read_text())["data"]
            countersinks = [entry for entry in entries if "counter sink" in entry["type"].lower()]
            self.assertEqual([entry["guid"] for entry in countersinks], [countersink_guid])


if __name__ == "__main__":
    unittest.main()
