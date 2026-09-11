from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET


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

    def test_long_job_names_keep_a_unique_face_suffix_inside_fusions_limit(self):
        long_name = "Tube" + "a" * 36 + "Job" + "b" * 36
        names = [tube_face_program_name(long_name, clock) for clock in TUBE_FACE_CLOCKS]

        self.assertEqual(
            names,
            [
                long_name[:32] + "-side-12",
                long_name[:33] + "-side-3",
                long_name[:33] + "-side-6",
                long_name[:33] + "-side-9",
            ],
        )
        self.assertEqual(len(set(names)), 4)
        self.assertTrue(all(len(name) <= 40 for name in names))

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
        bind_index = handler.index("_bind_setup_to_face(setup, body, face, tube_axis)", template_index)
        configure_index = handler.index("_configure_face_operations(setup, selection_face, wall_thickness_in, cutoff_chain)", template_index)
        self.assertLess(template_index, configure_index)
        self.assertLess(template_index, bind_index)
        self.assertLess(bind_index, configure_index)
        self.assertIn("adsk.doEvents()", handler[template_index:configure_index])

    def test_tube_routes_all_circular_holes_through_bore_faces(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('"holeDiameterMaximum", "100 in"', handler)
        self.assertIn('circular_loops = [loop for loop in loops if loop["circular"] and loop["circular_faces"]]', handler)
        self.assertIn("_apply_circular_faces(operation, representative_hole_faces)", handler)

    def test_tube_bore_gets_one_representative_hole_per_distinct_diameter(self):
        # Confirmed live: the reviewed Bore's selectSameDiameter only extends
        # a selection to holes of the same diameter. One representative for a
        # 2in wall with 0.196in and 0.375in holes machined 3 of 55 holes.
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertNotIn('circular_loops[0]["circular_faces"]', handler)
        self.assertIn('"diameter": adsk.core.Circle3D.cast(edges[0].geometry).radius * 2 if circular else None', handler)
        self.assertIn('if any(abs(loop["diameter"] - seen) <= _HOLE_DIAMETER_TOLERANCE_CM for seen in seen_diameters):', handler)
        self.assertIn('representative_hole_faces.extend(loop["circular_faces"])', handler)

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
        self.assertIn("_configure_face_operations(setup, selection_face, wall_thickness_in, cutoff_chain)", handler)
        self.assertIn("loops = _loop_specs(selection_face)", handler)

    def test_tube_adaptive_operations_cap_other_way_feedrate_after_material_scaling(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn("def _cap_other_way_feedrate(setup):", handler)
        self.assertIn("otherWayFeedrate", handler)
        self.assertIn('other.expression = "tool_feedCutting"', handler)
        self.assertIn('both_ways.expression = "false"', handler)
        self.assertIn("_cap_other_way_feedrate(setup)", handler)

    def test_shape_through_templates_are_one_way_with_a_safe_fallback_feed(self):
        template = ET.parse(
            RUNNER_DIR / "templates" / "971-real" / "Tubestock(with Cutter Comp).f3dhsm-template"
        )
        shape_templates = [
            item for item in template.iter()
            if item.tag.endswith("template")
            and item.get("description") in {"Shape Through Hole", "Small Shape Through Hole"}
        ]
        self.assertEqual(len(shape_templates), 2)
        for operation in shape_templates:
            parameters = {
                item.get("name"): item.get("expression")
                for item in operation
                if item.tag.endswith("parameter")
            }
            self.assertEqual(parameters["bothWays"], "false")
            self.assertEqual(parameters["otherWayFeedrate"], "tool_feedCutting")

    def test_tube_closed_non_circular_features_use_shape_through_not_slot_cut(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('shapes = [loop for loop in loops if not loop["circular"]]', handler)
        self.assertIn('elif "slot" in name and operation.strategy == "contour2d":\n            keep = False', handler)
        self.assertNotIn("_SLOT_ASPECT_RATIO", handler)

    def test_tube_operations_reference_stock_under_the_active_face(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('"topHeight_mode", "\'from stock top\'"', handler)
        self.assertIn("_set_face_stock_heights(operation, wall_thickness_in, clearance_in)", handler)

    def test_tube_bottom_depth_never_reaches_the_far_wall_of_a_hollow_tube(self):
        # Direct bug report: a hole/shape cutout was cutting all the way
        # through the hollow tube into the far wall instead of stopping at
        # the near wall's own inner surface. "from stock bottom" on a
        # RelativeBoxStock (the tube's whole bounding box, hollow middle
        # included) IS the far wall - it must never be hardcoded as every
        # operation's blanket bottom depth again.
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertNotIn('"bottomHeight_mode", "\'from stock bottom\'"', handler)
        self.assertRegex(handler, r"from \.TubeHeightMath import \([^)]*\bbottom_height_expression\b")
        self.assertIn("bottom_mode, bottom_offset = bottom_height_expression(wall_thickness_in, clearance_in)", handler)

    def test_tube_cutoff_is_bound_on_every_side_not_deleted(self):
        # Direct bug report: every tube template ships a Tube Cutoff, but the
        # Runner deleted it on every side, so the part never came off its
        # stock. It is bound to the far end-cap edge instead.
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertNotIn("operations.append(operation)", handler)
        self.assertIn("cutoff_chain = _far_end_cutoff_chain(body, face, tube_axis)", handler)
        self.assertIn('if not _apply_open_chain(operation, "contours", *cutoff_chain):', handler)
        cutoff_index = handler.index('if "tube cutoff" in name:')
        shape_index = handler.index('elif "shape" in name')
        self.assertLess(cutoff_index, shape_index)

    def test_tube_cutoff_chain_matches_the_reviewed_manual_setup(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        # Confirmed live: the seed must be one edge assigned before isOpen, or
        # Fusion silently closes the chain around the whole face outline.
        chain = handler[handler.index("def _apply_open_chain"):handler.index("def _configure_face_operations")]
        self.assertIn("selection.inputGeometry = [edge]", chain)
        self.assertLess(chain.index("selection.inputGeometry = [edge]"), chain.index("selection.isOpen = True"))
        # Confirmed live: a fixed isReverted put the tool inside the part on
        # two of four sides. The reversal must follow the far end cap's
        # co-edge, never a constant.
        self.assertIn("selection.isReverted = is_reverted", chain)
        self.assertNotIn("selection.isReverted = False", handler)
        self.assertIn("is_reverted_for_loop_seed(_coedge_opposed(cap, edge))", handler)
        self.assertIn("clearance_in = CUTOFF_BREAKTHROUGH_CLEARANCE_IN", handler)

    def test_tube_cutoff_stops_short_of_both_edge_ends_like_the_reviewed_setup(self):
        # The reviewed manual setup's cutoff chains all carry a -4.064mm
        # (0.16in) start and end extension, posting Y-0.16..-0.84 on a 1in
        # face. Without it the cutoff ran the full edge, corner to corner.
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn("_CUTOFF_END_PULLBACK_MM = 0.16 * 25.4", handler)
        chain = handler[handler.index("def _apply_open_chain"):handler.index("def _configure_face_operations")]
        self.assertIn("selection.startExtensionLength = -_CUTOFF_END_PULLBACK_MM", chain)
        self.assertIn("selection.endExtensionLength = -_CUTOFF_END_PULLBACK_MM", chain)

    def test_tube_setups_post_on_g55(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertIn('_TUBE_WORK_OFFSET = "2"', handler)
        self.assertIn('parameters.itemByName("job_workOffset").expression = _TUBE_WORK_OFFSET', handler)

    def test_tube_wcs_origin_is_resolved_from_fusion_not_a_hardcoded_corner(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        self.assertNotIn('value.value = "top 1"', handler)
        self.assertIn("tube_wcs_axes(_vec(_face_normal(face)), _vec(tube_axis))", handler)
        self.assertIn("box_point.value = pick_origin_corner(origins, want_x, want_y)", handler)

    def test_tube_wcs_origin_is_always_the_right_hand_corner(self):
        # Direct operator correction: a job queued "vertical" put X across the
        # tube and the origin on the face's left-hand corner. The reviewed
        # setup is X along the tube, origin on the right-hand corner, so the
        # queue's orientation choice no longer reaches the tube WCS at all.
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn('def handleTube(template_filename, program_base_name="tube"):', handler)
        self.assertNotIn("horizontal", handler)
        self.assertNotIn('_get(payload, "orientation")', workflow)
        self.assertIn("return long_edge, transverse_edge", handler)

    def test_tube_wcs_rule_never_reaches_plate_setups(self):
        # Direct instruction: the tube WCS rewrite is for tube stock only.
        # Only the tube workflow may import HandleTube, and only HandleTube
        # may import TubeWcsMath.
        importers = {"HandleTube": {"camTube.py"}, "TubeWcsMath": {"HandleTube.py"}}
        for folder in ("commands", "workflows"):
            for path in (RUNNER_DIR / folder).glob("*.py"):
                text = path.read_text()
                for module, allowed in importers.items():
                    if path.name in allowed:
                        continue
                    with self.subTest(file=path.name, module=module):
                        self.assertNotRegex(text, r"(?m)^\s*from \.+(commands\.)?{} import".format(module))

    def test_tube_keeps_four_setups_but_posts_only_active_faces(self):
        handler = (RUNNER_DIR / "commands" / "HandleTube.py").read_text()
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn("if len(names) != 4 or cam.setups.count != 4:", handler)
        self.assertNotIn("produced no operations for Side", handler)
        self.assertIn("posted_program_names = export(", workflow)
        self.assertIn("len(nc_files) != len(posted_program_names)", workflow)

    def test_tube_save_honors_the_shared_queue_filename_and_folder(self):
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn('custom_name = _get(payload, "fusion_file_name")', workflow)
        self.assertIn('folder_path = _get(payload, "fusion_folder_path") or FUSION_DROP_FOLDER_PATH', workflow)
        self.assertIn('app, FUSION_DATA_PROJECT_NAME, folder_path', workflow)

    def test_tube_checks_generated_operations_before_export(self):
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn("failed = failed_operations(cam)", workflow)
        self.assertIn("job_warnings = operation_warnings(app, cam)", workflow)

    def test_tube_toolpath_generation_uses_its_future(self):
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn("future = cam.generateAllToolpaths(True)", workflow)
        self.assertIn("while not future.isGenerationCompleted:", workflow)
        self.assertNotIn("cam.isGenerating", workflow)

    def test_tube_jobs_leave_their_document_open_for_the_slow_cloud_upload(self):
        # Real, confirmed live bug: tube-stock cloud uploads are slow enough
        # that closing the document right after saveAs()/completion left the
        # file missing or stale in the Data Panel folder for a while. Unlike
        # camPlate.py (whose fast uploads are safe to close immediately),
        # tube jobs deliberately never call doc.close() at all.
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertNotIn("doc.close(", workflow)

    def test_tube_jobs_report_upload_location_and_completion_to_text_commands(self):
        workflow = (RUNNER_DIR / "workflows" / "camTube.py").read_text()
        self.assertIn('app.log(f"File uploaded to {data_project.name}/{folder_path}/{doc_name}")', workflow)
        self.assertIn('app.log("Job Completed")', workflow)


if __name__ == "__main__":
    unittest.main()
