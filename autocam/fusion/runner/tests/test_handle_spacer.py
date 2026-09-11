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

    def test_tailstock_length_defaults_from_measured_geometry_but_is_overridable(self):
        self.assertIn("tailstock_length_in * _CM_PER_IN if tailstock_length_in is not None", self.source)
        self.assertIn("else default_tailstock_length_cm(model_length_cm)", self.source)

    def test_model_is_rebound_after_the_template_like_handle_tube_does_for_the_wcs(self):
        template_index = self.source.index("setup.createFromCAMTemplate2(template_input)")
        rebind_index = self.source.index("_bind_job_model(setup, body)", template_index)
        self.assertGreater(rebind_index, template_index)


if __name__ == "__main__":
    unittest.main()
