from pathlib import Path
import unittest


RUNNER_DIR = Path(__file__).parents[1]


class HandleHexShaftSourceTests(unittest.TestCase):
    """HandleHexShaft.py imports adsk.* at module load, so it can only run
    inside Fusion (same reasoning as HandleTube.py/HandleSpacer.py's own
    tests) - these check the source directly for the rules confirmed live,
    per test_tube_face_programs.py's established pattern for this repo.
    """

    def setUp(self):
        self.source = (RUNNER_DIR / "commands" / "HandleHexShaft.py").read_text()

    def test_origin_point_is_the_cylindrical_centerline_not_the_surface_edge(self):
        # Confirmed live as a real bug: the longest straight edge sits on the
        # hex's own surface (one flat's edge), offsetting every axial
        # measurement by the hex's own apothem. A cylindrical face's own
        # mathematical axis passes through the true centerline instead.
        self.assertIn("origin_point = _centerline_point(body, axis_unit)", self.source)
        self.assertNotIn("origin_point = _vec(line.startPoint)", self.source)

    def test_neck_diameter_is_never_independently_measured(self):
        # A continuous circular groove cannot be cut into an interrupted hex
        # cross section - the neck-turn diameter is always exactly the hex's
        # own inscribed-circle diameter, fixed by across_flats alone.
        self.assertIn("neck_radius_cm(across_flats_cm)", self.source)

    def test_stock_is_a_synthetic_solid_not_the_documents_own_stock_body(self):
        # Confirmed live: the reference document's own "Stock" body doesn't
        # spatially overlap "Model" - fresh stock bodies are built here
        # instead, around whichever body is actually imported for a real job.
        self.assertIn("first_stock = _build_hex_stock(", self.source)
        self.assertIn('parameters.itemByName("job_stockMode").value.value = "solid"', self.source)

    def test_a_groove_at_each_end_makes_two_setups_not_one(self):
        # Confirmed live against a real hex shaft: a model grooved at both
        # ends needs two setups, since a lathe can only face/neck/groove the
        # end it's currently exposing - the operator re-chucks for the other.
        self.assertIn("groove_count = len(_groove_instances(body, origin_point, axis_unit, across_flats_cm))", self.source)
        self.assertIn("two_ended = groove_count == 2", self.source)
        self.assertIn("axis_unit_rev = tuple(-c for c in axis_unit)", self.source)

    def test_first_setup_parts_off_the_finished_blank_at_its_own_measured_length(self):
        # Confirmed live: "the big chunk" of chuck-grip stock left over after
        # facing/necking/grooving the first end has to be severed by a real
        # cutoff cut, not just left attached - turning_part positioned at the
        # model's own measured length from that end's own tip does this.
        self.assertIn('sever_length_cm=model_length_cm if two_ended else None', self.source)
        self.assertIn('setup.operations.add(_input_with_tool(setup, "turning_part", groove_tool))', self.source)
        self.assertIn('part_op.parameters.itemByName("backHeight_offset").expression', self.source)

    def test_second_setup_stock_has_no_extra_grip_allowance(self):
        # After the first setup's own Part operation severs the blank at
        # exactly its measured length, there is nothing left beyond the
        # model itself to grip - unlike the first setup's stock, which
        # extends past the model by _CHUCK_GRIP_ALLOWANCE_IN for the chuck.
        second_stock_call = self.source.index("second_stock = _build_hex_stock(")
        second_stock_args = self.source[second_stock_call:self.source.index(")", second_stock_call) + 1]
        self.assertNotIn("grip_cm", second_stock_args)
        self.assertIn("axial_min_rev, axial_max_rev", second_stock_args)

    def test_stock_is_a_real_hex_prism_not_a_round_envelope(self):
        # Confirmed live: a fresh ConstructionPlanes.add(setByPlane(...))
        # fails with "Environment is not supported" in a new design document,
        # but sketching on an *existing* plane (even one of Fusion's own
        # default origin planes) does not - so the hex cross section is
        # sketched there and extruded/moved into place, rather than
        # approximated as a round cylinder at the circumscribed diameter.
        self.assertIn("sketch = root.sketches.add(root.xZConstructionPlane)", self.source)
        self.assertIn("sketch.sketchCurves.sketchLines", self.source)
        self.assertNotIn("createCylinderOrCone", self.source)

    def test_stock_flats_are_aligned_to_the_real_bodys_own_flats(self):
        # The move that places the extruded prism uses the real body's own
        # flat_normal to build its target_x - an arbitrary rotation about
        # the axis would still pass every numeric check but wouldn't visually
        # or physically match a real hex bar's own corner/flat orientation.
        self.assertIn("flat_normal = _vec(_hex_flats(body, axis_unit)[0].geometry.normal)", self.source)
        self.assertIn("target_x = _normalize(_sub_v(flat_normal,", self.source)

    def test_wcs_origin_readback_is_converted_from_millimeters(self):
        # Confirmed live: Setup.workCoordinateSystem.getAsCoordinateSystem()
        # reports its origin translation in millimeters for a turning setup,
        # an exact 10x factor versus every other Fusion geometry API (always
        # centimeters) - dividing by 10 is required before any comparison to
        # a measurement taken from body geometry.
        self.assertIn("origin_cm = tuple(c / 10.0 for c in _vec(origin))", self.source)

    def test_origin_choice_is_tried_both_ways_not_hardcoded(self):
        # Confirmed live: which literal choice ("stock front" vs "stock
        # back") actually lands on the measured tip depends on this body's
        # own axis/flip resolution - Spacer's own body resolves "front" to
        # its tip while this hex shaft resolves "back" to its tip instead,
        # for the identical intent, so both are tried rather than assumed.
        front_index = self.source.index('"wcs_origin_turning").value.value = "stock front"')
        back_index = self.source.index('"wcs_origin_turning").value.value = "stock back"')
        self.assertLess(front_index, back_index)

    def test_groove_operation_requires_a_grooving_type_tool(self):
        # Confirmed live: Fusion rejects toolpath generation for a groove
        # operation given a plain turning-general tool ("Tool (turning
        # general) is not supported for the strategy.") - the one tool-type
        # detail that can't wait for later configuration, unlike feeds/speeds.
        self.assertIn('groove_tool = _tool_by_type(lib, "turning grooving") or generic_tool', self.source)
        self.assertIn('_input_with_tool(setup, "turning_single_groove", groove_tool)', self.source)

    def test_machines_whichever_groove_is_closest_to_the_tip(self):
        self.assertIn('target = max(groove_instances, key=lambda g: g["axialHigh"])', self.source)

    def test_tailstock_length_defaults_from_measured_geometry_but_is_overridable(self):
        self.assertIn("tailstock_length_in * _CM_PER_IN if tailstock_length_in is not None", self.source)
        self.assertIn("else model_length_cm", self.source)

    def test_retraction_is_forced_to_minimum_not_left_at_fusions_default(self):
        # Confirmed live: turning_face defaults to 'full' retraction, which
        # clears the *entire* stock length on every linking move between its
        # own surfacing passes - measured, real wasted machine time on a long
        # bar, not a simulation-only cosmetic issue. Each strategy names the
        # parameter differently (turning_profile_roughing already defaults to
        # 'minimum' under its own name), so both known names are tried.
        self.assertIn('for name in ("retractionPolicy", "profileRoughingRetractionPolicy"):', self.source)
        self.assertIn('param.value.value = "minimum"', self.source)
        self.assertIn("_set_minimum_retraction(op)", self.source)


if __name__ == "__main__":
    unittest.main()
