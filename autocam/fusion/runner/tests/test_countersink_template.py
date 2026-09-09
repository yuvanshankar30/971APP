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


class TemplateToolPlanningTests(unittest.TestCase):
    def test_multi_tool_mode_excludes_detail_cutter_without_a_material_preset(self):
        library = ROOT / "tools/Normal router tools (use this).tools"
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            with zipfile.ZipFile(library) as archive:
                parsed = json.loads(archive.read("tools.json"))
            large = next(tool for tool in parsed["data"] if tool.get("guid") == "29331875-1efc-47c5-9742-f39efcb697ed")
            large["start-values"]["presets"][0]["name"] = "SRPP"
            tool_json.write_text(json.dumps(parsed))
            output = Path(directory) / "patched.f3dhsm-template"

            original_preset_guard = template_tools._conservative_router_preset
            template_tools._conservative_router_preset = lambda preset: preset
            try:
                result = template_tools.patch_cam_template_with_tool_libraries(
                    str(ROOT / "templates/971-real/new router metal sheet (shopsabre only!!).f3dhsm-template"),
                    str(output),
                    [str(tool_json)],
                    material_name="SRPP",
                    filter_guids={"e7813c26-af06-4d6c-9aba-324fa1b402c1", large["guid"]},
                    multi_tool_mode=True,
                )
            finally:
                template_tools._conservative_router_preset = original_preset_guard

        self.assertEqual(result["tool_plan"]["endmill_guids"], [large["guid"]])
        self.assertIn("e7813c26-af06-4d6c-9aba-324fa1b402c1", result["tool_plan"]["skipped_guids"])

    def test_multi_tool_mode_fails_clearly_when_no_endmill_has_a_material_preset(self):
        library = ROOT / "tools/Normal router tools (use this).tools"
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            with zipfile.ZipFile(library) as archive:
                tool_json.write_bytes(archive.read("tools.json"))

            with self.assertRaisesRegex(ValueError, "No loaded multi-tool endmill has a reviewed"):
                template_tools.patch_cam_template_with_tool_libraries(
                    str(ROOT / "templates/971-real/new router metal sheet (shopsabre only!!).f3dhsm-template"),
                    str(Path(directory) / "patched.f3dhsm-template"),
                    [str(tool_json)],
                    material_name="SRPP",
                    filter_guids={"e7813c26-af06-4d6c-9aba-324fa1b402c1", "29331875-1efc-47c5-9742-f39efcb697ed"},
                    multi_tool_mode=True,
                )

    def test_non_6061_material_limits_reviewed_multi_tool_selection_to_one_cutter(self):
        library = ROOT / "tools/Normal router tools (use this).tools"
        small_guid = "e7813c26-af06-4d6c-9aba-324fa1b402c1"
        large_guid = "29331875-1efc-47c5-9742-f39efcb697ed"
        with tempfile.TemporaryDirectory() as directory:
            tool_json = Path(directory) / "tools.json"
            with zipfile.ZipFile(library) as archive:
                parsed = json.loads(archive.read("tools.json"))
            for tool in parsed["data"]:
                if tool.get("guid") in {small_guid, large_guid}:
                    tool["start-values"]["presets"][0]["name"] = "SRPP"
            tool_json.write_text(json.dumps(parsed))

            original_preset_guard = template_tools._conservative_router_preset
            template_tools._conservative_router_preset = lambda preset: preset
            try:
                result = template_tools.patch_cam_template_with_tool_libraries(
                    str(ROOT / "templates/971-real/new router metal sheet (shopsabre only!!).f3dhsm-template"),
                    str(Path(directory) / "patched.f3dhsm-template"),
                    [str(tool_json)],
                    material_name="SRPP",
                    filter_guids={small_guid, large_guid},
                    multi_tool_mode=True,
                )
            finally:
                template_tools._conservative_router_preset = original_preset_guard

        self.assertEqual(result["tool_plan"]["endmill_guids"], [small_guid])
        self.assertIn(large_guid, result["tool_plan"]["skipped_guids"])
        self.assertIn("limited to Aluminum 6061", result["tool_plan"]["reason"])

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


if __name__ == "__main__":
    unittest.main()
