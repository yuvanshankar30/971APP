"""Through-shape roughing must survive blind-pocket cleanup.

The New Router's Shape Through Hole operation is adaptive2d, the same
strategy used by Shape Pocket. A plate with no blind pockets must remove
Shape Pocket, but must keep a valid through-shape roughing operation so its
matching finishing pass can generate and post-process.
"""

from pathlib import Path
import types
import unittest


def _load():
    source = (Path(__file__).parents[1] / "commands/DeleteToolpaths.py").read_text()
    start = source.index("_POCKET_STRATEGIES = (")
    end = source.index("# Maps each strategy")
    namespace = {}
    exec(compile(source[start:end], "DeleteToolpaths_missing_pocket_floor", "exec"), namespace)
    return namespace["_should_remove_for_missing_pocket_floor"]


should_remove_for_missing_pocket_floor = _load()


def _op(name, strategy):
    return types.SimpleNamespace(name=name, strategy=strategy)


class MissingPocketFloorCleanupTests(unittest.TestCase):
    def test_removes_a_real_shape_pocket_without_a_floor(self):
        self.assertTrue(
            should_remove_for_missing_pocket_floor(_op("Shape Pocket", "adaptive2d"))
        )

    def test_keeps_a_non_circular_through_shape_roughing_operation(self):
        # Regression for angad_part: selection repair generated this
        # operation successfully, then generic no-pocket-floor cleanup
        # deleted it before the finishing-pair guard ran.
        self.assertFalse(
            should_remove_for_missing_pocket_floor(_op("Shape Through Hole", "adaptive2d"))
        )

    def test_keeps_the_new_router_big_through_tier(self):
        self.assertFalse(
            should_remove_for_missing_pocket_floor(
                _op("Shape Through Hole big endmill", "adaptive2d")
            )
        )

    def test_keeps_the_circular_through_hole_pocket_operation(self):
        self.assertFalse(
            should_remove_for_missing_pocket_floor(
                _op(">.3 Circular Through Hole (sized)", "pocket2d")
            )
        )


if __name__ == "__main__":
    unittest.main()
