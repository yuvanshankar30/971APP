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
        self.assertIn("groove_instances = _groove_instances(body, origin_point, axis_unit, across_flats_cm)", self.source)
        self.assertIn("groove_count = len(groove_instances)", self.source)
        self.assertIn("two_ended = groove_count == 2", self.source)
        self.assertIn("axis_unit_rev = tuple(-c for c in axis_unit)", self.source)

    def test_no_setup_ever_parts_off_or_faces_off_the_grip_excess(self):
        # Direct instruction, after an earlier version's own final
        # staged-Face-plus-Part sequence machined away a real snap-ring
        # groove even with a geometry-clearance check in place: "remove
        # that facing operation... dont even cut off the part of the
        # stock that makes it fall... IT SHOULD DO ANYTHING BUT THAT LAST
        # FACING OPERATION BECAUSE THAT REMOVES THE GROOVES." Neither
        # setup this module builds ever posts a turning_part operation, or
        # any Face operation beyond the one light cleanup pass at its own
        # tip - the carried grip/tailstock excess stays attached
        # permanently once CAM is done.
        self.assertNotIn("turning_part", self.source)
        self.assertNotIn("sever_length_cm", self.source)
        self.assertNotIn("tailstock_excess_cm", self.source)

    def test_second_setup_stock_carries_the_same_grip_allowance_as_the_first(self):
        # The raw bar is one continuous piece through both setups (see the
        # module's own docstring) - the second setup's stock carries the
        # SAME grip_cm excess on its own back side that the first setup's
        # does, not a fresh/independent allowance and not none at all.
        second_stock_call = self.source.index("second_stock = _build_hex_stock(")
        second_stock_args = self.source[second_stock_call:self.source.index(")", second_stock_call) + 1]
        self.assertIn("axial_min_rev - grip_cm, axial_max_rev + tip_allowance_cm", second_stock_args)

    def test_every_setup_gets_a_light_tip_cleanup_face_first(self):
        # Direct instruction: "both programs should face the side of the
        # hex shaft to get rid of imperfections" - a light pass at this
        # end's own tip (WCS Z=0), explicit rather than Fusion's own
        # "model front" auto-default (which targets the FAR surface, i.e.
        # the grip/tailstock excess, not this end's own tip).
        self.assertIn('face_op.parameters.itemByName("frontHeight_mode").value.value = "from wcs"', self.source)
        self.assertIn('face_op.parameters.itemByName("frontHeight_offset").expression = "0 in"', self.source)
        self.assertIn("_TIP_FACE_ALLOWANCE_IN", self.source)

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
        # Confirmed live: which literal choice ("model front" vs "model
        # back") actually lands on the measured tip depends on this body's
        # own axis/flip resolution - Spacer's own body resolves "front" to
        # its tip while this hex shaft resolves "back" to its tip instead,
        # for the identical intent, so both are tried rather than assumed.
        # "model" (not "stock") front/back specifically: this setup's own
        # stock now deliberately extends past the model's own tip (the tip-
        # facing overage, and on the final setup the carried grip/tailstock
        # excess too), and only "model front"/"model back" stay anchored to
        # the design body's own fixed geometry regardless of that.
        front_index = self.source.index('"wcs_origin_turning").value.value = "model front"')
        back_index = self.source.index('"wcs_origin_turning").value.value = "model back"')
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

    def test_tailstock_length_defaults_to_a_fixed_allowance_but_is_overridable(self):
        # Direct instruction: "make sure the user input for tailstock works
        # with the autocam" - grip_cm (the excess carried through both
        # setups, and left permanently attached once CAM is done) is
        # driven directly by the operator's own tailstock_length_in when
        # given, not just measured/reported and otherwise ignored.
        self.assertIn(
            "tailstock_length_in * _CM_PER_IN if tailstock_length_in is not None\n"
            "        else _DEFAULT_TAILSTOCK_LENGTH_IN * _CM_PER_IN",
            self.source,
        )
        self.assertIn('"tailstockLength": grip_cm / _CM_PER_IN,', self.source)

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

    def test_a_one_ended_shafts_axis_is_flipped_when_the_groove_sits_near_the_low_end(self):
        # Audit finding: axis_unit's own direction comes from
        # _longest_edge's raw STEP start/end point order - arbitrary, not
        # guaranteed to point toward the grooved end. A two-ended shaft
        # doesn't care (both directions get their own setup), but a
        # one-ended shaft's single groove must sit near axis_unit's own
        # axial_max, since _build_hex_end_setup unconditionally machines
        # whichever groove is nearest THAT end. Without this flip, a
        # model whose single real groove happened to sit near axial_min
        # instead would silently turn the ENTIRE bar round rather than a
        # short neck, with no error anywhere.
        self.assertIn("if not two_ended:", self.source)
        self.assertIn("only_groove = groove_instances[0]", self.source)
        self.assertIn('distance_to_max = axial_max - only_groove["axialHigh"]', self.source)
        self.assertIn('distance_to_min = only_groove["axialLow"] - axial_min', self.source)
        self.assertIn("if distance_to_min < distance_to_max:", self.source)
        self.assertIn("axis_unit = tuple(-c for c in axis_unit)", self.source)

    def test_tailstock_length_has_a_real_physical_minimum(self):
        # Audit finding: neither the UI's own client-side min="0" nor
        # jobPayload.js validate tailstock_length_in - a 0 or negative
        # value reaching the Runner would silently build a stock prism
        # with no real grip allowance, or shorter than the finished part
        # itself. The chuck needs SOME real material to hold through both
        # setups; this is a physical requirement, not a preference.
        self.assertIn("_MIN_TAILSTOCK_LENGTH_IN = 0.25", self.source)
        self.assertIn("if grip_cm < _MIN_TAILSTOCK_LENGTH_IN * _CM_PER_IN:", self.source)


if __name__ == "__main__":
    unittest.main()
