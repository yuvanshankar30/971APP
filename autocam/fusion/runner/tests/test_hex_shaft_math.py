from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.HexShaftMath import (  # noqa: E402
    circumscribed_radius_cm,
    cluster_groove_faces,
    is_groove_floor_radius,
    neck_radius_cm,
)


# A real reviewed 0.5in hex bar, confirmed live via Fusion MCP.
_ACROSS_FLATS_CM = 1.27


class NeckRadiusTests(unittest.TestCase):
    def test_neck_radius_is_half_across_flats(self):
        # Confirmed live: a real hex shaft necks down to exactly its own
        # inscribed-circle (apothem) diameter, which equals across-flats.
        self.assertAlmostEqual(neck_radius_cm(_ACROSS_FLATS_CM), 0.635)


class CircumscribedRadiusTests(unittest.TestCase):
    def test_circumscribed_radius_exceeds_neck_radius(self):
        # The corner-to-corner radius must clear the flat-to-flat radius by
        # construction - a rapid pass over an un-necked hex needs the larger one.
        self.assertGreater(circumscribed_radius_cm(_ACROSS_FLATS_CM), neck_radius_cm(_ACROSS_FLATS_CM))

    def test_matches_the_standard_hex_geometry_ratio(self):
        # circumscribed = across_flats / sqrt(3), the standard regular-hexagon
        # corner-to-corner radius given its flat-to-flat width.
        self.assertAlmostEqual(circumscribed_radius_cm(_ACROSS_FLATS_CM), _ACROSS_FLATS_CM / 3 ** 0.5, places=9)


class IsGrooveFloorRadiusTests(unittest.TestCase):
    def test_the_real_measured_groove_floor_qualifies(self):
        # Confirmed live: the groove floor's own radius is 0.468in/2 = 0.234in = 0.59436cm.
        self.assertTrue(is_groove_floor_radius(0.59436, _ACROSS_FLATS_CM))

    def test_the_hex_corner_artifact_radius_does_not_qualify(self):
        self.assertFalse(is_groove_floor_radius(circumscribed_radius_cm(_ACROSS_FLATS_CM), _ACROSS_FLATS_CM))

    def test_the_necked_inscribed_radius_itself_does_not_qualify(self):
        self.assertFalse(is_groove_floor_radius(neck_radius_cm(_ACROSS_FLATS_CM), _ACROSS_FLATS_CM))


class ClusterGrooveFacesTests(unittest.TestCase):
    def test_a_hairs_breadth_apart_faces_merge_into_one_groove(self):
        faces = [(1.0, 1.5, "a"), (1.503, 2.0, "b")]
        groups = cluster_groove_faces(faces, tolerance=0.005)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["axialLow"], 1.0)
        self.assertEqual(groups[0]["axialHigh"], 2.0)
        self.assertEqual(groups[0]["faces"], ["a", "b"])

    def test_genuinely_separate_grooves_stay_separate(self):
        faces = [(0.0, 0.5, "a"), (3.0, 3.5, "b")]
        groups = cluster_groove_faces(faces, tolerance=0.005)
        self.assertEqual(len(groups), 2)

    def test_groups_are_sorted_by_axial_low(self):
        faces = [(3.0, 3.5, "b"), (0.0, 0.5, "a")]
        groups = cluster_groove_faces(faces, tolerance=0.005)
        self.assertEqual([g["faces"][0] for g in groups], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
