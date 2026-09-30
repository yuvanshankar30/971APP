from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.SpacerMath import drill_cutting_data, drill_feed_ipr, has_hole, HOLE_DIAMETER_EPSILON_CM  # noqa: E402


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


class DrillCuttingDataTests(unittest.TestCase):
    def test_a_small_bore_gets_a_slow_feed_and_a_capped_rpm_from_its_sfm(self):
        data = drill_cutting_data(0.23, 2.16, 2000)
        self.assertEqual(data["rpm"], 1660)  # 100 SFM on 0.23in
        self.assertEqual(data["feed_ipr"], 0.004)

    def test_rpm_never_exceeds_the_machine_limit(self):
        self.assertEqual(drill_cutting_data(0.05, 1.0, 2000)["rpm"], 2000)

    def test_flutes_reach_past_the_hole_depth(self):
        # The template drill's 1.125in flutes could not reach a 2.16in bore.
        self.assertGreater(drill_cutting_data(0.23, 2.16, 2000)["flute_in"], 2.16)

    def test_a_deep_hole_pecks_at_one_diameter_and_a_shallow_one_does_not(self):
        deep = drill_cutting_data(0.23, 2.16, 2000)
        self.assertTrue(deep["deep"])
        self.assertAlmostEqual(deep["peck_in"], 0.23)
        self.assertFalse(drill_cutting_data(0.5, 1.0, 2000)["deep"])

    def test_feed_steps_up_with_drill_diameter(self):
        self.assertEqual([drill_feed_ipr(d) for d in (0.2, 0.3, 0.75)], [0.004, 0.006, 0.008])


if __name__ == "__main__":
    unittest.main()
