"""Real, confirmed live crash: a through-shape roughing operation whose own
split bucket comes up empty (_split_through_roughing_ops's own docstring:
"empty on a part with nothing genuinely narrow is correct, not a bug") left
_repair_missing_selections's `selections` collection with zero entries, and
Fusion's real applyCurveSelections() does not tolerate that - it throws
"3 : Do not have valid curve selections." outright, not the soft empty-
toolpath outcome every other branch in this function already guards against
(is_big_hole_op, is_dedicated_circular_pocket_op, and the generic pocket
branch all fall back to PocketRecognitionSelection when nothing matches;
is_outer and is_through_shape_op did not).

DeleteToolpaths.py imports Fusion's runtime-only modules at import time, so
_repair_missing_selections is loaded in isolation (with a fake `adsk` and
stubbed design-walking helpers) rather than by importing the whole module -
same pattern as test_through_roughing_split.py and test_operation_warnings.py.
"""

import types
from pathlib import Path
import unittest


def _load_repair_missing_selections():
    source = (Path(__file__).parents[1] / "commands/DeleteToolpaths.py").read_text()
    start = source.index("_POCKET_STRATEGIES = (")
    end = source.index("\ndef _cap_other_way_feedrate")
    namespace = {
        "adsk": types.SimpleNamespace(
            core=types.SimpleNamespace(
                Application=types.SimpleNamespace(
                    get=lambda: types.SimpleNamespace(
                        activeDocument=types.SimpleNamespace(
                            products=types.SimpleNamespace(
                                itemByProductType=lambda kind: "fake-design-product"
                            )
                        )
                    )
                )
            ),
            fusion=types.SimpleNamespace(Design=types.SimpleNamespace(cast=lambda p: "fake-design")),
        ),
    }
    exec(compile(source[start:end], "DeleteToolpaths_repair_missing_selections", "exec"), namespace)
    return namespace


class FakeCurveSelections:
    def __init__(self):
        self.entries = []

    @property
    def count(self):
        return len(self.entries)

    def clear(self):
        self.entries = []

    def createNewChainSelection(self):
        chain = types.SimpleNamespace(isOpen=None, isReverted=None, inputGeometry=None)
        self.entries.append(chain)
        return chain

    def createNewPocketRecognitionSelection(self):
        recognition = types.SimpleNamespace()
        self.entries.append(recognition)
        return recognition


def _through_shape_op(name="Small Shape Through Hole", strategy="adaptive2d", operation_id="op1"):
    deleted = []
    apply_calls = []
    selections = FakeCurveSelections()
    curve_selection_value = types.SimpleNamespace(
        getCurveSelections=lambda: selections,
        applyCurveSelections=lambda sel: apply_calls.append(sel),
    )
    curve_selection_param = types.SimpleNamespace(value=curve_selection_value)

    def itemByName(param_name):
        return curve_selection_param if param_name == "pockets" else None

    op = types.SimpleNamespace(
        strategy=strategy,
        name=name,
        operationId=operation_id,
        parameters=types.SimpleNamespace(itemByName=itemByName),
        deleteMe=lambda: deleted.append(operation_id),
    )
    return op, deleted, apply_calls


class RepairMissingSelectionsEmptyThroughBucketTests(unittest.TestCase):
    def test_a_through_shape_op_with_an_empty_split_bucket_is_deleted_not_crashed(self):
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        op, deleted, apply_calls = _through_shape_op()
        setup = types.SimpleNamespace(operations=[op])

        # This part has SOME through-shape geometry overall (so the
        # through_shape_ops branch is taken at all), but the split routes
        # none of it to this specific (e.g. "small") roughing operation -
        # exactly _split_through_roughing_ops's own documented "empty is
        # correct" outcome for an operation that doesn't apply here.
        namespace["_internal_feature_loop_chains_all_bodies"] = (
            lambda design: ([(types.SimpleNamespace(), False, 0.1)], [])
        )
        namespace["_split_through_roughing_ops"] = (
            lambda roughing_ops, shape_only: {op.operationId: []}
        )

        repaired = repair_missing_selections(setup)

        self.assertEqual(apply_calls, [])
        self.assertEqual(deleted, ["op1"])
        self.assertTrue(any("removed" in entry for entry in repaired))

    def test_a_through_shape_op_with_a_non_empty_bucket_still_applies_normally(self):
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        op, deleted, apply_calls = _through_shape_op()
        setup = types.SimpleNamespace(operations=[op])
        seed_edge = types.SimpleNamespace()

        namespace["_internal_feature_loop_chains_all_bodies"] = (
            lambda design: ([(seed_edge, False, 2.0)], [])
        )
        namespace["_split_through_roughing_ops"] = (
            lambda roughing_ops, shape_only: {op.operationId: [(seed_edge, False)]}
        )

        repaired = repair_missing_selections(setup)

        self.assertEqual(len(apply_calls), 1)
        self.assertEqual(deleted, [])
        self.assertIn(op.name, repaired)


if __name__ == "__main__":
    unittest.main()
