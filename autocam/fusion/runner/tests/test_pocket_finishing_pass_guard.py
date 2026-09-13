"""_require_pocket_finishing_pass_pairing enforces a direct instruction:
"a pocket through should always be accompanied by a pocket finishing
pass" - a Shape Pocket (adaptive2d) can only exist if there is a Shape
Pocket Finishing Pass (contour2d) in the same setup with the exact same
geometry selection, and vice versa. Mirrors
test_through_hole_finishing_pass_guard.py exactly, scoped to pockets
instead of through-holes.

Mirrors test_release_contour_guard.py's isolation-loading pattern:
camPlate.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded by slicing it out of the source rather than
importing the whole module.
"""

import types
from pathlib import Path
import unittest


def _load_require_pocket_finishing_pass_pairing():
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("def _require_pocket_finishing_pass_pairing")
    end = source.index("def _coverage_warnings")
    namespace = {}
    exec(
        compile(source[start:end], "camPlate_require_pocket_finishing_pass_pairing", "exec"),
        namespace,
    )
    return namespace["_require_pocket_finishing_pass_pairing"]


require_pocket_finishing_pass_pairing = _load_require_pocket_finishing_pass_pairing()


def _edge(token):
    return types.SimpleNamespace(entityToken=token)


def _chain(*edge_tokens):
    return types.SimpleNamespace(inputGeometry=[_edge(t) for t in edge_tokens])


def _selection_value(*chains):
    return types.SimpleNamespace(getCurveSelections=lambda: list(chains))


def _op(name, strategy, edges=None):
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


class RequirePocketFinishingPassPairingTests(unittest.TestCase):
    def test_passes_when_a_pocket_has_a_finishing_partner(self):
        cam = _cam(
            _op("Shape Pocket", "adaptive2d"),
            _op("Shape Pocket Finishing Pass", "contour2d"),
        )
        require_pocket_finishing_pass_pairing(cam)  # must not raise

    def test_raises_when_the_finishing_pass_has_no_roughing_partner(self):
        cam = _cam(_op("Shape Pocket Finishing Pass", "contour2d"))
        with self.assertRaises(RuntimeError):
            require_pocket_finishing_pass_pairing(cam)

    def test_raises_when_only_the_roughing_operation_exists(self):
        cam = _cam(_op("Shape Pocket", "adaptive2d"))
        with self.assertRaises(RuntimeError):
            require_pocket_finishing_pass_pairing(cam)

    def test_passes_when_neither_operation_exists(self):
        cam = _cam(_op("2D Slot Cut", "contour2d"), _op("Shape Through Hole", "adaptive2d"))
        require_pocket_finishing_pass_pairing(cam)  # must not raise

    def test_excludes_the_dedicated_circular_pocket_operation(self):
        # ">.3 Circular Pocket" is a pocket2d op with its own dedicated
        # hole-recognition machinery, not this generic pair - the
        # "circular" exclusion must keep it out entirely, in both
        # directions.
        cam = _cam(
            _op(">.3 Circular Pocket", "pocket2d"),
            _op("Shape Pocket Finishing Pass", "contour2d"),
        )
        with self.assertRaises(RuntimeError):
            require_pocket_finishing_pass_pairing(cam)

    def test_checks_each_setup_independently(self):
        setup_a = types.SimpleNamespace(
            operations=[
                _op("Shape Pocket", "adaptive2d"),
                _op("Shape Pocket Finishing Pass", "contour2d"),
            ]
        )
        setup_b = types.SimpleNamespace(operations=[_op("Shape Pocket Finishing Pass", "contour2d")])
        cam = types.SimpleNamespace(setups=[setup_a, setup_b])
        with self.assertRaises(RuntimeError):
            require_pocket_finishing_pass_pairing(cam)

    def test_does_nothing_when_cam_is_none(self):
        require_pocket_finishing_pass_pairing(None)  # must not raise

    # --- Geometry-coverage tests -------------------------------------

    def test_passes_when_roughing_geometry_exactly_matches_finishing(self):
        cam = _cam(
            _op("Shape Pocket", "adaptive2d", edges=["e1", "e2"]),
            _op("Shape Pocket Finishing Pass", "contour2d", edges=["e1", "e2"]),
        )
        require_pocket_finishing_pass_pairing(cam)  # must not raise

    def test_raises_when_finishing_traces_an_edge_nothing_roughed(self):
        cam = _cam(
            _op("Shape Pocket", "adaptive2d", edges=["e1"]),
            _op("Shape Pocket Finishing Pass", "contour2d", edges=["e1", "e2"]),
        )
        with self.assertRaises(RuntimeError):
            require_pocket_finishing_pass_pairing(cam)

    def test_raises_when_roughing_covers_more_than_finishing_needs(self):
        cam = _cam(
            _op("Shape Pocket", "adaptive2d", edges=["e1", "e2", "e3"]),
            _op("Shape Pocket Finishing Pass", "contour2d", edges=["e1", "e2"]),
        )
        with self.assertRaises(RuntimeError):
            require_pocket_finishing_pass_pairing(cam)

    def test_skips_geometry_check_when_selection_is_unreadable(self):
        cam = _cam(
            _op("Shape Pocket", "adaptive2d"),
            _op("Shape Pocket Finishing Pass", "contour2d"),
        )
        require_pocket_finishing_pass_pairing(cam)  # must not raise


if __name__ == "__main__":
    unittest.main()
