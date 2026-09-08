from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.TubeHeightMath import (  # noqa: E402
    BREAKTHROUGH_CLEARANCE_IN,
    PLANE_CLUSTER_TOLERANCE_CM,
    bottom_height_expression,
    cluster_by_projection,
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


class ClusterByProjectionTests(unittest.TestCase):
    def test_a_wall_split_into_several_coplanar_pieces_is_one_plane_not_several(self):
        # Direct bug report, confirmed live against a real STEP tube: a
        # wall face split into two pieces by a hole near its edge put both
        # pieces at (effectively) the same projection. Treating them as
        # two separate planes measured near-zero wall thickness between a
        # wall and its own other half instead of the real interior wall.
        items = [
            (9.5, "exterior_piece_a"),
            (9.5, "exterior_piece_b"),
            (9.5625, "interior_piece_a"),
            (9.5625, "interior_piece_b"),
            (10.4375, "far_interior"),
            (10.5, "far_exterior"),
        ]
        planes = cluster_by_projection(items, PLANE_CLUSTER_TOLERANCE_CM)
        self.assertEqual([p["projection"] for p in planes], [9.5, 9.5625, 10.4375, 10.5])
        self.assertEqual(planes[0]["items"], ["exterior_piece_a", "exterior_piece_b"])
        self.assertEqual(planes[1]["items"], ["interior_piece_a", "interior_piece_b"])

    def test_two_genuinely_distinct_walls_are_never_merged(self):
        # A real wall is always far thicker than the clustering tolerance -
        # confirm two truly separate planes stay separate.
        items = [(0.0, "outer"), (1.0, "inner")]
        planes = cluster_by_projection(items, PLANE_CLUSTER_TOLERANCE_CM)
        self.assertEqual(len(planes), 2)

    def test_clustering_uses_the_caller_supplied_tolerance(self):
        items = [(0.0, "a"), (0.01, "b")]
        self.assertEqual(len(cluster_by_projection(items, tolerance=0.02)), 1)
        self.assertEqual(len(cluster_by_projection(items, tolerance=0.005)), 2)
