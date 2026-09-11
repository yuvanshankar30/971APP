from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.SpacerMath import default_tailstock_length_cm, has_hole, HOLE_DIAMETER_EPSILON_CM  # noqa: E402


class HasHoleTests(unittest.TestCase):
    def test_a_real_bore_reads_as_a_hole(self):
        # 0.201in bore (5.1054mm), confirmed live against a real spacer.
        self.assertTrue(has_hole(0.51054))

    def test_genuinely_solid_stock_reads_as_no_hole(self):
        # Confirmed live: a solid model's own modelDiameterInner is exactly 0.
        self.assertFalse(has_hole(0.0))

    def test_the_epsilon_itself_is_not_a_hole(self):
        self.assertFalse(has_hole(HOLE_DIAMETER_EPSILON_CM))
        self.assertTrue(has_hole(HOLE_DIAMETER_EPSILON_CM + 0.0001))


class DefaultTailstockLengthTests(unittest.TestCase):
    def test_defaults_to_the_full_measured_part_length(self):
        # Confirmed live: a 3in spacer defaulted to a 3in tailstock length; a
        # 1in solid spacer defaulted to 1in.
        self.assertEqual(default_tailstock_length_cm(7.62), 7.62)
        self.assertEqual(default_tailstock_length_cm(2.54), 2.54)


if __name__ == "__main__":
    unittest.main()
