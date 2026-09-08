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
        configure_index = handler.index("_configure_face_operations(setup, selection_face, wall_thickness_in)", template_index)
        self.assertLess(template_index, configure_index)
        self.assertLess(template_index, bind_index)
        self.assertLess(bind_index, configure_index)
        self.assertIn("adsk.doEvents()", handler[template_index:configure_index])

    def test_tube_routes_all_circular_holes_through_bore_faces(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('"holeDiameterMaximum", "100 in"', handler)
        self.assertIn("_apply_circular_faces(operation, circular_faces)", handler)

    def test_tube_wcs_uses_the_topological_face_normal(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn("if face.isParamReversed:", handler)
        self.assertIn("normal.scaleBy(-1)", handler)

    def test_tube_shape_chains_use_one_topology_seed_edge(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('selection.inputGeometry = [spec["edges"][0]]', handler)
        self.assertIn("apply_single(spec, spec[\"is_reverted\"])", handler)
        self.assertIn("apply_single(spec, not spec[\"is_reverted\"])", handler)
        self.assertIn("for spec, reverted in zip(specs, resolved):", handler)

    def test_tube_shape_chains_use_the_paired_bottom_wall_not_the_exterior_wcs_face(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn("selection_face_by_exterior", handler)
        self.assertIn("_configure_face_operations(setup, selection_face, wall_thickness_in)", handler)
        self.assertIn("loops = _loop_specs(selection_face)", handler)

    def test_tube_adaptive_operations_cap_other_way_feedrate_after_material_scaling(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn("def _cap_other_way_feedrate(setup):", handler)
        self.assertIn("otherWayFeedrate", handler)
        self.assertIn('other.expression = "tool_feedCutting"', handler)
        self.assertIn("_cap_other_way_feedrate(setup)", handler)

    def test_tube_closed_non_circular_features_use_shape_through_not_slot_cut(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('shapes = [loop for loop in loops if not loop["circular"]]', handler)
        self.assertIn('elif "slot" in name and operation.strategy == "contour2d":\n            keep = False', handler)
        self.assertNotIn("_SLOT_ASPECT_RATIO", handler)

    def test_tube_operations_reference_stock_under_the_active_face(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('"topHeight_mode", "\'from stock top\'"', handler)
        self.assertIn("_set_face_stock_heights(operation, wall_thickness_in)", handler)

    def test_tube_bottom_depth_never_reaches_the_far_wall_of_a_hollow_tube(self):
        # Direct bug report: a hole/shape cutout was cutting all the way
        # through the hollow tube into the far wall instead of stopping at
        # the near wall's own inner surface. "from stock bottom" on a
        # RelativeBoxStock (the tube's whole bounding box, hollow middle
        # included) IS the far wall - it must never be hardcoded as every
        # operation's blanket bottom depth again.
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertNotIn('"bottomHeight_mode", "\'from stock bottom\'"', handler)
        self.assertIn("from .TubeHeightMath import bottom_height_expression", handler)
        self.assertIn("bottom_mode, bottom_offset = bottom_height_expression(wall_thickness_in)", handler)

    def test_tube_cutoff_is_not_inherited_without_explicit_cutoff_data(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        cutoff_index = handler.index('if "tube cutoff" in str(operation.name or "").lower():')
        shape_index = handler.index('elif "shape" in name')
        self.assertLess(cutoff_index, shape_index)

    def test_tube_keeps_four_setups_but_posts_only_active_faces(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn("if len(names) != 4 or cam.setups.count != 4:", handler)
        self.assertNotIn("produced no operations for Side", handler)
        self.assertIn("posted_program_names = export(", workflow)
        self.assertIn("len(nc_files) != len(posted_program_names)", workflow)

    def test_tube_checks_generated_operations_before_export(self):
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn("failed = failed_operations(cam)", workflow)
        self.assertIn("job_warnings = operation_warnings(app, cam)", workflow)

    def test_tube_toolpath_generation_uses_its_future(self):
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn("future = cam.generateAllToolpaths(True)", workflow)
        self.assertIn("while not future.isGenerationCompleted:", workflow)
        self.assertNotIn("cam.isGenerating", workflow)


if __name__ == "__main__":
    unittest.main()
