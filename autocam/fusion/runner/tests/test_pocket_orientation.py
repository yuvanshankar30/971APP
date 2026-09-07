import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "PocketOrientation", Path(__file__).parents[1] / "commands/PocketOrientation.py"
)
PocketOrientation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PocketOrientation)


class BlindPocketLoopTests(unittest.TestCase):
    def test_a_wall_that_never_reaches_the_back_face_is_a_blind_pocket(self):
        # A hex cutout: 6 planar wall faces, none of them adjacent to the
        # material's opposite broad face - they all terminate at their own
        # separate floor face instead.
        self.assertTrue(PocketOrientation.loop_is_blind_pocket([False] * 6))

    def test_any_wall_reaching_the_back_face_means_a_through_cut(self):
        # A round through-hole: one cylindrical wall, directly adjacent to
        # the opposite broad face - no floor of its own.
        self.assertFalse(PocketOrientation.loop_is_blind_pocket([True]))

    def test_one_wall_reaching_back_is_enough_to_call_it_through(self):
        self.assertFalse(PocketOrientation.loop_is_blind_pocket([False, False, True]))

    def test_no_walls_at_all_is_not_a_pocket(self):
        self.assertFalse(PocketOrientation.loop_is_blind_pocket([]))


class PocketSideRankingTests(unittest.TestCase):
    def test_blind_pocket_side_beats_larger_plain_back(self):
        sides = [
            {"area": 120.0, "inner_loop_count": 2, "inner_edge_count": 2},
            {
                "area": 105.0,
                "inner_loop_count": 4,
                "inner_edge_count": 12,
                "has_blind_pocket": True,
            },
        ]
        self.assertEqual(PocketOrientation.preferred_pocket_side_index(sides), 1)

    def test_through_only_part_keeps_largest_broad_face_as_tie_breaker(self):
        sides = [
            {"area": 105.0, "inner_loop_count": 2, "inner_edge_count": 2},
            {"area": 120.0, "inner_loop_count": 2, "inner_edge_count": 2},
        ]
        self.assertEqual(PocketOrientation.preferred_pocket_side_index(sides), 1)


if __name__ == "__main__":
    unittest.main()
