"""patch_cam_template_with_tool_libraries reserves Tool 2 (the "6mm for
toolchanger" big endmill) for operations whose own description literally
says "big endmill" - every other roughing/contour operation must default
to Tool 1 (the "971 Main Bit") instead.

Direct instruction: T2 should ONLY be used for big endmill operations
(things with "big endmill" in the Fusion operation name) and nothing
else. Before this fix, every generic roughing/contour template that
wasn't the detail-tier "Shape Through Hole" family or the dedicated sized
hole (Shape Pocket, Shape Pocket Finishing Pass, >.3 Circular Pocket,
Slot Cut for Features) fell through to `largest_endmill`, which is Tool 2
whenever it's loaded - none of those operation names say "big endmill".
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

_NEW_ROUTER_TEMPLATE_PATH = ROOT / "templates/971-real/new router metal sheet (shopsabre only!!).f3dhsm-template"
_LIBRARY_PATH = ROOT / "tools/Normal router tools (use this).tools"
_NS = {"x": "http://www.hsmworks.com/namespace/hsmworks/document/template"}

_REAL_TOOL_1_GUID = "10a2caeb-dec0-49b2-8701-96fdb212bad9"  # "971 Main Bit"
_LARGE_ENDMILL_GUID = "29331875-1efc-47c5-9742-f39efcb697ed"  # "6mm for toolchanger" (Tool 2)
_REAL_TOOL_6_GUID = "e7813c26-af06-4d6c-9aba-324fa1b402c1"  # "4mm sized for toolchager" (Tool 6)

# The release/slot cut resolves independently of this general assignment
# pass (see test_release_cut_forced_to_tool_6.py) - excluded here since
# this test is only about the generic roughing/contour default.
_RELEASE_CUT_DESCRIPTIONS = {"Slot Cut for Edges"}


class Tool2ReservedForBigEndmillTests(unittest.TestCase):
    def _patch(self):
        with zipfile.ZipFile(_LIBRARY_PATH) as archive:
            library_json = archive.read("tools.json").decode("utf-8")
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            tool_json.write_text(library_json)
            output = Path(directory) / "patched.f3dhsm-template"
            template_tools.patch_cam_template_with_tool_libraries(
                str(_NEW_ROUTER_TEMPLATE_PATH),
                str(output),
                [str(tool_json)],
                material_name="Aluminum 6061",
                multi_tool_mode=True,
            )
            return ET.parse(output).getroot()

    def test_only_big_endmill_named_operations_get_tool_2(self):
        root = self._patch()
        for template_elem in root.findall("x:template", _NS):
            description = str(template_elem.get("description") or "")
            if description in _RELEASE_CUT_DESCRIPTIONS:
                continue
            tool_elem = template_elem.find("x:tool", _NS)
            if tool_elem is None:
                continue
            guid = tool_elem.get("guid")
            if guid != _LARGE_ENDMILL_GUID:
                continue
            self.assertIn(
                "big endmill", description.lower(),
                f"{description!r} was assigned Tool 2 but its name doesn't say 'big endmill'",
            )

    def test_generic_pocket_and_slot_operations_default_to_tool_1_not_tool_2(self):
        root = self._patch()
        by_description = {
            str(t.get("description") or ""): t.find("x:tool", _NS)
            for t in root.findall("x:template", _NS)
        }
        for description in (
            "Shape Pocket",
            "Shape Pocket Finishing Pass",
            ">.3 Circular Pocket",
            "Slot Cut for Features",
        ):
            tool_elem = by_description.get(description)
            self.assertIsNotNone(tool_elem, f"expected an operation named {description!r}")
            self.assertEqual(
                tool_elem.get("guid"), _REAL_TOOL_1_GUID,
                f"{description!r} should default to Tool 1, not Tool 2",
            )

    def test_big_endmill_operations_still_get_tool_2(self):
        root = self._patch()
        by_description = {
            str(t.get("description") or ""): t.find("x:tool", _NS)
            for t in root.findall("x:template", _NS)
        }
        for description in (
            "Shape Through Hole big endmill",
            ">.3 Circular Through Hole (sized) big endmill",
        ):
            tool_elem = by_description.get(description)
            self.assertIsNotNone(tool_elem, f"expected an operation named {description!r}")
            self.assertEqual(tool_elem.get("guid"), _LARGE_ENDMILL_GUID)

    def test_sized_hole_still_gets_tool_6_not_tool_1_or_tool_2(self):
        root = self._patch()
        by_description = {
            str(t.get("description") or ""): t.find("x:tool", _NS)
            for t in root.findall("x:template", _NS)
        }
        tool_elem = by_description.get(">.3 Circular Through Hole (sized)")
        self.assertIsNotNone(tool_elem)
        self.assertEqual(tool_elem.get("guid"), _REAL_TOOL_6_GUID)


if __name__ == "__main__":
    unittest.main()
