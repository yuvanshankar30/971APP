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

    selection_param_name = "contours" if strategy == "contour2d" else "pockets"

    def itemByName(param_name):
        return curve_selection_param if param_name == selection_param_name else None

    op = types.SimpleNamespace(
        strategy=strategy,
        name=name,
        operationId=operation_id,
        parameters=types.SimpleNamespace(itemByName=itemByName),
        deleteMe=lambda: deleted.append(operation_id),
    )
    op._selections = selections
    return op, deleted, apply_calls


class _StaleAfterDeleteOp:
    """A fake operation whose ``.strategy`` raises like a real deleted
    Fusion operation's would - simulating a stale "iron object" handle
    after deleteMe(), unlike types.SimpleNamespace's plain attributes
    (which stay readable forever, unable to catch a bug where code reads
    an operation after it was deleted).
    """

    def __init__(self, name, strategy, operation_id, selections, param_name):
        self.name = name
        self._strategy = strategy
        self._operation_id = operation_id
        self._deleted = False
        param = types.SimpleNamespace(
            value=types.SimpleNamespace(
                getCurveSelections=lambda: selections,
                applyCurveSelections=lambda sel: None,
            )
        )

        def itemByName(n):
            return param if n == param_name else None

        self.parameters = types.SimpleNamespace(itemByName=itemByName)

    @property
    def strategy(self):
        if self._deleted:
            raise RuntimeError('2 : InternalValidationError : ironObject.isValid()')
        return self._strategy

    @property
    def operationId(self):
        if self._deleted:
            raise RuntimeError('2 : InternalValidationError : ironObject.isValid()')
        return self._operation_id

    def deleteMe(self):
        self._deleted = True


class RepairMissingSelectionsDeletionOrderingTests(unittest.TestCase):
    def test_an_empty_selection_op_stays_valid_until_every_op_has_been_processed(self):
        # Real, confirmed live crash: deleting an empty-selection op INSIDE
        # the main loop (instead of deferring, like inactive_finishing_ops
        # already does) left it stale by the time a LATER op's own
        # generic-pocket branch re-scanned all of ops_snapshot (see
        # claimed_diameters_cm) - reading .strategy off that now-deleted
        # handle raised "2 : InternalValidationError : ironObject.isValid()"
        # and crashed the whole job.
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        namespace["_internal_feature_loop_chains_all_bodies"] = (
            lambda design: ([(types.SimpleNamespace(), False, 0.1)], [])
        )
        namespace["_blind_pocket_loops_all_bodies"] = lambda design: ([], [])

        through_op_id = "small-through"
        empty_selections = FakeCurveSelections()
        through_op = _StaleAfterDeleteOp(
            "Small Shape Through Hole", "adaptive2d", through_op_id, empty_selections, "pockets"
        )
        namespace["_split_through_roughing_ops"] = (
            lambda roughing_ops, shape_only: {through_op_id: []}
        )

        pocket_op = _StaleAfterDeleteOp(
            "Generic Pocket", "pocket_new", "generic-pocket", FakeCurveSelections(), "pockets"
        )

        setup = types.SimpleNamespace(operations=[through_op, pocket_op])

        repaired = repair_missing_selections(setup)  # must not raise

        self.assertTrue(through_op._deleted)
        self.assertFalse(pocket_op._deleted)
        self.assertTrue(any("removed" in entry for entry in repaired))

    def test_cleanup_never_reads_a_feature_slot_operation_after_deleting_it(self):
        # A feature-slot contour is classified both as an inactive contour
        # and as a disabled feature-slot op. Fusion invalidates all property
        # access after deleteMe(), including operationId.
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        feature_slot = _StaleAfterDeleteOp(
            "Slot Cut for Features", "contour2d", "feature-slot", FakeCurveSelections(), "contours"
        )

        repair_missing_selections(types.SimpleNamespace(operations=[feature_slot]))

        self.assertTrue(feature_slot._deleted)


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

    def test_shape_through_pair_receives_the_same_chain_seed_and_direction(self):
        # Fusion resolves a chain seed to the full closed loop. Both sides
        # must receive that exact seed and direction; adaptive2d cannot
        # reliably generate from a complete imported edge list.
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        roughing, roughing_deleted, roughing_apply_calls = _through_shape_op(
            "Shape Through Hole big endmill", operation_id="roughing"
        )
        finishing, finishing_deleted, finishing_apply_calls = _through_shape_op(
            "Shape Through Finishing Pass", strategy="contour2d", operation_id="finishing"
        )
        seed_edge = types.SimpleNamespace()
        namespace["_internal_feature_loop_chains_all_bodies"] = (
            lambda design: ([(seed_edge, True, 2.0)], [])
        )
        namespace["_split_through_roughing_ops"] = (
            lambda roughing_ops, shape_only: {"roughing": [(seed_edge, True)]}
        )

        repair_missing_selections(types.SimpleNamespace(operations=[roughing, finishing]))

        self.assertEqual(roughing_deleted, [])
        self.assertEqual(finishing_deleted, [])
        self.assertEqual(len(roughing_apply_calls), 1)
        self.assertEqual(len(finishing_apply_calls), 1)
        self.assertEqual(roughing._selections.entries[0].inputGeometry, [seed_edge])
        self.assertEqual(finishing._selections.entries[0].inputGeometry, [seed_edge])
        self.assertTrue(roughing._selections.entries[0].isReverted)
        self.assertTrue(finishing._selections.entries[0].isReverted)

    def test_feature_slot_operation_is_removed_without_receiving_geometry(self):
        # Feature-slot cuts are intentionally unused. Every non-circular
        # through feature goes through the matched Shape Through Hole and
        # Shape Through Finishing Pass operations instead.
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        feature_slot, deleted, apply_calls = _through_shape_op(
            "Slot Cut for Features", strategy="contour2d", operation_id="feature-slot"
        )
        namespace["_internal_feature_loop_chains_all_bodies"] = lambda design: ([], [])

        repaired = repair_missing_selections(types.SimpleNamespace(operations=[feature_slot]))

        self.assertEqual(apply_calls, [])
        self.assertEqual(deleted, ["feature-slot"])
        self.assertTrue(any("removed unused contour pass" in entry for entry in repaired))

    def test_shape_pocket_pair_receives_the_same_chain_seed_and_direction(self):
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        roughing, roughing_deleted, roughing_apply_calls = _through_shape_op(
            "Shape Pocket", operation_id="pocket-roughing"
        )
        finishing, finishing_deleted, finishing_apply_calls = _through_shape_op(
            "Shape Pocket Finishing Pass", strategy="contour2d", operation_id="pocket-finishing"
        )
        floor_seed = types.SimpleNamespace()
        namespace["_blind_pocket_loops_all_bodies"] = lambda design: ([], [(floor_seed, True)])

        repair_missing_selections(types.SimpleNamespace(operations=[roughing, finishing]))

        self.assertEqual(roughing_deleted, [])
        self.assertEqual(finishing_deleted, [])
        self.assertEqual(len(roughing_apply_calls), 1)
        self.assertEqual(len(finishing_apply_calls), 1)
        self.assertEqual(roughing._selections.entries[0].inputGeometry, [floor_seed])
        self.assertEqual(finishing._selections.entries[0].inputGeometry, [floor_seed])
        self.assertTrue(roughing._selections.entries[0].isReverted)
        self.assertTrue(finishing._selections.entries[0].isReverted)

    def test_unpaired_shape_pocket_operations_are_removed_together(self):
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]
        roughing, roughing_deleted, roughing_apply_calls = _through_shape_op(
            "Shape Pocket", operation_id="pocket-roughing"
        )
        namespace["_blind_pocket_loops_all_bodies"] = lambda design: ([], [([types.SimpleNamespace()], False)])

        repaired = repair_missing_selections(types.SimpleNamespace(operations=[roughing]))

        self.assertEqual(roughing_apply_calls, [])
        self.assertEqual(roughing_deleted, ["pocket-roughing"])
        self.assertTrue(any("removed unused pocket pair operation" in entry for entry in repaired))


