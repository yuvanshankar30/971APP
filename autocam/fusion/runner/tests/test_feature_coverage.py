import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "featureCoverage", Path(__file__).parents[1] / "tools/featureCoverage.py"
)
featureCoverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(featureCoverage)


# Two separate closed cuts at full depth, split by a rapid reposition - the
# shape every contour operation posts for two distinct chains. G20 (inches),
# not G21 - every real program this pipeline's Runner posts is inches (the
# New Router/WinCNC dialect and JProg's own nesting output both are; nothing
# in this project posts metric). Real square brackets for the tool-table
# comment too, matching WinCNC's own dialect (see gcodeEmit.js).
TWO_LOOP_PROGRAM = """
%
[TEST]
[T1 D=0.1575 CR=0. - ZMIN=-0.825 - FLAT END MILL]
G90 G94 G17 G91.1
G20
G0 X1. Y1.
G1 Z0.1 F84.66
Z-0.825
X2. Y1. F508.
X2. Y2.
X1. Y2.
X1. Y1.
G0 Z0.4
X5. Y5.
G1 Z0.1 F84.66
Z-0.825
X6. Y5. F508.
X6. Y6.
X5. Y6.
X5. Y5.
G0 Z0.6
M30
%
"""

# One real cut, plus a shallow pass that never reaches the cutting plane -
# the exact shape of a 'from contour' bottomHeight leaving a feature
# selected but never broken through.
SHALLOW_SECOND_LOOP_PROGRAM = """
%
[TEST]
G20
G0 X1. Y1.
G1 Z-0.825 F508.
X2. Y1.
X2. Y2.
X1. Y2.
X1. Y1.
G0 Z0.4
X5. Y5.
G1 Z0.025 F508.
X6. Y5.
X6. Y6.
X5. Y6.
X5. Y5.
G0 Z0.6
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
        # Real G20 (inch) coordinates - a 1in square reads as 2.54cm, never
        # scaled as though it were millimeters.
        self.assertAlmostEqual(loops[0]["max_x"] - loops[0]["min_x"], 2.54, places=6)
        self.assertAlmostEqual(loops[0]["cx"], 1.5 * 2.54, places=6)
        self.assertAlmostEqual(loops[1]["cx"], 5.5 * 2.54, places=6)

    def test_ignores_a_pass_that_never_reaches_the_cutting_plane(self):
        # The real failure this exists to catch: the second feature is
        # selected and posted, but only ever cut to Z0.025 - far above the
        # program's own -0.825 cutting plane - so it is not a real cut and
        # must not be counted as coverage for that feature.
        loops = featureCoverage.gcode_loops(SHALLOW_SECOND_LOOP_PROGRAM)
        self.assertEqual(len(loops), 1)
        self.assertAlmostEqual(loops[0]["cx"], 1.5 * 2.54, places=6)

    def test_a_bracket_style_comment_is_never_mistaken_for_code(self):
        # WinCNC/New Router/JProg all comment with '[...]', not '(...)' -
        # a '[Part: ...]'-style line must be skipped like any other comment,
        # not parsed for stray coordinate-looking text.
        program = "\n".join([
            "G20",
            "[Part: Bracket]",
            "G0 X1. Y1.",
            "G1 Z-0.825 F508.",
            "X2. Y1.",
            "X2. Y2.",
            "X1. Y2.",
            "X1. Y1.",
            "G0 Z0.4",
        ])
        loops = featureCoverage.gcode_loops(program)
        self.assertEqual(len(loops), 1)
        self.assertAlmostEqual(loops[0]["cx"], 1.5 * 2.54, places=6)


class CoverageMatchingTests(unittest.TestCase):
    def test_reports_a_cad_loop_with_no_toolpath_as_not_cut(self):
        cad = [cad_loop(1.5 * 2.54, 1.5 * 2.54), cad_loop(5.5 * 2.54, 5.5 * 2.54)]
        cut = featureCoverage.gcode_loops(SHALLOW_SECOND_LOOP_PROGRAM)
        text, detail = featureCoverage.report(cad, cut)
        self.assertEqual(len(detail["uncut"]), 1)
        self.assertIn("NOT CUT", text)

    def test_full_coverage_reports_nothing_uncut(self):
        cad = [cad_loop(1.5 * 2.54, 1.5 * 2.54), cad_loop(5.5 * 2.54, 5.5 * 2.54)]
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
        offset = 40 * 2.54
        cad = [
            cad_loop(1.5 * 2.54 + offset, 1.5 * 2.54 + offset),
            cad_loop(5.5 * 2.54 + offset, 5.5 * 2.54 + offset),
        ]
        _text, detail = featureCoverage.report(cad, cut)
        self.assertEqual(detail["uncut"], [])
        self.assertEqual(len(detail["matched"]), 2)

    def test_a_toolpath_matching_no_feature_is_reported(self):
        cad = [cad_loop(1.5 * 2.54, 1.5 * 2.54)]
        cut = featureCoverage.gcode_loops(TWO_LOOP_PROGRAM)
        text, detail = featureCoverage.report(cad, cut)
        self.assertEqual(len(detail["unexplained"]), 1)
        self.assertIn("UNEXPLAINED", text)


class BreakthroughTests(unittest.TestCase):
    # A 0.0625in plate is 0.15875cm thick; a real through-cut must reach at
    # least -0.15875 in posted (stock-top-relative) coordinates. This is a
    # real cm value straight from Fusion's own (always-cm) API, independent
    # of whatever units the posted G-code itself is in.
    TOP_Z = 0.0
    BOTTOM_Z = -0.15875

    def test_a_real_through_cut_passes(self):
        # -0.825in clears a 0.0625in plate with real margin.
        passes, deepest, required = featureCoverage.breakthrough_check(
            TWO_LOOP_PROGRAM, self.BOTTOM_Z, self.TOP_Z
        )
        self.assertTrue(passes)
        self.assertAlmostEqual(deepest, -0.825 * 2.54, places=6)
        self.assertAlmostEqual(required, -0.15875, places=6)

    def test_a_cut_that_never_breaks_through_fails(self):
        # Z0.025in - the real 'from contour' bottomHeight failure: valid
        # toolpath, no warning, correct selections, but it never reaches the
        # material bottom.
        program = """
        G20
        G0 X1. Y1.
        G1 Z0.025 F508.
        X2. Y1.
        X2. Y2.
        """
        passes, deepest, required = featureCoverage.breakthrough_check(
            program, self.BOTTOM_Z, self.TOP_Z
        )
        self.assertFalse(passes)
        self.assertGreater(deepest, required)


class ThinWallTests(unittest.TestCase):
    TOOL_CM = 0.1575 * 2.54  # 0.1575in - the real detail bit (T6) this team uses.

    def test_two_cuts_far_apart_leave_a_healthy_wall(self):
        a = "G20\nG1 Z-0.825 F508.\nX0. Y0.\nX0. Y40.\n"
        b = "G20\nG1 Z-0.825 F508.\nX20. Y0.\nX20. Y40.\n"
        passes, wall, closest = featureCoverage.thin_wall_check(a, b, self.TOOL_CM, minimum_wall_cm=0.1)
        self.assertTrue(passes)
        self.assertAlmostEqual(closest, 20 * 2.54, places=6)
        self.assertAlmostEqual(wall, 20 * 2.54 - self.TOOL_CM, places=6)

    def test_cuts_closer_than_the_tool_is_wide_leave_no_wall_at_all(self):
        # 0.1in apart with a 0.1575in tool: the two cuts overlap outright.
        a = "G20\nG1 Z-0.825 F508.\nX0. Y0.\nX0. Y40.\n"
        b = "G20\nG1 Z-0.825 F508.\nX0.1 Y0.\nX0.1 Y40.\n"
        passes, wall, _closest = featureCoverage.thin_wall_check(a, b, self.TOOL_CM, minimum_wall_cm=0.1)
        self.assertFalse(passes)
        self.assertLess(wall, 0)

    def test_the_real_anton_plate_spacing_is_flagged_as_too_thin(self):
        # The measured case: centrelines 0.2in (5.08mm) apart, a 0.1575in
        # tool, leaving a 0.108cm (1.08mm) wall - cut correctly by both
        # operations, and still too fragile to survive in 1/16in aluminium.
        a = "G20\nG1 Z-0.825 F508.\nX0. Y0.\nX0. Y40.\n"
        b = "G20\nG1 Z-0.825 F508.\nX0.2 Y0.\nX0.2 Y40.\n"
        passes, wall, _closest = featureCoverage.thin_wall_check(a, b, self.TOOL_CM, minimum_wall_cm=0.15)
        self.assertFalse(passes)
        self.assertAlmostEqual(wall, 0.108, places=3)


if __name__ == "__main__":
    unittest.main()
