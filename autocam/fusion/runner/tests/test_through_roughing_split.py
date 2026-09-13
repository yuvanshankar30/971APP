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
    namespace = {"_POCKET_STRATEGIES": ("pocket_new", "pocket_clearing", "pocket2d", "adaptive2d")}
    exec(compile(source[start:end], "DeleteToolpaths_through_split", "exec"), namespace)
    return namespace


_ns = _load_split_functions()
split_through_roughing_ops = _ns["_split_through_roughing_ops"]
operation_tool_diameter_cm = _ns["_operation_tool_diameter_cm"]
adaptive_entry_clearance_cm = _ns["_adaptive_entry_clearance_cm"]
next_smaller_through_roughing_op = _ns["_next_smaller_through_roughing_op"]
reroute_empty_through_roughing = _ns["_reroute_empty_through_roughing"]
reconcile_through_roughing_coverage = _ns["_reconcile_through_roughing_coverage"]
loop_min_dimension_cm = _ns["_loop_min_dimension_cm"]
loop_min_clearance_cm = _ns["_loop_min_clearance_cm"]
ROUGHING_FIT_CLEARANCE_FACTOR = _ns["_ROUGHING_FIT_CLEARANCE_FACTOR"]


def _tool(diameter_cm):
    param = types.SimpleNamespace(value=types.SimpleNamespace(value=diameter_cm))
    return types.SimpleNamespace(parameters=types.SimpleNamespace(itemByName=lambda name: param if name == "tool_diameter" else None))


def _op(name, operation_id, tool_diameter_cm=None, helical_ramp_cm=None):
    tool = _tool(tool_diameter_cm) if tool_diameter_cm is not None else None
    ramp = (
        types.SimpleNamespace(value=types.SimpleNamespace(value=helical_ramp_cm))
        if helical_ramp_cm is not None
        else None
    )
    ramp_type = types.SimpleNamespace(expression="'helix'")
    return types.SimpleNamespace(
        name=name,
        operationId=operation_id,
        tool=tool,
        parameters=types.SimpleNamespace(
            itemByName=lambda param_name: (
                ramp if param_name in ("minimumRampDiameter", "helicalRampDiameter")
                else ramp_type if param_name == "rampType"
                else None
            )
        ),
    )


def _entry(edge_label, min_dim_cm):
    # A label stands in for a loop's chain seed. The splitter must preserve
    # it unchanged so roughing and finishing resolve the same closed chain.
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


class AdaptiveEntryClearanceTests(unittest.TestCase):
    def test_includes_the_template_helical_ramp_diameter(self):
        # The New Router's 6 mm big-through template ramps on a 5.7 mm
        # diameter helix. The cutter plus that helix need 1.17 cm of real
        # opening, not merely the old 0.9 cm (1.5x cutter) heuristic.
        op = _op("Shape Through Hole big endmill", "big", 0.6, helical_ramp_cm=0.57)
        self.assertAlmostEqual(adaptive_entry_clearance_cm(op, 0.6), 1.17)

    def test_preserves_the_legacy_clearance_when_no_ramp_is_available(self):
        op = _op("Shape Through Hole", "regular", 0.4)
        self.assertAlmostEqual(
            adaptive_entry_clearance_cm(op, 0.4), 0.4 * ROUGHING_FIT_CLEARANCE_FACTOR
        )


