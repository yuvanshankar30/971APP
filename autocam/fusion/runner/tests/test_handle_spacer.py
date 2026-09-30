from pathlib import Path
import unittest


RUNNER_DIR = Path(__file__).parents[1]


class HandleSpacerSourceTests(unittest.TestCase):
    """HandleSpacer.py imports adsk.* at module load, so it can only run
    inside Fusion (same reasoning as HandleTube.py's own tests) - these
    check the source directly for the rules confirmed live, per
    test_tube_face_programs.py's established pattern for this repo.
    """

    def setUp(self):
        self.source = (RUNNER_DIR / "commands" / "HandleSpacer.py").read_text()

    def test_requires_exactly_one_occurrence_and_body_like_handle_tube(self):
        self.assertIn('raise ValueError("Spacer CAM requires exactly one imported spacer occurrence")', self.source)
        self.assertIn('raise ValueError("Spacer CAM requires exactly one solid body")', self.source)

    def test_bore_face_is_the_smaller_of_exactly_two_cylinders(self):
        # Confirmed live: a real spacer body has exactly 4 faces - one OD
        # cylinder, one bore cylinder, two end caps - and the bore is
        # whichever of the two cylindrical faces has the smaller radius.
        self.assertIn("if len(cylinders) != 2:", self.source)
        self.assertIn(
            "inner, outer = sorted(cylinders, key=lambda face: adsk.core.Cylinder.cast(face.geometry).radius)",
            self.source,
        )
        self.assertIn("return inner", self.source)

    def test_solid_stock_with_no_cylinders_returns_none_not_an_error(self):
        self.assertIn("if len(cylinders) == 0:\n        return None", self.source)

    def test_drill_is_deleted_when_the_spacer_has_no_hole(self):
        # Confirmed live: a solid spacer correctly ends up with 4 operations
        # (Face, Profile Roughing, Profile Finishing, Part) - Drill removed,
        # not left pointing at stale/no geometry.
        self.assertIn("elif drill is not None:", self.source)
        self.assertIn("drill.deleteMe()", self.source)

    def test_bore_face_is_rebound_after_the_template_is_applied_not_before(self):
        template_index = self.source.index("setup.createFromCAMTemplate2(template_input)")
        bore_index = self.source.index("bore = _bore_face(body)")
        self.assertLess(template_index, bore_index)

    def test_stock_and_tailstock_are_resolved_from_the_part_and_the_operators_choices(self):
        # Blank fields are derived from the imported part (StockMath); set
        # ones, including the tailstock length, change the stock itself.
        self.assertIn("resolved = resolve_spacer_stock(", self.source)
        self.assertIn('stock_od_cm=_cm_or_none(stock_input.get("od_in")),', self.source)
        self.assertIn("tailstock_cm=_cm_or_none(tailstock_length_in),", self.source)
        self.assertIn('parameters.itemByName("job_stockLengthMode").value.value = "front"', self.source)
        self.assertIn('parameters.itemByName("job_stockDiameterInner").expression', self.source)

    def test_drill_is_kept_only_when_the_stock_is_not_already_bored_to_size(self):
        self.assertIn('if resolved["drill_needed"]:', self.source)

    def test_model_is_rebound_after_the_template_like_handle_tube_does_for_the_wcs(self):
        template_index = self.source.index("setup.createFromCAMTemplate2(template_input)")
        rebind_index = self.source.index("_bind_job_model(setup, body)", template_index)
        self.assertGreater(rebind_index, template_index)


if __name__ == "__main__":
    unittest.main()
