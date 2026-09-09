import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "PocketOrientation", Path(__file__).parents[1] / "commands/PocketOrientation.py"
)
PocketOrientation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PocketOrientation)


class BlindPocketLoopTests(unittest.TestCase):
    def test_a_cavity_that_never_reaches_the_back_face_is_a_blind_pocket(self):
        # The cavity's wall-face walk exhausted every reachable face
        # without ever touching the material's opposite broad face - it
        # terminates at its own separate floor instead.
        self.assertTrue(PocketOrientation.loop_is_blind_pocket(False))

    def test_a_cavity_that_reaches_the_back_face_is_a_through_cut(self):
        # Whether reached in one hop or several (a real cavity can have
        # more than one wall face stacked before reaching the far side -
        # confirmed live), reaching it at all means no floor of its own.
        self.assertFalse(PocketOrientation.loop_is_blind_pocket(True))


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

    def test_countersink_requires_a_modeled_chamfer_on_the_setup_face(self):
        self.assertFalse(PocketOrientation.should_generate_countersink(True, False))
        self.assertFalse(PocketOrientation.should_generate_countersink(False, True))
        self.assertTrue(PocketOrientation.should_generate_countersink(True, True))

    def test_through_only_part_keeps_largest_broad_face_as_tie_breaker(self):
        sides = [
            {"area": 105.0, "inner_loop_count": 2, "inner_edge_count": 2},
            {"area": 120.0, "inner_loop_count": 2, "inner_edge_count": 2},
        ]
        self.assertEqual(PocketOrientation.preferred_pocket_side_index(sides), 1)

    def test_countersink_chamfer_side_beats_a_blind_pocket_on_the_other_side(self):
        # Real, confirmed live case: a countersink chamfer only exists,
        # topologically, on the one side it was actually modeled from -
        # getting this side wrong doesn't just waste a pass like an
        # unreachable blind pocket, it machines the flat back into a hole
        # instead, a real physically wrong part. Must outrank even a real
        # blind pocket on the opposite side.
        sides = [
            {
                "area": 120.0,
                "inner_loop_count": 4,
                "inner_edge_count": 12,
                "has_blind_pocket": True,
            },
            {
                "area": 100.0,
                "inner_loop_count": 2,
                "inner_edge_count": 2,
                "has_countersink_chamfer": True,
            },
        ]
        self.assertEqual(PocketOrientation.preferred_pocket_side_index(sides), 1)


if __name__ == "__main__":
    unittest.main()
