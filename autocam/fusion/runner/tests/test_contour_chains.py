import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "ContourChains", Path(__file__).parents[1] / "commands/ContourChains.py"
)
ContourChains = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ContourChains)


class ChainDirectionTests(unittest.TestCase):
    def test_keeps_a_seed_edge_in_the_loop_coedge_direction(self):
        # A co-edge already aligned with the shared BRepEdge needs no flip.
        self.assertFalse(ContourChains.is_reverted_for_loop_seed(False))

    def test_reverses_a_seed_edge_opposed_to_the_loop_coedge(self):
        # The same physical BRepEdge may appear reversed on the selected
        # face.  This is the case that previously made feature arrows vary
        # from one imported loop to another.
        self.assertTrue(ContourChains.is_reverted_for_loop_seed(True))


if __name__ == "__main__":
    unittest.main()