class ThroughRoughingFallbackTests(unittest.TestCase):
    def test_chooses_the_next_smaller_loaded_tier(self):
        big = _op("Shape Through Hole big endmill", "big", 0.6)
        regular = _op("Shape Through Hole", "regular", 0.4)
        small = _op("Small Shape Through Hole", "small", 0.4)

        target = next_smaller_through_roughing_op(big, [big, regular, small])

        self.assertIs(target, regular)

    def test_does_not_claim_a_same_size_or_larger_tier_is_a_fallback(self):
        source = _op("Shape Through Hole", "source", 0.4)
        same_size = _op("Small Shape Through Hole", "same", 0.4)
        larger = _op("Shape Through Hole big endmill", "larger", 0.6)

        self.assertIsNone(
            next_smaller_through_roughing_op(source, [source, same_size, larger])
        )

    def test_moves_an_empty_big_tier_chains_to_the_detail_tier(self):
        class _Selections:
            def __init__(self, chains):
                self.entries = list(chains)

            @property
            def count(self):
                return len(self.entries)

            def item(self, index):
                return self.entries[index]

            def clear(self):
                self.entries.clear()

            def createNewChainSelection(self):
                chain = types.SimpleNamespace(
                    inputGeometry=None, isOpen=None, isReverted=None
                )
                self.entries.append(chain)
                return chain

        def _roughing_op(name, operation_id, diameter, selections, warning=""):
            tool = _tool(diameter)
            applied = []
            deleted = []
            value = types.SimpleNamespace(
                getCurveSelections=lambda: selections,
                applyCurveSelections=lambda selected: applied.append(selected),
            )
            op = types.SimpleNamespace(
                name=name,
                operationId=operation_id,
                strategy="adaptive2d",
                warning=warning,
                tool=tool,
                parameters=types.SimpleNamespace(
                    itemByName=lambda param_name: (
                        types.SimpleNamespace(value=value) if param_name == "pockets" else None
                    )
                ),
                deleteMe=lambda: deleted.append(operation_id),
            )
            return op, applied, deleted

        existing_edge = object()
        rejected_big_edge = object()
        regular_selections = _Selections(
            [types.SimpleNamespace(inputGeometry=[existing_edge], isOpen=False, isReverted=True)]
        )
        big_selections = _Selections(
            [types.SimpleNamespace(inputGeometry=[rejected_big_edge], isOpen=False, isReverted=False)]
        )
        big, _big_applied, big_deleted = _roughing_op(
            "Shape Through Hole big endmill", "big", 0.6, big_selections,
            "Generated toolpath is empty.",
        )
        regular, regular_applied, _regular_deleted = _roughing_op(
            "Shape Through Hole", "regular", 0.4, regular_selections
        )

        rerouted = reroute_empty_through_roughing(
            types.SimpleNamespace(operations=[big, regular])
        )

        self.assertEqual(rerouted, ["Shape Through Hole big endmill -> Shape Through Hole"])
        self.assertEqual(big_deleted, ["big"])
        self.assertEqual(regular_applied, [regular_selections])
        self.assertEqual(regular_selections.count, 2)
        self.assertEqual(regular_selections.item(0).inputGeometry, [existing_edge])
        self.assertTrue(regular_selections.item(0).isReverted)
        self.assertEqual(regular_selections.item(1).inputGeometry, [rejected_big_edge])
        self.assertFalse(regular_selections.item(1).isReverted)

    def test_restores_finishing_coverage_after_a_tier_was_pruned(self):
        class _Selections:
            def __init__(self, chains):
                self.entries = list(chains)

            @property
            def count(self):
                return len(self.entries)

            def item(self, index):
                return self.entries[index]

            def clear(self):
                self.entries.clear()

            def createNewChainSelection(self):
                chain = types.SimpleNamespace(
                    inputGeometry=None, isOpen=None, isReverted=None
                )
                self.entries.append(chain)
                return chain

        def _edge(token):
            return types.SimpleNamespace(entityToken=token)

        def _op(name, strategy, diameter, selections, selection_parameter):
            applied = []
            value = types.SimpleNamespace(
                getCurveSelections=lambda: selections,
                applyCurveSelections=lambda selected: applied.append(selected),
            )
            parameter = types.SimpleNamespace(value=value)
            return (
                types.SimpleNamespace(
                    name=name,
                    strategy=strategy,
                    tool=_tool(diameter) if diameter is not None else None,
                    parameters=types.SimpleNamespace(
                        itemByName=lambda parameter_name: (
                            parameter if parameter_name == selection_parameter else None
                        )
                    ),
                ),
                applied,
            )

        covered_edge = _edge("covered")
        finish_only_edge = _edge("finish-only")
        roughing_selections = _Selections(
            [types.SimpleNamespace(inputGeometry=[covered_edge], isOpen=False, isReverted=True)]
        )
        finishing_selections = _Selections([
            types.SimpleNamespace(inputGeometry=[covered_edge], isOpen=False, isReverted=True),
            types.SimpleNamespace(inputGeometry=[finish_only_edge], isOpen=False, isReverted=False),
        ])
        roughing, roughing_applied = _op(
            "Shape Through Hole", "adaptive2d", 0.4, roughing_selections, "pockets"
        )
        finishing, _finishing_applied = _op(
            "Shape Through Finishing Pass", "contour2d", None, finishing_selections, "contours"
        )

        reconciled = reconcile_through_roughing_coverage(
            types.SimpleNamespace(operations=[roughing, finishing])
        )

        self.assertEqual(reconciled, ["1 finishing chain(s) -> Shape Through Hole"])
        self.assertEqual(roughing_applied, [roughing_selections])
        self.assertEqual(roughing_selections.count, 2)
        self.assertEqual(roughing_selections.item(1).inputGeometry, [finish_only_edge])
        self.assertFalse(roughing_selections.item(1).isReverted)


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

    def test_splits_purely_by_diameter_even_without_a_small_named_op(self):
        # The split no longer depends on a "small"-named op existing at
        # all - two non-"small"-named ops with genuinely different tool
        # diameters must still split (the bigger one taking whatever it
        # can reach, the smaller one the rest), not silently duplicate.
        op_a = _op("Shape Through Hole", "a", tool_diameter_cm=0.635)
        op_b = _op("Shape Through Hole big endmill", "b", tool_diameter_cm=0.95)
        narrow = _entry("f1", 0.3)
        wide = _entry("f2", 2.0)

        assignments = split_through_roughing_ops([op_a, op_b], [narrow, wide])

        self.assertEqual(assignments["a"], [("f1", False)])
        self.assertEqual(assignments["b"], [("f2", False)])

    def test_falls_back_to_giving_every_op_every_chain_with_a_single_roughing_op(self):
        # Nothing to split against with only one roughing op at all - it
        # must get every chain, the same as before this split existed.
        only_op = _op("Shape Through Hole", "only")
        entries = [_entry("f1", 0.3), _entry("f2", 2.0)]

        assignments = split_through_roughing_ops([only_op], entries)

        self.assertEqual(assignments["only"], [("f1", False), ("f2", False)])

    def test_falls_back_when_a_roughing_ops_tool_diameter_cannot_be_read(self):
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
        # Real, confirmed live bug: the New Router's real template has
        # THREE "through"-named roughing ops - "Shape Through Hole big
        # endmill", "Shape Through Hole", and "Small Shape Through Hole" -
        # and the old 2-way (small vs. everything-else) split lumped the
        # two non-"small" ones into one bucket, so BOTH got the exact same
        # full "wide" chain, computing the identical adaptive-clearing
        # roughing pass twice with two different tools. Each chain must go
        # to exactly one op: the LARGEST one that can still fit it, so
        # "wide" belongs to big_endmill alone and "main" is legitimately
        # left with nothing to do on this part.
        big_endmill = _op("Shape Through Hole big endmill", "big_endmill", tool_diameter_cm=0.95)
        main = _op("Shape Through Hole", "main", tool_diameter_cm=0.635)
        small = _op("Small Shape Through Hole", "small", tool_diameter_cm=0.15)
        narrow = _entry("narrow", 0.3)
        wide = _entry("wide", 2.0)

        assignments = split_through_roughing_ops([big_endmill, main, small], [narrow, wide])

        self.assertEqual(assignments["small"], [("narrow", False)])
        self.assertEqual(assignments["main"], [])
        self.assertEqual(assignments["big_endmill"], [("wide", False)])

    def test_a_mid_sized_feature_goes_to_the_middle_tier_not_the_biggest(self):
        # A feature too tight for the biggest tool but roomy enough for
        # the middle one must land on the middle tier specifically - not
        # fall through to the biggest (which can't fit) or the smallest
        # (wasteful when a bigger, still-fitting tool is available).
        big_endmill = _op("Shape Through Hole big endmill", "big_endmill", tool_diameter_cm=0.95)
        main = _op("Shape Through Hole", "main", tool_diameter_cm=0.635)
        small = _op("Small Shape Through Hole", "small", tool_diameter_cm=0.15)
        # Clears main's threshold (0.635 * 1.5 = 0.9525) but not
        # big_endmill's (0.95 * 1.5 = 1.425).
        mid = _entry("mid", 1.0)

        assignments = split_through_roughing_ops([big_endmill, main, small], [mid])

        self.assertEqual(assignments["main"], [("mid", False)])
        self.assertEqual(assignments["big_endmill"], [])
        self.assertEqual(assignments["small"], [])

    def test_uses_regular_not_big_when_the_big_helix_cannot_enter(self):
        # Regression for angad_part: its opening was large enough for the
        # 6 mm cutter under the former 1.5x rule, but not large enough for
        # the template's 5.7 mm helical entry. Fusion accepted the chain yet
        # generated an empty big-endmill toolpath. The regular 4 mm tier's
        # smaller entry envelope must own this feature instead.
        big = _op("Shape Through Hole big endmill", "big", 0.6, helical_ramp_cm=0.57)
        regular = _op("Shape Through Hole", "regular", 0.4, helical_ramp_cm=0.37)
        small = _op("Small Shape Through Hole", "small", 0.4, helical_ramp_cm=0.127)

        assignments = split_through_roughing_ops(
            [big, regular, small], [_entry("angad-through-shape", 1.0)]
        )

        self.assertEqual(assignments["big"], [])
        self.assertEqual(assignments["regular"], [("angad-through-shape", False)])
        self.assertEqual(assignments["small"], [])


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


