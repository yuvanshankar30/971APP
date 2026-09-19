"""A job now posts ONE program per setup instead of one per operation, so
its single filename comes straight from the job/plate name - which is free
text a user typed. These cover reducing that to something every post
processor and filesystem in this pipeline can take.

NewNCProgram.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded in isolation.
"""

import re
from pathlib import Path
import unittest


def _load_safe_program_name():
    source = (Path(__file__).parents[1] / "commands/NewNCProgram.py").read_text()
    start = source.index("def _safe_program_name")
    end = source.index("def _post_process_with_retry")
    namespace = {"re": re}
    exec(compile(source[start:end], "NewNCProgram_safe_name", "exec"), namespace)
    return namespace["_safe_program_name"], namespace["autocam_program_name"]


safe_program_name, autocam_program_name = _load_safe_program_name()


class SafeProgramNameTests(unittest.TestCase):
    def test_strips_spaces_from_a_real_plate_name(self):
        self.assertEqual(safe_program_name("dihRetry Test Plate"), "dihRetryTestPlate")
        self.assertEqual(safe_program_name("x44 stiffner"), "x44stiffner")

    def test_removes_path_separators_and_punctuation(self):
        # A slash would redirect the post to a different directory, and a
        # colon is not a legal filename character everywhere this runs.
        self.assertEqual(safe_program_name("a/b\\c:d"), "abcd")
        self.assertEqual(safe_program_name("Plate #3 (v2)"), "Plate3v2")

    def test_falls_back_rather_than_producing_an_empty_filename(self):
        for empty in ("", "   ", "....", None):
            self.assertEqual(safe_program_name(empty), "Program")

    def test_caps_length_so_a_pasted_name_cannot_break_the_post(self):
        self.assertEqual(len(safe_program_name("x" * 200)), 60)

    def test_keeps_dashes_and_underscores(self):
        self.assertEqual(safe_program_name("plate_1-final"), "plate_1-final")


class AutocamProgramNameTests(unittest.TestCase):
    def test_is_the_fusion_file_name_plus_autocam(self):
        self.assertEqual(autocam_program_name("pivot gearbox plate 2"), "pivotgearboxplate2AUTOCAM")

    def test_does_not_double_the_suffix(self):
        self.assertEqual(autocam_program_name("pivotgearboxplate2AUTOCAM"), "pivotgearboxplate2AUTOCAM")
        self.assertEqual(autocam_program_name("MainPlate2autocam"), "MainPlate2autocam")

    def test_long_names_keep_the_suffix(self):
        result = autocam_program_name("x" * 200)
        self.assertEqual(len(result), 60)
        self.assertTrue(result.endswith("AUTOCAM"))

    def test_never_returns_an_internal_id_shape(self):
        self.assertEqual(autocam_program_name(""), "ProgramAUTOCAM")


class PlateExportUsesTheFusionFileName(unittest.TestCase):
    def test_plate_export_passes_a_readable_program_base_name(self):
        source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
        self.assertIn("program_base_name=program_base_name", source)
        self.assertNotIn("export(plate_id, machine_post_processor_path)", source)


if __name__ == "__main__":
    unittest.main()
