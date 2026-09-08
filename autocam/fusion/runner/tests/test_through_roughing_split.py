"""Live-confirmed bug: a real template's "Shape Through Hole" and "Small
Shape Through Hole" (both adaptive2d roughing) were both assigned the exact
same full chain list in DeleteToolpaths.py's geometry repair - Fusion
computing a full adaptive-clearing roughing pass twice over identical
geometry on every job, real wasted computation on the largest/most complex
parts. _split_through_roughing_ops fixes this by routing each chain to
whichever roughing op can actually clear it, based on the assigned tool's
own diameter.

DeleteToolpaths.py imports Fusion's runtime-only modules at import time, so
the functions under test are loaded in isolation rather than by importing
the whole module - same pattern as test_operation_warnings.py.
"""

import types
from pathlib import Path
import unittest


def _load_split_functions():
    source = (Path(__file__).parents[1] / "commands/DeleteToolpaths.py").read_text()
    start = source.index("def _loop_bounding_box_dims")
    end = source.index("def _internal_feature_loop_chains_all_bodies")
    namespace = {}
    exec(compile(source[start:end], "DeleteToolpaths_through_split", "exec"), namespace)
    return namespace


_ns = _load_split_functions()
split_through_roughing_ops = _ns["_split_through_roughing_ops"]
operation_tool_diameter_cm = _ns["_operation_tool_diameter_cm"]
loop_min_dimension_cm = _ns["_loop_min_dimension_cm"]
ROUGHING_FIT_CLEARANCE_FACTOR = _ns["_ROUGHING_FIT_CLEARANCE_FACTOR"]


def _tool(diameter_cm):
    param = types.SimpleNamespace(value=types.SimpleNamespace(value=diameter_cm))
    return types.SimpleNamespace(parameters=types.SimpleNamespace(itemByName=lambda name: param if name == "tool_diameter" else None))


def _op(name, operation_id, tool_diameter_cm=None):
    tool = _tool(tool_diameter_cm) if tool_diameter_cm is not None else None
    return types.SimpleNamespace(name=name, operationId=operation_id, tool=tool)


def _entry(edge_label, min_dim_cm):
    # A bare label stands in for the real edge object - _split_through_
    # roughing_ops never inspects it, only passes it through unchanged.
    return (edge_label, False, min_dim_cm)


class OperationToolDiameterTests(unittest.TestCase):
    def test_reads_a_real_tool_diameter(self):
        op = _op("Shape Through Hole", "op1", tool_diameter_cm=0.635)
        self.assertEqual(operation_tool_diameter_cm(op), 0.635)

    def test_returns_none_when_the_operation_has_no_tool(self):
        op = types.SimpleNamespace(name="x", operationId="op1", tool=None)
        self.assertIsNone(operation_tool_diameter_cm(op))

    def test_returns_none_when_reading_the_parameter_raises(self):
        class _RaisingTool:
            @property
            def parameters(self):
                raise RuntimeError("simulated Fusion API failure")

        op = types.SimpleNamespace(name="x", operationId="op1", tool=_RaisingTool())
        self.assertIsNone(operation_tool_diameter_cm(op))


