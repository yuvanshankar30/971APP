import importlib.util
from pathlib import Path
import sys
import types
import unittest


def _load_tab_placement():
    # TabPlacement imports Fusion's runtime-only modules, but the identity
    # helper itself is pure Python and should remain regression-testable.
    adsk = types.ModuleType("adsk")
    adsk.core = types.ModuleType("adsk.core")
    adsk.fusion = types.ModuleType("adsk.fusion")
    adsk.cam = types.ModuleType("adsk.cam")
    previous = {name: sys.modules.get(name) for name in ("adsk", "adsk.core", "adsk.fusion", "adsk.cam")}
    try:
        sys.modules.update({
            "adsk": adsk,
            "adsk.core": adsk.core,
            "adsk.fusion": adsk.fusion,
            "adsk.cam": adsk.cam,
        })
        spec = importlib.util.spec_from_file_location(
            "TabPlacement", Path(__file__).parents[1] / "commands/TabPlacement.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


TabPlacement = _load_tab_placement()


class _Parameter:
    def __init__(self):
        self.expression = None
        self.value = types.SimpleNamespace(value=None)


class _Parameters:
    def __init__(self, values):
        self.values = values

    def itemByName(self, name):
        return self.values.get(name)


class _Vector3D:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z

    @classmethod
    def create(cls, x, y, z):
        return cls(x, y, z)

    def dotProduct(self, other):
        return self.x * other.x + self.y * other.y + self.z * other.z

    @property
    def length(self):
        return (self.x**2 + self.y**2 + self.z**2) ** 0.5

    def normalize(self):
        length = self.length
        if length > 0:
            self.x /= length
            self.y /= length
            self.z /= length


class _Point3D:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z

    @classmethod
    def create(cls, x, y, z):
        return cls(x, y, z)


class _Line3D:
    def __init__(self, start, end):
        self.startPoint = start
        self.endPoint = end


def _edge(x1, y1, x2, y2):
    e = types.SimpleNamespace()
    e.geometry = _Line3D(_Point3D(x1, y1, 0.0), _Point3D(x2, y2, 0.0))
    e.length = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
    return e


def _loop(is_outer, edges):
    return types.SimpleNamespace(
        isOuter=is_outer,
        coEdges=[types.SimpleNamespace(edge=e) for e in edges],
    )


def _face(normal_z, z, loops):
    return types.SimpleNamespace(
        geometry=types.SimpleNamespace(normal=_Vector3D(0, 0, normal_z)),
        pointOnFace=_Point3D(0, 0, z),
        loops=loops,
    )


def _body(faces, bb_min, bb_max):
    return types.SimpleNamespace(
        faces=faces,
        boundingBox=types.SimpleNamespace(
            minPoint=types.SimpleNamespace(x=bb_min[0], y=bb_min[1]),
            maxPoint=types.SimpleNamespace(x=bb_max[0], y=bb_max[1]),
        ),
    )


# select_tab_edges needs real Vector3D/Point3D/Line3D math (dot products,
# normalization) that the blank adsk.core stub _load_tab_placement builds
# doesn't provide - patched onto the SAME module object TabPlacement.py's
# own `import adsk.core` bound to, so its later, dynamic attribute lookups
# (isinstance(edge.geometry, adsk.core.Line3D), adsk.core.Vector3D.create)
# resolve to these real implementations instead of raising.
TabPlacement.adsk.core.Vector3D = _Vector3D
TabPlacement.adsk.core.Point3D = _Point3D
TabPlacement.adsk.core.Line3D = _Line3D


class TabDistributionTests(unittest.TestCase):
    """Direct instruction: every distinct straight side of a part gets at
    least one tab, even a side with no real stock behind it - stock
    backing should only decide WHICH edge to prefer within a side, never
    whether a whole side gets zero tabs.
    """

    def _rectangle_body_and_edges(self):
        edges = {
            "bottom": _edge(0, 0, 10, 0),
            "right": _edge(10, 0, 10, 5),
            "top": _edge(10, 5, 0, 5),
            "left": _edge(0, 5, 0, 0),
        }
        loop = _loop(True, list(edges.values()))
        face = _face(1.0, 1.0, [loop])
        body = _body([face], (0, 0), (10, 5))
        return body, edges

    def test_a_side_with_no_stock_behind_it_still_gets_a_tab(self):
        body, edges = self._rectangle_body_and_edges()
        # Stock stops at x=9 - the right side (x=10) has nothing real
        # behind it, the other three sides do.
        stock_bounds = (-1, 9, -1, 6)

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=stock_bounds)

        self.assertEqual(len(selected), 4)
        self.assertIn(edges["right"], selected)

    def test_a_many_sided_part_is_capped_and_keeps_its_longest_sides(self):
        """A real teardrop bracket a few inches across picked up a tab on
        every one of its short bottom facets - far more than a part that
        size needs, and clustered where a tab has least room to hold. The
        cap plus longest-first ordering is what puts the tabs on the long
        structural sides instead.
        """
        long_a = _edge(0, 0, 0, 10)      # two long sides
        long_b = _edge(12, 0, 12, 10)
        mid_a = _edge(0, 10, 5, 14)      # two medium sides
        mid_b = _edge(12, 10, 7, 14)
        facets = [                        # a fan of short bottom facets
            _edge(0, 0, 2, -1),
            _edge(2, -1, 5, -1.5),
            _edge(5, -1.5, 8, -1.5),
            _edge(8, -1.5, 12, 0),
        ]
        edges = [long_a, long_b, mid_a, mid_b, *facets]
        loop = _loop(True, edges)
        body = _body([_face(1.0, 1.0, [loop])], (0, -1.5), (12, 14))

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=None)

        self.assertEqual(len(selected), 4)
        selected_ids = {id(e) for e in selected}
        # The four longest distinct sides win; no short facet gets a tab.
        for expected in (long_a, long_b, mid_a, mid_b):
            self.assertIn(id(expected), selected_ids)
        for facet in facets:
            self.assertNotIn(id(facet), selected_ids)

    def test_a_side_without_stock_still_wins_a_tab_when_it_is_long_enough(self):
        # The no-stock-backing improvement must survive the cap: backing
        # decides WHICH segment of a side, never whether a long side is
        # eligible at all.
        body, edges = self._rectangle_body_and_edges()
        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=(-1, 9, -1, 6))
        self.assertIn(edges["right"], selected)

    def test_stock_backed_edges_are_preferred_when_backing_is_missing_is_not_forced(self):
        body, edges = self._rectangle_body_and_edges()
        # Every side has real stock behind it here.
        stock_bounds = (-1, 11, -1, 6)

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=stock_bounds)

        self.assertEqual(len(selected), 4)
        self.assertEqual(set(id(e) for e in selected), set(id(e) for e in edges.values()))