class ThroughShapeOpsExcludesBoreStrategyTests(unittest.TestCase):
    def test_a_misspelled_circluar_bore_op_never_gets_a_shape_chain(self):
        # Real, confirmed live crash (via direct Fusion introspection on a
        # real running document, not guesswork): a real template's own
        # small-hole bore operation is misspelled "Circluar" (not
        # "Circular"), so through_shape_ops's purely name-based
        # "circular" not in name check let it straight through as a
        # "through shape" op. It then got reclassified as a roughing
        # candidate (bore != contour2d) in _split_through_roughing_ops and
        # had an arbitrary internal feature's rectangular ChainSelection
        # assigned to it instead of its own real circular-hole geometry -
        # meanwhile that rectangular feature never got a real roughing
        # pass of its own. DeleteToolpaths.py now also excludes
        # strategy == "bore" outright, independent of any name spelling.
        namespace = _load_repair_missing_selections()
        repair_missing_selections = namespace["_repair_missing_selections"]

        bore_op, bore_deleted, bore_apply_calls = _through_shape_op(
            name="<.3 Circluar Through Hole", strategy="bore", operation_id="bore1"
        )
        # This op's own selection already looks "healthy" (non-empty, no
        # warnings) so the plain _needs_repair fallback branch (the one a
        # correctly-excluded bore op should land in) skips it outright -
        # proving it was never routed into the through-shape/roughing
        # machinery at all, not just that it happened to get an empty
        # split bucket.
        bore_op.parameters.itemByName("pockets").value.getCurveSelections().entries.append(
            types.SimpleNamespace(hasWarning=False)
        )

        shape_op, shape_deleted, shape_apply_calls = _through_shape_op(
            name="Shape Through Hole", strategy="adaptive2d", operation_id="shape1"
        )

        setup = types.SimpleNamespace(operations=[bore_op, shape_op])

        namespace["_internal_feature_loop_chains_all_bodies"] = (
            lambda design: ([(types.SimpleNamespace(), False, 2.0)], [])
        )
        roughing_calls = []

        def _fake_split(roughing_ops, shape_only):
            roughing_calls.append([op.operationId for op in roughing_ops])
            return {op.operationId: [(types.SimpleNamespace(), False)] for op in roughing_ops}

        namespace["_split_through_roughing_ops"] = _fake_split

        repair_missing_selections(setup)

        self.assertEqual(roughing_calls, [["shape1"]])
        self.assertEqual(bore_apply_calls, [])
        self.assertEqual(bore_deleted, [])


if __name__ == "__main__":
    unittest.main()
