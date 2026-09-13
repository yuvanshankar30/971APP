"""_require_through_hole_for_finishing_pass enforces a direct instruction: a
Shape Through Finishing Pass (contour2d) can only exist if there is a
Shape Through Hole roughing operation (adaptive2d, or one of its
size-tiered siblings) in the same setup with the exact same geometry
selection, and vice versa - neither is ever valid alone, and "same
geometry selection" means exactly that, not merely "some overlap."

Mirrors test_release_contour_guard.py's isolation-loading pattern:
camPlate.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded by slicing it out of the source rather than
importing the whole module.
"""

import types
from pathlib import Path
import unittest


def _load_require_through_hole_for_finishing_pass():
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("def _require_through_hole_for_finishing_pass")
    end = source.index("def _coverage_warnings")
    namespace = {}
    exec(
        compile(source[start:end], "camPlate_require_through_hole_for_finishing_pass", "exec"),
        namespace,
    )
    return namespace["_require_through_hole_for_finishing_pass"]


require_through_hole_for_finishing_pass = _load_require_through_hole_for_finishing_pass()


def _edge(token):
    return types.SimpleNamespace(entityToken=token)


def _chain(*edge_tokens):
    return types.SimpleNamespace(inputGeometry=[_edge(t) for t in edge_tokens])


def _selection_value(*chains):
    return types.SimpleNamespace(getCurveSelections=lambda: list(chains))


def _op(name, strategy, edges=None):
    """edges=None means "geometry unreadable" (the real code's own
    can't-tell-so-don't-block case) - most tests only care about presence,
    not geometry, so they omit it and get a no-op parameters lookup.
    """
    if edges is None:
        params = types.SimpleNamespace(itemByName=lambda _name: None)
    else:
        param_name = "contours" if strategy == "contour2d" else "pockets"
        value = _selection_value(_chain(*edges))
        param = types.SimpleNamespace(value=value)
        params = types.SimpleNamespace(itemByName=lambda n, p=param, pn=param_name: p if n == pn else None)
    return types.SimpleNamespace(name=name, strategy=strategy, parameters=params)


def _cam(*operations):
    setup = types.SimpleNamespace(operations=list(operations))
    return types.SimpleNamespace(setups=[setup])


