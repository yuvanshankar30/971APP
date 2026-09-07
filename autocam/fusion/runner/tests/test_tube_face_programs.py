from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.TubeFacePrograms import (  # noqa: E402
    TUBE_FACE_CLOCKS,
    tube_face_label,
    tube_face_program_name,
    tube_face_setup_name,
)


class TubeFaceProgramTests(unittest.TestCase):
    def test_rectangular_tube_has_four_distinct_operator_faces(self):
        self.assertEqual(TUBE_FACE_CLOCKS, (12, 3, 6, 9))
        self.assertEqual(
            [tube_face_setup_name(clock) for clock in TUBE_FACE_CLOCKS],
            ["Tube Side 12", "Tube Side 3", "Tube Side 6", "Tube Side 9"],
        )

    def test_each_face_gets_a_stable_program_name(self):
        self.assertEqual(
            [tube_face_program_name("Tube42", clock) for clock in TUBE_FACE_CLOCKS],
            ["Tube42-side-12", "Tube42-side-3", "Tube42-side-6", "Tube42-side-9"],
        )

    def test_unknown_face_is_rejected(self):
        with self.assertRaises(ValueError):
            tube_face_label(1)

    def test_workflow_uses_reviewed_tube_template_and_four_explicit_programs(self):
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn("Tubestock(with Cutter Comp).f3dhsm-template", workflow)
        self.assertIn("face_program_names", workflow)
        self.assertNotIn("DeleteToolpaths()", workflow)


if __name__ == "__main__":
    unittest.main()
