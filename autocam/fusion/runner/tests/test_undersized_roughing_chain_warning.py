"""_undersized_roughing_chain_warnings closes a gap neither of this file's
other two coverage checks can see: a chain still correctly SELECTED in a
through-shape roughing tier (satisfies _require_through_hole_for_finishing_pass)
with a G-code loop near it from the finishing pass alone (satisfies
_coverage_warnings' loop-matching) can still have never actually been
cleared, if that tier's own tool is physically too big to enter it.

Confirmed live as a real incident behind this: a real job had a small
triangular lightening feature selected under "Shape Through Hole big
endmill" (a 6mm tool) alongside 21 other, wider chains that DID fit that
tool - Fusion's own isToolpathValid/warning for the whole operation stayed
clean, because it IS valid for those 21 chains. Nothing at the operation
level can see the one outlier.

Mirrors test_release_contour_guard.py's isolation-loading pattern:
camPlate.py imports Fusion's runtime-only modules at import time, so the
function under test (plus the two small helpers defined just above it -
_operation_tool_diameter_cm and _adaptive_entry_clearance_cm) is loaded by
slicing it out of the source rather than importing the whole module.
"""

import types
from pathlib import Path
import unittest


def _load_undersized_roughing_chain_warnings():
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("def _operation_tool_diameter_cm")
    end = source.index("def _coverage_warnings")
    namespace = {}
    exec(compile(source[start:end], "camPlate_undersized_roughing_chain_warnings", "exec"), namespace)
    return namespace["_undersized_roughing_chain_warnings"]


undersized_roughing_chain_warnings = _load_undersized_roughing_chain_warnings()


def _point(x, y):
    return types.SimpleNamespace(x=x, y=y)


def _bbox(min_x, min_y, max_x, max_y):
    return types.SimpleNamespace(minPoint=_point(min_x, min_y), maxPoint=_point(max_x, max_y))


def _edge(min_x, min_y, max_x, max_y):
    return types.SimpleNamespace(boundingBox=_bbox(min_x, min_y, max_x, max_y))


def _square_chain(cx, cy, side_cm):
    half = side_cm / 2
    return types.SimpleNamespace(inputGeometry=[_edge(cx - half, cy - half, cx + half, cy + half)])


def _triangle_chain(vertices):
    # One near-zero-size "edge" per vertex so its bounding-box corners
    # collapse to that single point - gives the corner-point-set a real
    # triangle instead of only ever axis-aligned boxes.
    return types.SimpleNamespace(inputGeometry=[_edge(x, y, x, y) for x, y in vertices])


def _pockets_param(*chains):
    value = types.SimpleNamespace(getCurveSelections=lambda: list(chains))
    return types.SimpleNamespace(value=value)


def _tool(diameter_cm):
    tool_diameter_param = types.SimpleNamespace(value=types.SimpleNamespace(value=diameter_cm))
    return types.SimpleNamespace(parameters=types.SimpleNamespace(
        itemByName=lambda n: tool_diameter_param if n == "tool_diameter" else None
    ))


def _op(name, strategy, tool_diameter_cm=None, chains=None, ramp_diameter_cm=None, ramp_type="helix"):
    """No ramp info (ramp_diameter_cm=None) means the fallback 1.5x-diameter
    clearance rule applies, matching a template with no real ramp
    parameter readable - most tests set a real ramp to exercise the
    documented "helix needs more room than 1.5x" case directly.
    """
    params = {}
    if chains is not None:
        params["pockets"] = _pockets_param(*chains)
    if ramp_type is not None:
        params["rampType"] = types.SimpleNamespace(expression=f"'{ramp_type}'")
    if ramp_diameter_cm is not None:
        params["minimumRampDiameter"] = types.SimpleNamespace(value=types.SimpleNamespace(value=ramp_diameter_cm))
    op = types.SimpleNamespace(
        name=name,
        strategy=strategy,
        parameters=types.SimpleNamespace(itemByName=lambda n: params.get(n)),
    )
    if tool_diameter_cm is not None:
        op.tool = _tool(tool_diameter_cm)
    return op


def _cam(*operations):
    setup = types.SimpleNamespace(operations=list(operations))
    return types.SimpleNamespace(setups=[setup])


