"""Real, confirmed live crash: the New Router's own real template
("new router metal sheet (shopsabre only!!).f3dhsm-template") ships its
dedicated small-hole operation as strategy="bore" ("<.3 Circluar Through
Hole", sic), not strategy="drill". patch_cam_template_with_tool_libraries's
multi-tool tool-assignment only ever looked for strategy="drill", so this
native bore op fell through to the generic exact-tool-signature match
against whatever tool the ORIGINAL captured template used - which is often
not even loaded in multi-tool mode, and produced a substitute tool too
large to physically fit inside this op's own small holes. Fusion's real,
live error: "3 : Tool doesn't fit" on the Bore-strategy toolpath.
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
_LIBRARY_PATH = ROOT / "tools/Normal router tools (use this).tools"
_NS = {"x": "http://www.hsmworks.com/namespace/hsmworks/document/template"}

_SMALL_ENDMILL_GUID = "e7813c26-af06-4d6c-9aba-324fa1b402c1"  # 4mm, 0.1575in
_LARGE_ENDMILL_GUID = "29331875-1efc-47c5-9742-f39efcb697ed"  # 6mm, 0.2362in


class NativeBoreToolAssignmentTests(unittest.TestCase):
    def _patch(self, filter_guids):
        with zipfile.ZipFile(_LIBRARY_PATH) as archive:
            parsed = json.loads(archive.read("tools.json"))
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            tool_json.write_text(json.dumps(parsed))
            output = Path(directory) / "patched.f3dhsm-template"
            template_tools.patch_cam_template_with_tool_libraries(
                str(_TEMPLATE_PATH),
                str(output),
                [str(tool_json)],
                material_name="Aluminum 6061",
                filter_guids=filter_guids,
                multi_tool_mode=True,
            )
            return ET.parse(output).getroot()

    def test_the_native_bore_op_gets_the_smallest_loaded_endmill_not_a_signature_match(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})
        templates = root.findall("x:template", _NS)
        bore_op = next(t for t in templates if t.get("strategy") == "bore")

        self.assertEqual(bore_op.find("x:tool", _NS).get("guid"), _SMALL_ENDMILL_GUID)

    def test_the_native_bore_ops_hole_range_matches_its_own_name_and_assigned_tool(self):
        root = self._patch({_SMALL_ENDMILL_GUID, _LARGE_ENDMILL_GUID})
        templates = root.findall("x:template", _NS)
        bore_op = next(t for t in templates if t.get("strategy") == "bore")
        params = {p.get("name"): p.get("expression") for p in bore_op.findall("x:parameter", _NS)}

        self.assertEqual(params["holeDiameterMinimum"], "0.1575in")
        self.assertEqual(params["holeDiameterMaximum"], "0.3in")

    def test_the_native_bore_op_still_gets_a_tool_with_only_one_endmill_loaded(self):
        root = self._patch({_LARGE_ENDMILL_GUID})
        templates = root.findall("x:template", _NS)
        bore_op = next(t for t in templates if t.get("strategy") == "bore")

        self.assertEqual(bore_op.find("x:tool", _NS).get("guid"), _LARGE_ENDMILL_GUID)


if __name__ == "__main__":
    unittest.main()
