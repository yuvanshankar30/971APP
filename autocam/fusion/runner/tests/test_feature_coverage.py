import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "featureCoverage", Path(__file__).parents[1] / "tools/featureCoverage.py"
)
featureCoverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(featureCoverage)


# Two separate closed cuts at full depth, split by a rapid reposition - the
# shape every contour operation posts for two distinct chains.
TWO_LOOP_PROGRAM = """
%
(TEST)
(T1  D=4. CR=0. - ZMIN=-2.095 - FLAT END MILL)
G90 G94 G17 G91.1
G21
G0 X10. Y10.
G1 Z2.54 F84.66
Z-2.095
X20. Y10. F508.
X20. Y20.
X10. Y20.
X10. Y10.
G0 Z10.16
X50. Y50.
G1 Z2.54 F84.66
Z-2.095
X60. Y50. F508.
X60. Y60.
X50. Y60.
X50. Y50.
G0 Z15.24
M30
%
"""

# One real cut, plus a shallow pass that never reaches the cutting plane -
# the exact shape of a 'from contour' bottomHeight leaving a feature
# selected but never broken through.
SHALLOW_SECOND_LOOP_PROGRAM = """
%
(TEST)
G21
G0 X10. Y10.
G1 Z-2.095 F508.
X20. Y10.
X20. Y20.
X10. Y20.
X10. Y10.
G0 Z10.16
X50. Y50.
G1 Z0.025 F508.
X60. Y50.
X60. Y60.
X50. Y60.
X50. Y50.
G0 Z15.24
M30
%
"""


def cad_loop(cx_cm, cy_cm, size_cm=1.0, edge_count=4, circular=False):
    half = size_cm / 2
    return {
        "edge_count": edge_count,
        "circular": circular,
        "min_x": cx_cm - half, "max_x": cx_cm + half,
        "min_y": cy_cm - half, "max_y": cy_cm + half,
        "cx": cx_cm, "cy": cy_cm,
    }


class GcodeLoopParsingTests(unittest.TestCase):
    def test_finds_each_closed_cut_separated_by_a_rapid(self):
        loops = featureCoverage.gcode_loops(TWO_LOOP_PROGRAM)
        self.assertEqual(len(loops), 2)
        # mm -> cm, so a 10mm square reads as 1cm.
        self.assertAlmostEqual(loops[0]["max_x"] - loops[0]["min_x"], 1.0, places=6)
        self.assertAlmostEqual(loops[0]["cx"], 1.5, places=6)
        self.assertAlmostEqual(loops[1]["cx"], 5.5, places=6)

    def test_ignores_a_pass_that_never_reaches_the_cutting_plane(self):
        # The real failure this exists to catch: the second feature is
        # selected and posted, but only ever cut to Z0.025 - far above the
        # program's own -2.095 cutting plane - so it is not a real cut and
        # must not be counted as coverage for that feature.
        loops = featureCoverage.gcode_loops(SHALLOW_SECOND_LOOP_PROGRAM)
        self.assertEqual(len(loops), 1)
        self.assertAlmostEqual(loops[0]["cx"], 1.5, places=6)


class CoverageMatchingTests(unittest.TestCase):
    def test_reports_a_cad_loop_with_no_toolpath_as_not_cut(self):
        cad = [cad_loop(1.5, 1.5), cad_loop(5.5, 5.5)]
        cut = featureCoverage.gcode_loops(SHALLOW_SECOND_LOOP_PROGRAM)
        text, detail = featureCoverage.report(cad, cut)
        self.assertEqual(len(detail["uncut"]), 1)
        self.assertIn("NOT CUT", text)

    def test_full_coverage_reports_nothing_uncut(self):
        cad = [cad_loop(1.5, 1.5), cad_loop(5.5, 5.5)]
        cut = featureCoverage.gcode_loops(TWO_LOOP_PROGRAM)
        _text, detail = featureCoverage.report(cad, cut)
        self.assertEqual(detail["uncut"], [])
        self.assertEqual(detail["unexplained"], [])
        self.assertEqual(len(detail["matched"]), 2)

    def test_a_global_wcs_offset_does_not_read_as_missing_coverage(self):
        # Posted coordinates are relative to the setup WCS; the CAD extents
        # are model space. A uniform shift between them is expected and must
        # not be mistaken for features going uncut.
        cut = featureCoverage.gcode_loops(TWO_LOOP_PROGRAM)
        cad = [cad_loop(1.5 + 40, 1.5 + 40), cad_loop(5.5 + 40, 5.5 + 40)]
        _text, detail = featureCoverage.report(cad, cut)
        self.assertEqual(detail["uncut"], [])
        self.assertEqual(len(detail["matched"]), 2)

    def test_a_toolpath_matching_no_feature_is_reported(self):
        cad = [cad_loop(1.5, 1.5)]
        cut = featureCoverage.gcode_loops(TWO_LOOP_PROGRAM)
        text, detail = featureCoverage.report(cad, cut)
        self.assertEqual(len(detail["unexplained"]), 1)
        self.assertIn("UNEXPLAINED", text)


