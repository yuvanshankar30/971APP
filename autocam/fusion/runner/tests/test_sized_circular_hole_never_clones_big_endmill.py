"""Direct instruction: ">.3 Circular Through Hole (sized) big endmill" is
not a real Fusion operation and must never exist. patch_cam_template_with_
tool_libraries used to clone the dedicated ">.3 Circular Through Hole
(sized)" operation into a "regular"/"big endmill" pair whenever a real New
Router multi-tool ATC swap plan was active, mirroring how the Shape
Through Hole family splits into three real, manually-authored operations -
but unlike that family, there was never a real "big endmill" variant of
this operation in the actual Fusion template export, so synthesizing one
via XML cloning invented an operation with no basis in the real template.

The sized hole is now always exactly one operation, in every mode, with
every tool combination: it resolves to the real sized cutter (Tool 6)
when one is loaded for the job, falling back to the general detail cutter
otherwise - never split, never cloned.
"""

import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("template_tools", ROOT / "workflows/templateTools.py")
template_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(template_tools)

_TEMPLATE_PATH = ROOT / "templates/971-real/new router metal sheet (shopsabre only!!).f3dhsm-template"
_OLD_ROUTER_TEMPLATE_PATH = ROOT / "templates/971-real/(DEPRECATED)971 Metal Sheet.f3dhsm-template"
_LIBRARY_PATH = ROOT / "tools/Normal router tools (use this).tools"
_NS = {"x": "http://www.hsmworks.com/namespace/hsmworks/document/template"}

_SIZED_ENDMILL_GUID = "e7813c26-af06-4d6c-9aba-324fa1b402c1"  # "4mm sized for toolchager", Tool 6
_LARGE_ENDMILL_GUID = "29331875-1efc-47c5-9742-f39efcb697ed"  # "6mm for toolchanger", Tool 2
_REAL_TOOL_1_GUID = "10a2caeb-dec0-49b2-8701-96fdb212bad9"  # "971 Main Bit", Tool 1
_SIZED_HOLE_DESCRIPTION = ">.3 Circular Through Hole (sized)"


class SizedCircularHoleNeverClonesBigEndmillTests(unittest.TestCase):
    def _patch(self, filter_guids, multi_tool_mode=True, template_path=_TEMPLATE_PATH):
        with zipfile.ZipFile(_LIBRARY_PATH) as archive:
            parsed = json.loads(archive.read("tools.json"))
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            tool_json.write_text(json.dumps(parsed))
            output = Path(directory) / "patched.f3dhsm-template"
            template_tools.patch_cam_template_with_tool_libraries(
                str(template_path),
                str(output),
                [str(tool_json)],
                material_name="Aluminum 6061",
                filter_guids=filter_guids,
                multi_tool_mode=multi_tool_mode,
            )
            return ET.parse(output).getroot()

    def _sized_hole_ops(self, root):
        return [
            t for t in root.findall("x:template", _NS)
            if t.get("description", "").startswith(_SIZED_HOLE_DESCRIPTION)
        ]

    def test_multi_tool_job_with_every_tool_loaded_still_has_exactly_one_operation(self):
        # The exact scenario that used to trigger the clone: the sized
        # cutter AND a genuinely bigger general cutter both loaded together.
        root = self._patch({_REAL_TOOL_1_GUID, _SIZED_ENDMILL_GUID, _LARGE_ENDMILL_GUID})
        ops = self._sized_hole_ops(root)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0].get("description"), _SIZED_HOLE_DESCRIPTION)

    def test_sized_hole_uses_the_real_sized_cutter_when_loaded(self):
        root = self._patch({_REAL_TOOL_1_GUID, _SIZED_ENDMILL_GUID, _LARGE_ENDMILL_GUID})
        ops = self._sized_hole_ops(root)
        self.assertEqual(ops[0].find("x:tool", _NS).get("guid"), _SIZED_ENDMILL_GUID)

    def test_sized_hole_falls_back_to_the_detail_cutter_when_the_sized_cutter_is_not_loaded(self):
        # The operator didn't select Tool 6 for this job at all - the sized
        # hole must still resolve to something sensible (the general detail
        # cutter), not be left unassigned or invent a big-endmill clone.
        root = self._patch({_REAL_TOOL_1_GUID, _LARGE_ENDMILL_GUID})
        ops = self._sized_hole_ops(root)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_1_GUID)

    def test_single_endmill_loaded_keeps_exactly_one_operation(self):
        root = self._patch({_LARGE_ENDMILL_GUID})
        ops = self._sized_hole_ops(root)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0].get("description"), _SIZED_HOLE_DESCRIPTION)

    def test_single_tool_mode_keeps_exactly_one_operation(self):
        root = self._patch({_SIZED_ENDMILL_GUID, _LARGE_ENDMILL_GUID}, multi_tool_mode=False)
        ops = self._sized_hole_ops(root)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0].get("description"), _SIZED_HOLE_DESCRIPTION)

    def test_old_router_template_has_no_dedicated_sized_hole_operation_at_all(self):
        root = self._patch(
            {_LARGE_ENDMILL_GUID}, multi_tool_mode=False, template_path=_OLD_ROUTER_TEMPLATE_PATH
        )
        self.assertEqual(self._sized_hole_ops(root), [])


if __name__ == "__main__":
    unittest.main()