class MinimumSideLengthTests(unittest.TestCase):
    """A side too short to physically contain a tab must not get one.
    MIN_TAB_SIDE_LENGTH_IN is derived from TAB_WIDTH_IN so the two can't
    drift apart.
    """

    def test_threshold_is_derived_from_the_tab_width(self):
        # The previous fixed 0.5in floor was SHORTER than the 0.6in tab it
        # was meant to fit, so an edge could qualify for a tab it could not
        # physically contain.
        self.assertGreater(TabPlacement.MIN_TAB_SIDE_LENGTH_IN, TabPlacement.TAB_WIDTH_IN)
        self.assertEqual(
            TabPlacement.MIN_TAB_SIDE_LENGTH_IN, TabPlacement.TAB_WIDTH_IN * 2
        )

    def _body_with(self, edges):
        loop = _loop(True, edges)
        return _body([_face(1.0, 1.0, [loop])], (0, 0), (40, 40))

    def test_a_side_shorter_than_a_tab_gets_none(self):
        cm = TabPlacement.MIN_TAB_SIDE_LENGTH_IN * 2.54
        long_a = _edge(0, 0, 0, cm * 3)
        long_b = _edge(cm * 3, 0, cm * 3, cm * 3)
        stub = _edge(0, 0, cm * 0.5, 0)   # half the required length
        body = self._body_with([long_a, long_b, stub])

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=None)

        self.assertNotIn(id(stub), {id(e) for e in selected})
        self.assertEqual({id(long_a), id(long_b)}, {id(e) for e in selected})

    def test_filling_the_budget_cannot_re_add_a_short_side(self):
        # The budget-filling pass runs when there are fewer sides than
        # tabs; it must respect the same threshold or it would undo it.
        cm = TabPlacement.MIN_TAB_SIDE_LENGTH_IN * 2.54
        long_a = _edge(0, 0, 0, cm * 3)
        stubs = [_edge(0, 0, cm * 0.4, 0), _edge(cm, cm, cm * 1.4, cm)]
        body = self._body_with([long_a, *stubs])

        selected = TabPlacement.select_tab_edges(body, max_tabs=8, stock_bounds=None)

        self.assertEqual([id(e) for e in selected], [id(long_a)])

    def test_a_part_with_no_qualifying_side_is_still_held(self):
        # An unheld part coming loose mid-cut is worse than a tight tab, so
        # a part too small for the threshold falls back to its longest
        # sides rather than returning nothing.
        cm = TabPlacement.MIN_TAB_SIDE_LENGTH_IN * 2.54
        shorts = [
            _edge(0, 0, cm * 0.6, 0),
            _edge(cm * 0.6, 0, cm * 0.6, cm * 0.6),
            _edge(cm * 0.6, cm * 0.6, 0, cm * 0.6),
        ]
        body = self._body_with(shorts)

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=None)

        self.assertTrue(selected, "a small part must still get tabs, not none")


