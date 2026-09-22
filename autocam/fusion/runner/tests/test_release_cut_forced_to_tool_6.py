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
_REAL_TOOL_1_GUID = "10a2caeb-dec0-49b2-8701-96fdb212bad9"  # "971 Main Bit"


def _release_cut_templates(root):
    return [
        t for t in root.findall("x:template", _NS)
        if template_tools._RELEASE_CUT_TEMPLATE_DESCRIPTION_RE.search(str(t.get("description") or ""))
    ]


class ReleaseCutForcedToTool6Tests(unittest.TestCase):
    def _patch(self, filter_guids, template_path=_NEW_ROUTER_TEMPLATE_PATH, library_json=None, multi_tool_mode=True, single_tool_number=None):
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
                single_tool_number=single_tool_number,
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

    # Direct instruction: in single-tool mode, the release/slot cut should
    # match the job's one selected tool when that tool is Tool 1 or Tool 6,
    # otherwise it falls back to Tool 1.

    def test_single_tool_mode_release_cut_matches_tool_1_when_that_is_the_selected_tool(self):
        root = self._patch({_REAL_TOOL_1_GUID}, multi_tool_mode=False, single_tool_number=1)
        release_cuts = _release_cut_templates(root)
        self.assertEqual(release_cuts[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_1_GUID)

    def test_single_tool_mode_release_cut_matches_tool_6_when_that_is_the_selected_tool(self):
        root = self._patch({_REAL_TOOL_6_GUID}, multi_tool_mode=False, single_tool_number=6)
        release_cuts = _release_cut_templates(root)
        self.assertEqual(release_cuts[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_6_GUID)

    def test_single_tool_mode_release_cut_falls_back_to_tool_1_when_selected_tool_is_neither(self):
        # The selected tool is the large endmill (an ordinary cutting tool,
        # not NC number 1 or 6) - the release cut must fall back to Tool 1,
        # not stay on the large endmill and not require Tool 6.
        root = self._patch({_LARGE_ENDMILL_GUID}, multi_tool_mode=False, single_tool_number=2)
        release_cuts = _release_cut_templates(root)
        self.assertEqual(release_cuts[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_1_GUID)

    def test_multi_tool_mode_ignores_single_tool_number_and_still_requires_tool_6(self):
        # multi_tool_mode=True must win even if a caller also passed a
        # single_tool_number (defensive - camPlate.py never does this, but
        # the function's own contract should not depend on that).
        root = self._patch({_LARGE_ENDMILL_GUID, _REAL_TOOL_6_GUID}, multi_tool_mode=True, single_tool_number=1)
        release_cuts = _release_cut_templates(root)
        self.assertEqual(release_cuts[0].find("x:tool", _NS).get("guid"), _REAL_TOOL_6_GUID)

    def test_raises_when_no_tool_1_or_6_exists_in_single_tool_mode_with_no_explicit_selection(self):
        # No single_tool_number passed (defaults to None, same as a job
        # with no joined cam_tools row) - resolve_required_release_cut_tool_
        # number falls back to requiring Tool 1. Neither Tool 1 nor Tool 6
        # exist in this library (only Tool 3), so it must still raise.
        library_json = json.dumps({
            "version": 1,
            "data": [
                {
                    "description": "971 Main Bit",
                    "type": "flat end mill",
                    "guid": _LARGE_ENDMILL_GUID,
                    "post-process": {"number": 3},
                    "geometry": {"DC": 0.2362},
                },
            ],
        })
        with self.assertRaises(ValueError) as ctx:
            self._patch({_LARGE_ENDMILL_GUID}, library_json=library_json, multi_tool_mode=False)
        self.assertIn("Tool 1", str(ctx.exception))

    def test_raises_when_no_tool_6_exists_in_any_loaded_library_in_multi_tool_mode(self):
        # Multi-tool mode keeps the original fixed-machine-constant rule
        # (Tool 6 only) unconditionally - see
        # resolve_required_release_cut_tool_number's own comment. A real
        # preset is required here (unlike the single-tool-mode fixture
        # above) since multi-tool mode's own reviewed-preset filtering
        # would otherwise reject this fixture's only tool before the
        # release-cut lookup is ever reached, masking the thing under test.
        library_json = json.dumps({
            "version": 1,
            "data": [
                {
                    "description": "971 Main Bit",
                    "type": "flat end mill",
                    "guid": _LARGE_ENDMILL_GUID,
                    "post-process": {"number": 1},
                    "geometry": {"DC": 0.2362},
                    "start-values": {
                        "presets": [{"name": "Default preset", "spindleSpeed": 12000, "cuttingFeedrate": 40}]
                    },
                },
            ],
        })
        with self.assertRaises(ValueError) as ctx:
            self._patch({_LARGE_ENDMILL_GUID}, library_json=library_json, multi_tool_mode=True)
        self.assertIn("Tool 6", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