class LoopMinimumClearanceTests(unittest.TestCase):
    @staticmethod
    def _edge(start, end):
        start_point = types.SimpleNamespace(x=float(start[0]), y=float(start[1]))
        end_point = types.SimpleNamespace(x=float(end[0]), y=float(end[1]))
        midpoint = types.SimpleNamespace(
            x=(start[0] + end[0]) / 2,
            y=(start[1] + end[1]) / 2,
        )
        return types.SimpleNamespace(
            startVertex=types.SimpleNamespace(geometry=start_point),
            endVertex=types.SimpleNamespace(geometry=end_point),
            pointOnEdge=midpoint,
        )

    def test_uses_actual_rotated_footprint_not_axis_aligned_box(self):
        # This diamond has a 2 cm x 2 cm axis-aligned box, but only sqrt(2)
        # cm of clearance normal to each side. A big adaptive entry must not
        # be selected merely because the bounding box reads 2 cm wide.
        vertices = [(0, 1), (1, 2), (2, 1), (1, 0)]
        edges = [
            self._edge(vertices[index], vertices[(index + 1) % len(vertices)])
            for index in range(len(vertices))
        ]

        self.assertAlmostEqual(loop_min_dimension_cm(edges), 2.0)
        self.assertAlmostEqual(loop_min_clearance_cm(edges), 2 ** 0.5)

    def test_falls_back_to_bounding_box_when_only_a_line_is_readable(self):
        edge = self._edge((0, 0), (5, 2))
        self.assertAlmostEqual(loop_min_clearance_cm([edge]), 2.0)


if __name__ == "__main__":
    unittest.main()
