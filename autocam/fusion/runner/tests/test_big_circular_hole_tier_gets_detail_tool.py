"""Direct instruction: a "decently large" recognized circular through-hole
should use the New Router's bigger loaded endmill on the dedicated
">.3 Circular Through Hole (sized)" operation, not whichever cutter it
would otherwise get uniformly (previously always the largest, regardless
of how close a hole sat to the operation's own 0.3in base threshold).

patch_cam_template_with_tool_libraries now clones that operation into a
"regular" tier (kept, detail cutter) and a "big endmill" tier (largest
cutter) whenever a real New Router multi-tool ATC swap plan is active -
the same through_shape_tool_swaps_enabled gate the Shape Through Hole
family already uses, so this is New Router multi-tool only by
construction, never Old Router and never a single-cutter job.
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
_BIG_HOLE_DESCRIPTION = ">.3 Circular Through Hole (sized)"


class BigCircularHoleTierGetsDetailToolTests(unittest.TestCase):
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

    def _big_hole_ops(self, root):
        return [
            t for t in root.findall("x:template", _NS)
            if t.get("description", "").startswith(_BIG_HOLE_DESCRIPTION)
        ]

    def test_multi_tool_swap_clones_a_regular_and_a_big_endmill_tier(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})
        ops = self._big_hole_ops(root)

        self.assertEqual(len(ops), 2)
        descriptions = sorted(op.get("description") for op in ops)
        self.assertEqual(descriptions, [_BIG_HOLE_DESCRIPTION, f"{_BIG_HOLE_DESCRIPTION} big endmill"])

    def test_regular_tier_gets_the_smaller_loaded_endmill(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})
        regular = next(
            op for op in self._big_hole_ops(root) if op.get("description") == _BIG_HOLE_DESCRIPTION
        )
        self.assertEqual(regular.find("x:tool", _NS).get("guid"), _SMALL_ENDMILL_GUID)

    def test_big_endmill_tier_gets_the_larger_loaded_endmill(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})
        big = next(
            op for op in self._big_hole_ops(root)
            if op.get("description") == f"{_BIG_HOLE_DESCRIPTION} big endmill"
        )
        self.assertEqual(big.find("x:tool", _NS).get("guid"), _LARGE_ENDMILL_GUID)

    def test_single_endmill_loaded_keeps_exactly_one_operation(self):
        # No genuinely smaller detail candidate at all - nothing to split
        # on, must not clone.
        root = self._patch({_LARGE_ENDMILL_GUID})
        ops = self._big_hole_ops(root)

        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0].get("description"), _BIG_HOLE_DESCRIPTION)
        self.assertEqual(ops[0].find("x:tool", _NS).get("guid"), _LARGE_ENDMILL_GUID)

    def test_single_tool_mode_keeps_exactly_one_operation(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID}, multi_tool_mode=False)
        ops = self._big_hole_ops(root)

        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0].get("description"), _BIG_HOLE_DESCRIPTION)

    def test_old_router_template_has_no_dedicated_big_hole_operation_to_split(self):
        # (DEPRECATED)971 Metal Sheet has no separate big-hole operation at
        # all - confirms this feature can never fire for Old Router,
        # independent of the through_shape_tool_swaps_enabled gate.
        root = self._patch(
            {_LARGE_ENDMILL_GUID}, multi_tool_mode=False, template_path=_OLD_ROUTER_TEMPLATE_PATH
        )
        self.assertEqual(self._big_hole_ops(root), [])


if __name__ == "__main__":
    unittest.main()
