"""_split_big_circular_holes routes each recognized circular through-hole
loop to the dedicated big-hole operation's "regular" or "big endmill" tier
by real diameter - direct instruction: a "decently large" hole should use
the bigger loaded endmill, not whichever cutter this operation would
otherwise get uniformly. Mirrors test_through_roughing_split.py's own
mock/loading pattern.

DeleteToolpaths.py imports Fusion's runtime-only modules at import time, so
the function under test is loaded in isolation.
"""

import types
from pathlib import Path
import unittest


def _load():
    source = (Path(__file__).parents[1] / "commands/DeleteToolpaths.py").read_text()
    start = source.index("def _is_dedicated_circular_hole_op")
    end = source.index("def _internal_feature_loop_chains_all_bodies")
    namespace = {}
    exec(compile(source[start:end], "DeleteToolpaths_split_big_circular_holes", "exec"), namespace)
    return namespace


_ns = _load()
split_big_circular_holes = _ns["_split_big_circular_holes"]
BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN = _ns["_BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN"]
ROUGHING_FIT_CLEARANCE_FACTOR = _ns["_ROUGHING_FIT_CLEARANCE_FACTOR"]


def _op(name, tool_diameter_cm=None):
    # _operation_tool_diameter_cm reads op.tool.parameters, not op.parameters.
    if tool_diameter_cm is None:
        parameters = types.SimpleNamespace(itemByName=lambda _n: None)
    else:
        value = types.SimpleNamespace(value=tool_diameter_cm)
        param = types.SimpleNamespace(value=value)
        parameters = types.SimpleNamespace(itemByName=lambda n, p=param: p if n == "tool_diameter" else None)
    tool = types.SimpleNamespace(parameters=parameters)
    return types.SimpleNamespace(operationId=name, name=name, tool=tool)


def _loop(token, diameter_cm):
    edges = [token]
    return (edges, False, diameter_cm)


class SplitBigCircularHolesTests(unittest.TestCase):
    def test_single_tier_gets_every_qualifying_loop(self):
        # No "big endmill" sibling exists (Old Router, or a New Router job
        # without a real ATC swap plan) - every loop goes to the one op
        # present, identical to this function's behavior before the split.
        regular = _op(">.3 Circular Through Hole (sized)")
        loops = [_loop("a", 1.0), _loop("b", 3.0)]

        assignments = split_big_circular_holes([regular], loops)

        self.assertEqual(assignments[regular.operationId], [(["a"], False), (["b"], False)])

    def test_small_hole_stays_on_the_regular_tier(self):
        regular = _op(">.3 Circular Through Hole (sized)", tool_diameter_cm=0.4)
        big = _op(">.3 Circular Through Hole (sized) big endmill", tool_diameter_cm=0.6)
        small_hole_cm = (BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN * 2.54) - 0.1

        assignments = split_big_circular_holes([regular, big], [_loop("a", small_hole_cm)])

        self.assertEqual(assignments[regular.operationId], [(["a"], False)])
        self.assertEqual(assignments[big.operationId], [])

    def test_decently_large_hole_goes_to_the_big_endmill_tier(self):
        regular = _op(">.3 Circular Through Hole (sized)", tool_diameter_cm=0.4)
        big = _op(">.3 Circular Through Hole (sized) big endmill", tool_diameter_cm=0.6)
        large_hole_cm = (BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN * 2.54) + 0.1

        assignments = split_big_circular_holes([regular, big], [_loop("a", large_hole_cm)])

        self.assertEqual(assignments[big.operationId], [(["a"], False)])
        self.assertEqual(assignments[regular.operationId], [])

    def test_the_0_6in_floor_applies_even_when_the_big_tool_is_smaller(self):
        # Direct instruction named 0.6in as the floor explicitly - a small
        # "big endmill" cutter must not lower the bar below that.
        regular = _op(">.3 Circular Through Hole (sized)", tool_diameter_cm=0.1)
        big = _op(">.3 Circular Through Hole (sized) big endmill", tool_diameter_cm=0.2)
        just_under_the_floor_cm = (BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN * 2.54) - 0.01

        assignments = split_big_circular_holes([regular, big], [_loop("a", just_under_the_floor_cm)])

        self.assertEqual(assignments[regular.operationId], [(["a"], False)])
        self.assertEqual(assignments[big.operationId], [])

    def test_the_big_tools_own_clearance_can_raise_the_threshold_above_0_6in(self):
        # A genuinely large big-endmill cutter needs more real clearance
        # than the bare 0.6in floor - same _ROUGHING_FIT_CLEARANCE_FACTOR
        # margin already used for Shape Through Hole's own roughing tiers.
        regular = _op(">.3 Circular Through Hole (sized)", tool_diameter_cm=0.4)
        big = _op(">.3 Circular Through Hole (sized) big endmill", tool_diameter_cm=1.2)
        above_the_bare_floor_but_not_the_real_clearance_cm = (BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN * 2.54) + 0.05

        assignments = split_big_circular_holes(
            [regular, big], [_loop("a", above_the_bare_floor_but_not_the_real_clearance_cm)]
        )

        self.assertEqual(assignments[regular.operationId], [(["a"], False)])
        self.assertEqual(assignments[big.operationId], [])

    def test_missing_tool_diameter_falls_back_to_the_bare_0_6in_floor(self):
        regular = _op(">.3 Circular Through Hole (sized)", tool_diameter_cm=0.4)
        big = _op(">.3 Circular Through Hole (sized) big endmill")  # no tool assigned yet
        large_hole_cm = (BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN * 2.54) + 0.1

        assignments = split_big_circular_holes([regular, big], [_loop("a", large_hole_cm)])

        self.assertEqual(assignments[big.operationId], [(["a"], False)])

    def test_multiple_loops_split_independently(self):
        regular = _op(">.3 Circular Through Hole (sized)", tool_diameter_cm=0.4)
        big = _op(">.3 Circular Through Hole (sized) big endmill", tool_diameter_cm=0.6)
        small_hole_cm = (BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN * 2.54) - 0.1
        large_hole_cm = (BIG_CIRCULAR_HOLE_MIN_DIAMETER_IN * 2.54) + 0.1

        assignments = split_big_circular_holes(
            [regular, big], [_loop("small", small_hole_cm), _loop("large", large_hole_cm)]
        )

        self.assertEqual(assignments[regular.operationId], [(["small"], False)])
        self.assertEqual(assignments[big.operationId], [(["large"], False)])


if __name__ == "__main__":
    unittest.main()
