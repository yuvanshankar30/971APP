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



class SeedEdgeDirectionTests(unittest.TestCase):
    """Real, confirmed bug: two identical slots on one tube wall, one
    selected correctly and the other tracing a larger loop around the
    feature. The reversal was read from the loop's FIRST co-edge while the
    chain was seeded from its FIRST EDGE - two separate collections with no
    guaranteed common order, so the winding was only right on the loops
    where those orders happened to agree. Fusion accepts either winding on a
    closed loop and silently traces a different chain for the wrong one, so
    nothing failed; the toolpath was just wrong.
    """

    def test_uses_the_seed_edge_own_coedge_not_the_first_one(self):
        # Seed is edge 20, whose co-edge is opposed; the FIRST co-edge (10)
        # is not. Reading the first one would return False here.
        rows = [(10, False), (20, True), (30, False)]
        self.assertTrue(ContourChains.is_reverted_for_seed_edge(rows, 20))

    def test_the_other_direction_too(self):
        rows = [(10, True), (20, False), (30, True)]
        self.assertFalse(ContourChains.is_reverted_for_seed_edge(rows, 20))

    def test_agrees_with_the_first_coedge_when_the_seed_is_the_first_edge(self):
        # The case that already worked, and must keep working.
        rows = [(10, True), (20, False)]
        self.assertEqual(
            ContourChains.is_reverted_for_seed_edge(rows, 10),
            ContourChains.is_reverted_for_loop_seed(rows[0][1])
        )

    def test_falls_back_to_the_first_coedge_for_a_seed_with_none_of_its_own(self):
        rows = [(10, True), (20, False)]
        self.assertTrue(ContourChains.is_reverted_for_seed_edge(rows, 999))

    def test_handles_a_loop_with_no_coedges_at_all(self):
        self.assertFalse(ContourChains.is_reverted_for_seed_edge([], 10))

    def test_accepts_a_generator_not_just_a_list(self):
        # HandleTube passes one straight from loop.coEdges.
        rows = ((edge_id, edge_id == 20) for edge_id in (10, 20, 30))
        self.assertTrue(ContourChains.is_reverted_for_seed_edge(rows, 20))


if __name__ == "__main__":
    unittest.main()
