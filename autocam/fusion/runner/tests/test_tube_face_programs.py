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

    def test_bore_selection_uses_the_hole_wall_not_the_planar_tube_wall(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn("adsk.core.Cylinder.classType()", handler)
        self.assertIn('loop["circular_faces"]', handler)

    def test_tube_workflow_activates_manufacture_before_requesting_cam(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('workspaces.itemById("CAMEnvironment")', handler)
        self.assertIn("Fusion did not create a CAM product", handler)

    def test_tube_chain_selection_uses_the_parameter_value_api(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn("parameter.value.applyCurveSelections(selections)", handler)
        self.assertNotIn("parameter.applyCurveSelections(selections)", handler)
        self.assertIn("edges = list(loop.edges)", handler)

    def test_tube_waits_for_template_operations_before_rebinding_geometry(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        template_index = handler.index("setup.createFromCAMTemplate2(template)")
        bind_index = handler.index("_bind_setup_to_face(setup, body, face, tube_axis, horizontal)", template_index)
        configure_index = handler.index("_configure_face_operations(setup, face)", template_index)
        self.assertLess(template_index, configure_index)
        self.assertLess(template_index, bind_index)
        self.assertLess(bind_index, configure_index)
        self.assertIn("adsk.doEvents()", handler[template_index:configure_index])

    def test_tube_routes_all_circular_holes_through_bore_faces(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('"holeDiameterMaximum", "100 in"', handler)
        self.assertIn("_apply_circular_faces(operation, circular_faces)", handler)


if __name__ == "__main__":
    unittest.main()