class BreakthroughTests(unittest.TestCase):
    # A 0.0625in plate is 0.15875cm thick; a real through-cut must reach at
    # least -0.15875 in posted (stock-top-relative) coordinates.
    TOP_Z = 0.0
    BOTTOM_Z = -0.15875

    def test_a_real_through_cut_passes(self):
        passes, deepest, required = featureCoverage.breakthrough_check(
            TWO_LOOP_PROGRAM, self.BOTTOM_Z, self.TOP_Z
        )
        self.assertTrue(passes)
        self.assertAlmostEqual(deepest, -0.2095, places=6)
        self.assertAlmostEqual(required, -0.15875, places=6)

    def test_a_cut_that_never_breaks_through_fails(self):
        # Z0.025mm - the real 'from contour' bottomHeight failure: valid
        # toolpath, no warning, correct selections, but it never reaches the
        # material bottom.
        program = """
        G21
        G0 X10. Y10.
        G1 Z0.025 F508.
        X20. Y10.
        X20. Y20.
        """
        passes, deepest, required = featureCoverage.breakthrough_check(
            program, self.BOTTOM_Z, self.TOP_Z
        )
        self.assertFalse(passes)
        self.assertGreater(deepest, required)


class ThinWallTests(unittest.TestCase):
    TOOL_CM = 0.4  # 4mm

    def test_two_cuts_far_apart_leave_a_healthy_wall(self):
        a = "G21\nG1 Z-2.095 F508.\nX0. Y0.\nX0. Y100.\n"
        b = "G21\nG1 Z-2.095 F508.\nX50. Y0.\nX50. Y100.\n"
        passes, wall, closest = featureCoverage.thin_wall_check(a, b, self.TOOL_CM, minimum_wall_cm=0.1)
        self.assertTrue(passes)
        self.assertAlmostEqual(closest, 5.0, places=6)
        self.assertAlmostEqual(wall, 4.6, places=6)

    def test_cuts_closer_than_the_tool_is_wide_leave_no_wall_at_all(self):
        # 2mm apart with a 4mm tool: the two cuts overlap outright.
        a = "G21\nG1 Z-2.095 F508.\nX0. Y0.\nX0. Y100.\n"
        b = "G21\nG1 Z-2.095 F508.\nX2. Y0.\nX2. Y100.\n"
        passes, wall, _closest = featureCoverage.thin_wall_check(a, b, self.TOOL_CM, minimum_wall_cm=0.1)
        self.assertFalse(passes)
        self.assertLess(wall, 0)

    def test_the_real_anton_plate_spacing_is_flagged_as_too_thin(self):
        # The measured case: centrelines 5.08mm apart, 4mm tool, leaving a
        # 1.08mm wall - cut correctly by both operations, and still too
        # fragile to survive in 1/16in aluminium.
        a = "G21\nG1 Z-2.095 F508.\nX0. Y0.\nX0. Y100.\n"
        b = "G21\nG1 Z-2.095 F508.\nX5.08 Y0.\nX5.08 Y100.\n"
        passes, wall, _closest = featureCoverage.thin_wall_check(a, b, self.TOOL_CM, minimum_wall_cm=0.15)
        self.assertFalse(passes)
        self.assertAlmostEqual(wall, 0.108, places=3)


if __name__ == "__main__":
    unittest.main()
