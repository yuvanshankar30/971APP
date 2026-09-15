"""Real, confirmed live failure: a real angad_part job (100x100x0.125in
Aluminum 6061, New Router, multi-tool mode with the 4mm and 6mm endmills
loaded) crashed with

    RuntimeError: A Shape Through Finishing Pass survived toolpath
    generation with no matching Shape Through Hole roughing operation in
    the same setup

even though camPlate.py's own _require_through_hole_for_finishing_pass
guard is correct - the Runner's log showed "Shape Through Hole" and
"Small Shape Through Hole" both removed for "no matching geometry", and
the one surviving tier ("Shape Through Hole big endmill") logged
"Generated toolpath is empty" despite having geometry.

Root cause: patch_cam_template_with_tool_libraries assigned the SAME
largest_endmill to all three of the template's through-hole roughing
tiers ("Shape Through Hole big endmill", "Shape Through Hole", "Small
Shape Through Hole"), even though the exported New Router template uses
the regular and small tiers as 4 mm entry envelopes. With all three tiers
reporting the 6 mm diameter, a shape whose 6 mm helical ramp could not
enter was routed to the big operation and Fusion generated an empty
toolpath.
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

_SMALL_ENDMILL_GUID = "e7813c26-af06-4d6c-9aba-324fa1b402c1"  # 4mm, 0.1575in
_LARGE_ENDMILL_GUID = "29331875-1efc-47c5-9742-f39efcb697ed"  # 6mm, 0.2362in


class SmallThroughHoleTierGetsDetailToolTests(unittest.TestCase):
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

    def _tool_guid(self, root, description):
        template = next(
            t for t in root.findall("x:template", _NS) if t.get("description") == description
        )
        return template.find("x:tool", _NS).get("guid")

    def _descriptions(self, root):
        return {t.get("description") for t in root.findall("x:template", _NS)}

    def test_small_tier_gets_the_smaller_loaded_endmill_not_the_uniform_largest(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})

        self.assertEqual(self._tool_guid(root, "Small Shape Through Hole"), _SMALL_ENDMILL_GUID)

    def test_regular_and_small_through_hole_tiers_get_the_detail_endmill(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})

        self.assertEqual(self._tool_guid(root, "Shape Through Hole"), _SMALL_ENDMILL_GUID)
        self.assertEqual(self._tool_guid(root, "Small Shape Through Hole"), _SMALL_ENDMILL_GUID)

    def test_big_through_hole_tier_keeps_the_largest_endmill(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})

        self.assertEqual(self._tool_guid(root, "Shape Through Hole big endmill"), _LARGE_ENDMILL_GUID)

    def test_finishing_pass_uses_the_detail_endmill_with_its_roughing_tier(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})

        self.assertEqual(self._tool_guid(root, "Shape Through Finishing Pass"), _SMALL_ENDMILL_GUID)

    def test_single_endmill_loaded_omits_the_atc_only_big_tier(self):
        # No actual endmill swap is planned, so only the regular/middle tier
        # remains. The small and big tiers are ATC-only optimizations.
        root = self._patch({_LARGE_ENDMILL_GUID})

        self.assertEqual(self._tool_guid(root, "Shape Through Hole"), _LARGE_ENDMILL_GUID)
        self.assertNotIn("Small Shape Through Hole", self._descriptions(root))
        self.assertNotIn("Shape Through Hole big endmill", self._descriptions(root))

    def test_single_tool_mode_keeps_only_the_regular_middle_tier(self):
        root = self._patch({_LARGE_ENDMILL_GUID}, multi_tool_mode=False)

        self.assertIn("Shape Through Hole", self._descriptions(root))
        self.assertNotIn("Small Shape Through Hole", self._descriptions(root))
        self.assertNotIn("Shape Through Hole big endmill", self._descriptions(root))

    def test_old_router_keeps_only_the_regular_middle_tier(self):
        root = self._patch(
            {_LARGE_ENDMILL_GUID}, multi_tool_mode=False, template_path=_OLD_ROUTER_TEMPLATE_PATH
        )

        self.assertIn("Shape Through Hole", self._descriptions(root))
        self.assertNotIn("Small Shape Through Hole", self._descriptions(root))
        self.assertNotIn("Shape Through Hole big endmill", self._descriptions(root))

    def test_shape_through_tier_names_are_classified_exactly(self):
        self.assertEqual(template_tools._through_shape_roughing_tier("Shape Through Hole"), "middle")
        self.assertEqual(template_tools._through_shape_roughing_tier("Small Shape Through Hole"), "small")
        self.assertEqual(
            template_tools._through_shape_roughing_tier("Shape Through Hole big endmill"), "big"
        )
        self.assertIsNone(template_tools._through_shape_roughing_tier("Shape Through Finishing Pass"))


if __name__ == "__main__":
    unittest.main()