class RequireThroughHoleForFinishingPassTests(unittest.TestCase):
    def test_passes_when_a_finishing_pass_has_a_roughing_partner(self):
        cam = _cam(
            _op("Shape Through Hole", "adaptive2d"),
            _op("Shape Through Finishing Pass", "contour2d"),
        )
        require_through_hole_for_finishing_pass(cam)  # must not raise

    def test_raises_when_the_finishing_pass_has_no_roughing_partner(self):
        # The exact scenario the direct instruction calls out: a finishing
        # pass on its own, whether because the template never shipped the
        # roughing op or DeleteToolpaths pruned it for an invalid toolpath.
        cam = _cam(_op("Shape Through Finishing Pass", "contour2d"))
        with self.assertRaises(RuntimeError):
            require_through_hole_for_finishing_pass(cam)

    def test_raises_when_only_the_roughing_operation_exists(self):
        # Symmetric: a roughing pass with no finishing partner leaves the
        # boundary it roughed un-cleaned - equally invalid as the reverse.
        cam = _cam(_op("Shape Through Hole", "adaptive2d"))
        with self.assertRaises(RuntimeError):
            require_through_hole_for_finishing_pass(cam)

    def test_passes_when_neither_operation_exists(self):
        cam = _cam(_op("2D Slot Cut", "contour2d"), _op("Shape Pocket", "adaptive2d"))
        require_through_hole_for_finishing_pass(cam)  # must not raise

    def test_matches_any_through_roughing_tier(self):
        for name in ("Shape Through Hole", "Small Shape Through Hole", "Shape Through Hole big endmill"):
            with self.subTest(name=name):
                cam = _cam(
                    _op(name, "adaptive2d"),
                    _op("Shape Through Finishing Pass", "contour2d"),
                )
                require_through_hole_for_finishing_pass(cam)  # must not raise

    def test_unrelated_operations_do_not_mask_a_missing_roughing_partner(self):
        # A release cut and an unrelated pocket sitting in the same setup
        # must not be mistaken for the through-shape roughing op.
        cam = _cam(
            _op("Slot Cut for Edges", "contour2d"),
            _op("Shape Pocket", "adaptive2d"),
            _op("Shape Through Finishing Pass", "contour2d"),
        )
        with self.assertRaises(RuntimeError):
            require_through_hole_for_finishing_pass(cam)

    def test_excludes_dedicated_circular_hole_operations(self):
        # "<.3 Circular Through Hole" is a bore op for round holes, not a
        # shape roughing/finishing pair - the "circular" exclusion (same
        # filter as DeleteToolpaths.py's through_shape_ops) must keep it
        # out of this check entirely, in both directions.
        cam = _cam(
            _op("<.3 Circular Through Hole", "bore"),
            _op("Shape Through Finishing Pass", "contour2d"),
        )
        with self.assertRaises(RuntimeError):
            require_through_hole_for_finishing_pass(cam)

    def test_checks_each_setup_independently(self):
        # A different, fully-paired-and-matching setup must not mask a
        # violation in another setup - one setup's roughing op is never
        # treated as covering a different setup's finishing pass.
        setup_a = types.SimpleNamespace(
            operations=[
                _op("Shape Through Hole", "adaptive2d"),
                _op("Shape Through Finishing Pass", "contour2d"),
            ]
        )
        setup_b = types.SimpleNamespace(operations=[_op("Shape Through Finishing Pass", "contour2d")])
        cam = types.SimpleNamespace(setups=[setup_a, setup_b])
        with self.assertRaises(RuntimeError):
            require_through_hole_for_finishing_pass(cam)

    def test_does_nothing_when_cam_is_none(self):
        require_through_hole_for_finishing_pass(None)  # must not raise

    # --- Geometry-coverage tests -------------------------------------

    def test_passes_when_roughing_geometry_exactly_matches_finishing(self):
        cam = _cam(
            _op("Shape Through Hole", "adaptive2d", edges=["e1", "e2"]),
            _op("Shape Through Finishing Pass", "contour2d", edges=["e1", "e2"]),
        )
        require_through_hole_for_finishing_pass(cam)  # must not raise

    def test_passes_when_multiple_roughing_tiers_together_cover_finishing(self):
        # _split_through_roughing_ops spreads chains across tiers by tool
        # reach - the union across tiers is what has to match, not any
        # single tier alone.
        cam = _cam(
            _op("Shape Through Hole", "adaptive2d", edges=["e1"]),
            _op("Small Shape Through Hole", "adaptive2d", edges=["e2"]),
            _op("Shape Through Finishing Pass", "contour2d", edges=["e1", "e2"]),
        )
        require_through_hole_for_finishing_pass(cam)  # must not raise

    def test_raises_when_finishing_traces_an_edge_nothing_roughed(self):
        # Direct instruction: same geometry selection required, not just
        # co-presence. Real failure mode: a partial chain-assignment
        # failure left the roughing op missing one of the finishing
        # pass's edges.
        cam = _cam(
            _op("Shape Through Hole", "adaptive2d", edges=["e1"]),
            _op("Shape Through Finishing Pass", "contour2d", edges=["e1", "e2"]),
        )
        with self.assertRaises(RuntimeError):
            require_through_hole_for_finishing_pass(cam)

    def test_raises_when_roughing_covers_more_than_finishing_needs(self):
        # "Same geometry selection" means exactly that - a roughing
        # selection broader than the finishing pass's is also a mismatch,
        # not just a narrower one.
        cam = _cam(
            _op("Shape Through Hole", "adaptive2d", edges=["e1", "e2", "e3"]),
            _op("Shape Through Finishing Pass", "contour2d", edges=["e1", "e2"]),
        )
        with self.assertRaises(RuntimeError):
            require_through_hole_for_finishing_pass(cam)

    def test_skips_geometry_check_when_selection_is_unreadable(self):
        # edges=None simulates a real "no getCurveSelections()"/missing
        # parameter case - a can't-tell, not a false-positive mismatch.
        cam = _cam(
            _op("Shape Through Hole", "adaptive2d"),
            _op("Shape Through Finishing Pass", "contour2d"),
        )
        require_through_hole_for_finishing_pass(cam)  # must not raise


if __name__ == "__main__":
    unittest.main()
