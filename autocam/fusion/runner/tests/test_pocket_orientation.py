import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "PocketOrientation", Path(__file__).parents[1] / "commands/PocketOrientation.py"
)
PocketOrientation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PocketOrientation)


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
