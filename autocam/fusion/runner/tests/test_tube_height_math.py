from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.TubeHeightMath import (  # noqa: E402
    BREAKTHROUGH_CLEARANCE_IN,
    bottom_height_expression,
)


class TubeBottomHeightTests(unittest.TestCase):
    def test_a_hollow_wall_stops_just_past_its_own_thickness_not_stock_bottom(self):
        # Direct bug report: a hole/cutout was reaching all the way through
        # the hollow tube into the far wall instead of stopping at the near
        # wall's own inner surface.
        mode, offset = bottom_height_expression(0.125)
        self.assertEqual(mode, "'from stock top'")
        self.assertEqual(offset, "-0.175000 in")  # 0.125 wall + 0.05 breakthrough clearance

    def test_the_breakthrough_clearance_matches_the_original_template_value(self):
        # Not an invented number - the hand-authored template's own stale
        # 'from point' bottomHeight_offset was -0.05in past its reference
        # point. Kept the same so the depth convention this shop already
        # tuned by hand doesn't silently change.
        self.assertEqual(BREAKTHROUGH_CLEARANCE_IN, 0.05)

    def test_a_thicker_wall_cuts_deeper_by_exactly_its_own_thickness(self):
        _, thin_offset = bottom_height_expression(0.0625)
        _, thick_offset = bottom_height_expression(0.25)
        thin_depth = -float(thin_offset.replace(" in", ""))
        thick_depth = -float(thick_offset.replace(" in", ""))
        self.assertAlmostEqual(thick_depth - thin_depth, 0.25 - 0.0625, places=6)

    def test_genuinely_solid_stock_with_no_paired_interior_face_falls_back_to_stock_bottom(self):
        # No hollow interior to protect against - the pre-existing behavior
        # is already correct and safe for this degenerate case.
        mode, offset = bottom_height_expression(None)
        self.assertEqual(mode, "'from stock bottom'")
        self.assertEqual(offset, "0 in")

    def test_rejects_a_nonpositive_wall_thickness(self):
        # A real geometric measurement is never zero or negative; a bad
        # value here should fail loudly rather than silently produce a
        # bottomHeight_offset of "0 in" or a positive (upward) depth.
        with self.assertRaises(ValueError):
            bottom_height_expression(0.0)
        with self.assertRaises(ValueError):
            bottom_height_expression(-0.1)
