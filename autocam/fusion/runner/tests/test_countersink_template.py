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


class CountersinkTemplateTests(unittest.TestCase):
    def test_multi_tool_mode_keeps_one_drill_operation(self):
        library = ROOT / "tools/Normal router tools (use this).tools"
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            with zipfile.ZipFile(library) as archive:
                parsed = json.loads(archive.read("tools.json"))
            drill = next(tool for tool in parsed["data"] if tool.get("type") == "drill")
            for preset in (drill.get("start-values") or {}).get("presets") or []:
                preset["v_f_ramp"] = min(float(preset.get("v_f_ramp") or 0), 5.0)
                preset["v_f_plunge"] = min(float(preset.get("v_f_plunge") or 0), 5.0)
            second_drill = json.loads(json.dumps(drill))
            second_drill["guid"] = "multi-tool-drill-candidate"
            parsed["data"].append(second_drill)
            tool_json.write_text(json.dumps(parsed))
            output = Path(directory) / "patched.f3dhsm-template"

            original_preset_guard = template_tools._conservative_router_preset
            template_tools._conservative_router_preset = lambda preset: preset
            try:
                template_tools.patch_cam_template_with_tool_libraries(
                    str(ROOT / "templates/Plates.f3dhsm-template"), str(output), [str(tool_json)],
                    material_name="Aluminum 6061", multi_tool_mode=True
                )
            finally:
                template_tools._conservative_router_preset = original_preset_guard

            ns = {"x": "http://www.hsmworks.com/namespace/hsmworks/document/template"}
            drills = [
                template for template in ET.parse(output).getroot().findall("x:template", ns)
                if template.get("strategy") == "drill"
            ]
            self.assertEqual(len(drills), 1)

    def test_inserts_the_requested_countersink_before_the_release_contour(self):
        guid = "61a8645a-9015-4aba-958b-70297d26b19e"
        library = ROOT / "tools/Normal router tools (use this).tools"
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            with zipfile.ZipFile(library) as archive:
                parsed = json.loads(archive.read("tools.json"))
            parsed["data"] = [
                tool for tool in parsed["data"]
                if tool.get("guid") == guid or tool.get("post-process", {}).get("number") == 1
            ]
            tool_json.write_text(json.dumps(parsed))
            output = Path(directory) / "patched.f3dhsm-template"
            info = template_tools.patch_cam_template_with_tool_libraries(
                str(ROOT / "templates/Plates.f3dhsm-template"), str(output), [str(tool_json)],
                material_name="Aluminum 6061", countersink_guid=guid
            )
            self.assertEqual(info["countersink"]["guid"], guid)
            root = ET.parse(output).getroot()
            ns = {"x": "http://www.hsmworks.com/namespace/hsmworks/document/template"}
            templates = root.findall("x:template", ns)
            descriptions = [template.get("description") for template in templates]
            index = next(i for i, description in enumerate(descriptions) if description.startswith("Countersink"))
            release = next(i for i, template in enumerate(templates) if template.get("strategy") == "contour2d" and template.get("description") != "Suppress")
            self.assertLess(index, release)
            countersink = templates[index]
            params = {parameter.get("name"): parameter.get("expression") for parameter in countersink.findall("x:parameter", ns)}
            self.assertEqual(params["holeMode"], "'diameter'")
            self.assertEqual(params["holeFaces"], "false")
            self.assertEqual(params["holeDiameterMinimum"], "0.2in")
            self.assertEqual(params["holeDiameterMaximum"], "0.4in")
            self.assertEqual(countersink.find("x:tool", ns).get("guid"), guid)


if __name__ == "__main__":
    unittest.main()