class UndersizedRoughingChainWarningTests(unittest.TestCase):
    def test_no_warning_when_every_chain_fits_its_tool(self):
        # A 1cm-wide chain on a 0.4cm tool with no ramp info (1.5x fallback
        # -> 0.6cm required) clears comfortably.
        op = _op("Shape Through Hole", "adaptive2d", tool_diameter_cm=0.4, chains=[_square_chain(5, 5, 1.0)])
        cam = _cam(op)
        self.assertEqual(undersized_roughing_chain_warnings(cam), [])

    def test_warns_when_a_chain_is_narrower_than_the_fallback_clearance(self):
        # 0.5cm chain on a 0.6cm tool, no ramp info -> needs 0.9cm (1.5x) -
        # provably too tight.
        op = _op("Shape Through Hole big endmill", "adaptive2d", tool_diameter_cm=0.6, chains=[_square_chain(1.2, 3.4, 0.5)])
        cam = _cam(op)
        warnings = undersized_roughing_chain_warnings(cam)
        self.assertEqual(len(warnings), 1)
        self.assertIn("Shape Through Hole big endmill", warnings[0])

    def test_warns_using_the_real_ramp_diameter_not_just_1_5x(self):
        # The exact confirmed incident: a 0.6cm tool with a real 0.57cm
        # ramp needs 0.6+0.57=1.17cm to enter - a 1.0cm chain clears the
        # naive 1.5x rule (0.9cm) but not the real ramp-based clearance.
        op = _op(
            "Shape Through Hole big endmill", "adaptive2d",
            tool_diameter_cm=0.6, ramp_diameter_cm=0.57,
            chains=[_square_chain(0, 0, 1.0)],
        )
        cam = _cam(op)
        warnings = undersized_roughing_chain_warnings(cam)
        self.assertEqual(len(warnings), 1)

    def test_no_warning_when_ramp_type_is_not_helix(self):
        # _adaptive_entry_clearance_cm only trusts the ramp diameter for a
        # real helical ramp - any other ramp type falls back to the plain
        # 1.5x rule, same as no ramp info at all.
        op = _op(
            "Shape Through Hole big endmill", "adaptive2d",
            tool_diameter_cm=0.4, ramp_diameter_cm=5.0, ramp_type="plunge",
            chains=[_square_chain(0, 0, 1.0)],
        )
        cam = _cam(op)
        self.assertEqual(undersized_roughing_chain_warnings(cam), [])

    def test_ignores_the_finishing_pass(self):
        # contour2d (the finishing pass) has no tool-entry problem to check -
        # see _adaptive_entry_clearance_cm's own docstring.
        op = _op("Shape Through Finishing Pass", "contour2d", tool_diameter_cm=0.6, chains=[_square_chain(0, 0, 0.1)])
        cam = _cam(op)
        self.assertEqual(undersized_roughing_chain_warnings(cam), [])

    def test_ignores_circular_and_bore_operations(self):
        circular = _op(">.3 Circular Through Hole big endmill", "pocket2d", tool_diameter_cm=0.6, chains=[_square_chain(0, 0, 0.1)])
        bore = _op("<.3 Circular Through Hole", "bore", tool_diameter_cm=0.6, chains=[_square_chain(0, 0, 0.1)])
        cam = _cam(circular, bore)
        self.assertEqual(undersized_roughing_chain_warnings(cam), [])

    def test_only_flags_the_one_undersized_chain_among_many_that_fit(self):
        # The exact real scenario: 21 wide chains and 1 narrow one on the
        # same big-endmill operation - only the narrow one is reported.
        wide_chains = [_square_chain(i, i, 2.0) for i in range(21)]
        narrow_chain = _square_chain(50, 50, 0.3)
        op = _op("Shape Through Hole big endmill", "adaptive2d", tool_diameter_cm=0.6, chains=wide_chains + [narrow_chain])
        cam = _cam(op)
        warnings = undersized_roughing_chain_warnings(cam)
        # Exactly one warning proves the 21 wide chains stayed silent and
        # only the narrow outlier tripped the check.
        self.assertEqual(len(warnings), 1)
        self.assertIn("Shape Through Hole big endmill", warnings[0])

    def test_catches_a_triangle_that_a_bare_bounding_box_would_miss(self):
        # Live-confirmed bug: an equilateral triangle's caliper width (its
        # shortest altitude) overstates real clearance vs. its inscribed
        # circle by ~1.5x. side=2 -> altitude=sqrt(3)~=1.732,
        # inradius diameter=2/sqrt(3)~=1.155. A tool needing 1.4cm passes
        # by caliper width alone but must fail by the shape's real
        # inscribed room.
        triangle = [(0, 0), (2, 0), (1, 3 ** 0.5)]
        # tool_diameter_cm chosen so the fallback 1.5x rule lands the
        # required clearance at 1.4cm (between the triangle's inscribed
        # diameter and its caliper width).
        op = _op("Shape Through Hole big endmill", "adaptive2d", tool_diameter_cm=1.4 / 1.5, chains=[_triangle_chain(triangle)], ramp_diameter_cm=None, ramp_type=None)
        cam = _cam(op)
        warnings = undersized_roughing_chain_warnings(cam)
        self.assertEqual(len(warnings), 1)
        self.assertIn("Shape Through Hole big endmill", warnings[0])

    def test_no_tool_diameter_is_a_cant_tell_not_a_warning(self):
        # Matches this file's own convention elsewhere: can't verify is not
        # the same as confirmed wrong, so this stays silent rather than
        # guessing.
        op = _op("Shape Through Hole", "adaptive2d", tool_diameter_cm=None, chains=[_square_chain(0, 0, 0.01)])
        cam = _cam(op)
        self.assertEqual(undersized_roughing_chain_warnings(cam), [])

    def test_returns_empty_rather_than_raising_on_bad_input(self):
        # The whole body is wrapped in a bare try/except, matching every
        # other best-effort guard in this file - a malformed or missing cam
        # must never crash the job, only skip the check.
        self.assertEqual(undersized_roughing_chain_warnings(None), [])


if __name__ == "__main__":
    unittest.main()
