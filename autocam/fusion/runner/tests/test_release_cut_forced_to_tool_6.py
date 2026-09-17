"""patch_cam_template_with_tool_libraries forces the release/slot cut onto
Tool 6, independent of everything else it does for every other operation.

Direct operator report, with a real posted G-code snippet: the release cut
("2D Slot Cut" / "Slot Cut for Edges", strategy="contour2d") posted under
"[Tool 2]" / T2 because it fell through to the same largest-endmill/
description-matching assignment every other contour2d template gets -
whichever tool that resolved to in the job's own loaded tool library, not
necessarily Tool 6. Confirmed live via the Fusion MCP against a real open
document: its real "Slot Cut for Edges" operation really was on Tool 2.

Direct instruction: only Tool 6 is approved. The release cut's tool is a
fixed machine constant (Tool 6 lives permanently in the shop's ATC), not a
per-job cutting-tool choice, so it must resolve independently of
filter_guids - the set of tools an operator actually selected for this
part's own geometry, which has no reason to include Tool 6 at all.
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
_OLD_ROUTER_TEMPLATE_PATH = ROOT / "templates/971-real/(DEPRECATED)971 Metal Sheet.f3dhsm-template"
_LIBRARY_PATH = ROOT / "tools/Normal router tools (use this).tools"
_NS = {"x": "http://www.hsmworks.com/namespace/hsmworks/document/template"}

# Confirmed by direct inspection of the real, checked-in library: the only
# tool carrying NC number 6 that survives _drop_stale_duplicate_tool_numbers
# (a second, undescribed "for tool changer" entry also claims 6 but is the
# known-stale duplicate - see that function's own docstring).
_REAL_TOOL_6_GUID = "e7813c26-af06-4d6c-9aba-324fa1b402c1"  # "4mm sized for toolchager"
_LARGE_ENDMILL_GUID = "29331875-1efc-47c5-9742-f39efcb697ed"  # 6mm, 0.2362in, NOT Tool 6


def _release_cut_templates(root):
    return [
        t for t in root.findall("x:template", _NS)
        if template_tools._RELEASE_CUT_TEMPLATE_DESCRIPTION_RE.search(str(t.get("description") or ""))
    ]


class ReleaseCutForcedToTool6Tests(unittest.TestCase):
    def _patch(self, filter_guids, template_path=_NEW_ROUTER_TEMPLATE_PATH, library_json=None, multi_tool_mode=True):
        if library_json is None:
            with zipfile.ZipFile(_LIBRARY_PATH) as archive:
                library_json = archive.read("tools.json").decode("utf-8")
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            tool_json.write_text(library_json)
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

    def test_new_router_release_cut_gets_tool_6_even_when_filter_guids_excludes_it(self):
        # filter_guids only carries the large endmill the operator selected
        # for this part's own cutting - never Tool 6, exactly like a real
        # job's own tool selection.
        root = self._patch({_LARGE_ENDMILL_GUID})
        release_cuts = _release_cut_templates(root)
        self.assertEqual(len(release_cuts), 1)
        self.assertEqual(release_cuts[0].get("description"), "Slot Cut for Edges")
        self.assertEqual(release_cuts[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_6_GUID)

    def test_old_router_release_cut_also_gets_tool_6(self):
        root = self._patch({_LARGE_ENDMILL_GUID}, template_path=_OLD_ROUTER_TEMPLATE_PATH)
        release_cuts = _release_cut_templates(root)
        self.assertEqual(len(release_cuts), 1)
        self.assertEqual(release_cuts[0].get("description"), "2D Slot Cut")
        self.assertEqual(release_cuts[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_6_GUID)

    def test_release_cut_is_not_reassigned_by_the_generic_largest_endmill_pass(self):
        # The large endmill is a genuinely different, bigger tool than real
        # Tool 6 - if the release cut leaked into the generic multi-tool
        # assignment pass afterward, it would end up reassigned to this one
        # instead, silently overwriting the forced Tool 6 above it.
        root = self._patch({_LARGE_ENDMILL_GUID, _REAL_TOOL_6_GUID})
        release_cuts = _release_cut_templates(root)
        self.assertEqual(release_cuts[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_6_GUID)

    def test_raises_when_no_tool_6_exists_in_any_loaded_library(self):
        library_json = json.dumps({
            "version": 1,
            "data": [
                {
                    "description": "971 Main Bit",
                    "type": "flat end mill",
                    "guid": _LARGE_ENDMILL_GUID,
                    "post-process": {"number": 1},
                    "geometry": {"DC": 0.2362},
                },
            ],
        })
        with self.assertRaises(ValueError) as ctx:
            self._patch({_LARGE_ENDMILL_GUID}, library_json=library_json, multi_tool_mode=False)
        self.assertIn("Tool 6", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