class SplitThroughRoughingOpsTests(unittest.TestCase):
    def test_routes_a_narrow_feature_to_the_small_tool_and_a_wide_one_to_the_big_tool(self):
        # A 0.635cm (0.25in) main tool needs real clearance beyond its own
        # diameter to actually rough-clear a feature - the clearance
        # factor this module applies (1.5x) puts that bar just under 1cm.
        # A feature well below that (a narrow lattice slot) must go to the
        # small tool; one well above it (a big internal pocket) must go to
        # the main tool.
        big_op = _op("Shape Through Hole", "big", tool_diameter_cm=0.635)
        small_op = _op("Small Shape Through Hole", "small", tool_diameter_cm=0.15)
        narrow = _entry("narrow-slot", 0.3)
        wide = _entry("wide-pocket", 2.0)

        assignments = split_through_roughing_ops([big_op, small_op], [narrow, wide])

        self.assertEqual(assignments["small"], [("narrow-slot", False)])
        self.assertEqual(assignments["big"], [("wide-pocket", False)])

    def test_falls_back_to_giving_every_op_every_chain_when_there_is_no_small_op(self):
        # Only "big"-named roughing ops - nothing to split against, so the
        # original (pre-fix) behavior applies: everyone gets everything.
        op_a = _op("Shape Through Hole", "a", tool_diameter_cm=0.635)
        op_b = _op("Shape Through Hole big endmill", "b", tool_diameter_cm=0.95)
        entries = [_entry("f1", 0.3), _entry("f2", 2.0)]

        assignments = split_through_roughing_ops([op_a, op_b], entries)

        expected = [("f1", False), ("f2", False)]
        self.assertEqual(assignments["a"], expected)
        self.assertEqual(assignments["b"], expected)

    def test_falls_back_when_a_big_ops_tool_diameter_cannot_be_read(self):
        # Splitting without a real number to split on risks silently
        # starving an operation of geometry it should have had - fall
        # back to the safe, original behavior instead of guessing.
        big_op = _op("Shape Through Hole", "big", tool_diameter_cm=None)
        small_op = _op("Small Shape Through Hole", "small", tool_diameter_cm=0.15)
        entries = [_entry("f1", 0.3)]

        assignments = split_through_roughing_ops([big_op, small_op], entries)

        self.assertEqual(assignments["big"], [("f1", False)])
        self.assertEqual(assignments["small"], [("f1", False)])

    def test_a_part_with_nothing_narrow_leaves_the_small_op_empty_not_falsely_populated(self):
        big_op = _op("Shape Through Hole", "big", tool_diameter_cm=0.635)
        small_op = _op("Small Shape Through Hole", "small", tool_diameter_cm=0.15)
        entries = [_entry("wide-only", 2.0)]

        assignments = split_through_roughing_ops([big_op, small_op], entries)

        self.assertEqual(assignments["small"], [])
        self.assertEqual(assignments["big"], [("wide-only", False)])

    def test_three_roughing_ops_the_new_router_template_ships_all_get_routed(self):
        # The New Router's real template has THREE "through"-named
        # roughing ops: "Shape Through Hole big endmill", "Shape Through
        # Hole", and "Small Shape Through Hole" - both non-"small"-named
        # ops are held to the same (thinner) tool's threshold, so neither
        # ever receives a chain narrower than it can actually clear.
        big_endmill = _op("Shape Through Hole big endmill", "big_endmill", tool_diameter_cm=0.95)
        main = _op("Shape Through Hole", "main", tool_diameter_cm=0.635)
        small = _op("Small Shape Through Hole", "small", tool_diameter_cm=0.15)
        narrow = _entry("narrow", 0.3)
        wide = _entry("wide", 2.0)

        assignments = split_through_roughing_ops([big_endmill, main, small], [narrow, wide])

        self.assertEqual(assignments["small"], [("narrow", False)])
        self.assertEqual(assignments["main"], [("wide", False)])
        self.assertEqual(assignments["big_endmill"], [("wide", False)])


class LoopMinDimensionTests(unittest.TestCase):
    def test_returns_the_narrower_bounding_box_dimension(self):
        edge = types.SimpleNamespace(
            startVertex=types.SimpleNamespace(geometry=types.SimpleNamespace(x=0.0, y=0.0)),
            endVertex=types.SimpleNamespace(geometry=types.SimpleNamespace(x=10.0, y=2.0)),
        )
        self.assertAlmostEqual(loop_min_dimension_cm([edge]), 2.0)

    def test_returns_zero_when_unmeasurable(self):
        edge = types.SimpleNamespace()  # no startVertex/endVertex/pointOnEdge
        self.assertEqual(loop_min_dimension_cm([edge]), 0.0)


if __name__ == "__main__":
    unittest.main()