class ManualTabTests(unittest.TestCase):
    def test_disables_automatic_tabs_and_sets_uniform_manual_dimensions(self):
        parameters = {
            name: _Parameter()
            for name in ("tabWidth", "tabHeight", "tabsPerContour", "tabPositions")
        }
        operation = types.SimpleNamespace(parameters=_Parameters(parameters))
        app = types.SimpleNamespace(log=lambda _message: None)
        edges = [object(), object(), object(), object()]

        self.assertTrue(TabPlacement._apply_manual_tabs(app, operation, edges))
        self.assertEqual(parameters["tabsPerContour"].expression, "0")
        self.assertEqual(parameters["tabWidth"].expression, "0.6in")
        self.assertEqual(parameters["tabHeight"].expression, "0.15in")
        self.assertEqual(parameters["tabPositions"].value.value, edges)


class TabReadBackTests(unittest.TestCase):
    """Assignments to Fusion CAM tab parameters are verified, not trusted.

    Both of this module's real bugs were silent: tab edges came from the
    wrong face so none could be placed, and tabsPerContour reports 1
    whatever it is given. In both cases the job reported success.
    """

    def _op(self, kept):
        params = {n: _Parameter() for n in
                  ("tabWidth", "tabHeight", "tabsPerContour", "tabPositions")}
        holder = params["tabPositions"]

        class _V:
            def __init__(self):
                self._v = []

            @property
            def value(self):
                return self._v

            @value.setter
            def value(self, edges):
                # Model Fusion keeping only the edges it can actually place.
                self._v = list(edges)[:kept]

        holder.value = _V()
        return types.SimpleNamespace(parameters=_Parameters(params)), params

    def test_warns_when_fusion_drops_some_of_the_selected_edges(self):
        logged = []
        app = types.SimpleNamespace(log=logged.append)
        operation, _ = self._op(kept=2)

        self.assertTrue(TabPlacement._apply_manual_tabs(
            app, operation, [object(), object(), object(), object()]))

        warnings = [m for m in logged if "WARNING" in m]
        self.assertTrue(warnings, "dropping 2 of 4 tab edges must not be silent")
        self.assertIn("kept 2", warnings[0])

    def test_stays_quiet_when_every_edge_is_kept(self):
        logged = []
        app = types.SimpleNamespace(log=logged.append)
        operation, _ = self._op(kept=4)

        self.assertTrue(TabPlacement._apply_manual_tabs(
            app, operation, [object(), object(), object(), object()]))

        self.assertEqual([m for m in logged if "WARNING" in m], [])


if __name__ == "__main__":
    unittest.main()
