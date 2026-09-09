"""Which template a plate job uses is decided by MACHINE only, never by
material - see _select_plate_template_path's own docstring for why the
material gate that used to exist here was a real bug, not a style choice.

camPlate.py imports Fusion's runtime-only adsk modules at import time, so
the function under test is loaded in isolation, the same way
test_feature_vs_shape.py isolates DeleteToolpaths.py's pure functions.
"""

from pathlib import Path
import os
import unittest


def _load():
    workflows_dir = Path(__file__).parents[1] / "workflows"
    source = (workflows_dir / "camPlate.py").read_text()
    start = source.index("def _select_plate_template_path")
    end = source.index("def _total_machining_time")
    # __file__ inside the compiled function must resolve os.path.dirname()
    # to the real workflows/ directory, the same as the un-sliced module -
    # otherwise os.path.isfile(candidate) checks below fail against a
    # nonexistent path and this test would pass or fail for the wrong reason.
    namespace = {"os": os, "Optional": None, "__file__": str(workflows_dir / "camPlate.py")}
    exec(compile(source[start:end], "camPlate_template_selection", "exec"), namespace)
    return namespace["_select_plate_template_path"]


select_plate_template_path = _load()

_TEMPLATES_DIR = Path(__file__).parents[1] / "templates"
_UNC_TEMPLATE = "(DEPRECATED)971 Metal Sheet.f3dhsm-template"
_NEW_ROUTER_TEMPLATE = "new router metal sheet (shopsabre only!!).f3dhsm-template"


class PlateTemplateSelectionTests(unittest.TestCase):
    def test_unc_router_gets_the_rich_template_regardless_of_material(self):
        # The real bug: this used to fall back to the generic template for
        # every material except aluminum/Lexan. SRPP, Acrylic, MDF, Baltic
        # Birch Plywood, Delrin and Nylon all have reviewed feed/speed
        # presets in the checked-in tool library (971-outside-plate.tools)
        # and must reach the same rich template aluminum already does.
        for material in (None, "", "Aluminum 6061", "SRPP", "Acrylic", "MDF",
                          "Baltic Birch Plywood", "Delrin (Acetal)", "Nylon", "Steel"):
            with self.subTest(material=material):
                path = select_plate_template_path("UNC Router")
                self.assertTrue(path.endswith(_UNC_TEMPLATE), path)

    def test_new_router_gets_its_own_rich_template(self):
        path = select_plate_template_path("New Router")
        self.assertTrue(path.endswith(_NEW_ROUTER_TEMPLATE), path)

    def test_unrecognized_machine_falls_back_to_the_generic_template(self):
        # Never guess which real router an unrecognized machine name means.
        for machine in (None, "", "Some Other Machine", "unc router 2"):
            with self.subTest(machine=machine):
                path = select_plate_template_path(machine)
                self.assertTrue(path.endswith("Plates.f3dhsm-template"), path)

    def test_machine_name_matching_is_case_insensitive(self):
        self.assertTrue(select_plate_template_path("UNC ROUTER").endswith(_UNC_TEMPLATE))
        self.assertTrue(select_plate_template_path("new router").endswith(_NEW_ROUTER_TEMPLATE))

    def test_every_reviewed_material_has_a_real_preset_in_the_tool_library(self):
        # Not a template-selection test on its own, but the fact this
        # function's fix depends on: removing the material gate is only
        # safe because every router material already has a reviewed preset
        # to fall through to (see camPlate.py's docstring). If a material
        # is ever added to cam_materials without a matching preset here,
        # _choose_preset in templateTools.py will raise rather than guess -
        # this test exists so that omission is caught before a real job
        # hits it live.
        import zipfile
        import json

        library = Path(__file__).parents[1] / "tools/971-outside-plate.tools"
        with zipfile.ZipFile(library) as archive:
            data = json.loads(archive.read("tools.json"))
        preset_names = set()
        for tool in data.get("data", []):
            for preset in tool.get("start-values", {}).get("presets", []):
                if preset.get("name"):
                    preset_names.add(preset["name"])

        for expected in (
            "Aluminum 6061", "Polycarbonate (Lexan)", "SRPP", "Acrylic",
            "MDF", "Baltic Birch Plywood", "Delrin (Acetal)", "Nylon",
        ):
            self.assertIn(expected, preset_names)

    def test_the_generic_template_still_exists_as_a_fallback(self):
        self.assertTrue((_TEMPLATES_DIR / "Plates.f3dhsm-template").is_file())

    def test_both_real_router_templates_exist(self):
        self.assertTrue((_TEMPLATES_DIR / "971-real" / _UNC_TEMPLATE).is_file())
        self.assertTrue((_TEMPLATES_DIR / "971-real" / _NEW_ROUTER_TEMPLATE).is_file())

    def test_successful_plate_jobs_close_their_document_after_completion(self):
        workflow = (Path(__file__).parents[1] / "workflows" / "camPlate.py").read_text()
        completion_index = workflow.index("ensure_completion_response(")
        close_index = workflow.index("doc.close(False)", completion_index)

        self.assertLess(completion_index, close_index)

    def test_plate_jobs_report_upload_location_and_completion_to_text_commands(self):
        workflow = (Path(__file__).parents[1] / "workflows" / "camPlate.py").read_text()
        self.assertIn('app.log(f"File uploaded to {data_project.name}/{folder_path}/{doc_name}")', workflow)
        self.assertIn('app.log("Job Completed")', workflow)


if __name__ == "__main__":
    unittest.main()
