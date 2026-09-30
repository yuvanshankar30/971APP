from pathlib import Path
import unittest


RUNNER_DIR = Path(__file__).parents[1]


class HandleInternalShaftSourceTests(unittest.TestCase):
    """The handlers import adsk.* at module load, so they can only run inside
    Fusion - these check the source directly, same pattern as
    test_handle_hex_shaft.py.
    """

    def setUp(self):
        self.internal = (RUNNER_DIR / "commands" / "HandleInternalShaft.py").read_text()
        self.hex = (RUNNER_DIR / "commands" / "HandleHexShaft.py").read_text()
        self.workflow = (RUNNER_DIR / "workflows" / "camTurning.py").read_text()

    def test_internal_shaft_is_its_own_entry_point_using_the_journal_end_feature(self):
        self.assertIn("def handleInternalShaft(tailstock_length_in=None, stock=None):", self.internal)
        self.assertIn("build_shaft_setups(tailstock_length_in, stock, END_FEATURE_JOURNAL)", self.internal)

    def test_hex_shaft_still_uses_the_groove_end_feature(self):
        self.assertIn("build_shaft_setups(tailstock_length_in, stock, END_FEATURE_GROOVE)", self.hex)

    def test_journal_ends_get_no_groove_operation_and_no_groove_suppression(self):
        # The single-groove operation and groove suppression are only added
        # for the groove end feature.
        self.assertIn("if end_feature == END_FEATURE_GROOVE:\n        groove_op = ", self.hex)
        self.assertIn("            # The single-groove operation below owns the groove;", self.hex)

    def test_journal_instances_come_from_the_inscribed_radius_detector(self):
        self.assertIn("_axial_cylinder_instances(body, origin_point, axis_unit, across_flats_cm, is_journal_radius)", self.hex)

    def test_part_off_blade_is_used_when_there_is_no_groove_to_size_from(self):
        self.assertIn("insert_width_cm = _PART_OFF_BLADE_IN * _CM_PER_IN", self.hex)

    def test_setups_are_named_internal_shaft(self):
        self.assertIn('END_FEATURE_JOURNAL: "Internal Shaft"', self.hex)

    def test_workflow_accepts_and_dispatches_the_internal_shaft_cam_type(self):
        self.assertIn('if cam_type not in ("spacer", "hexShaft", "internalShaft"):', self.workflow)
        self.assertIn('handler = handleInternalShaft if cam_type == "internalShaft" else handleHexShaft', self.workflow)
        self.assertIn("from ..commands.HandleInternalShaft import handleInternalShaft", self.workflow)


if __name__ == "__main__":
    unittest.main()
