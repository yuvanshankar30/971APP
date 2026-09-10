import importlib.util
import math
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


class _SketchPoint:
    def __init__(self, point):
        self.point = point
        self.context = None

    def createForAssemblyContext(self, context):
        proxy = _SketchPoint(self.point)
        proxy.context = context
        return proxy


class _SketchPoints:
    def __init__(self):
        self.points = []

    def add(self, point):
        sketch_point = _SketchPoint(point)
        self.points.append(sketch_point)
        return sketch_point


class _Sketch:
    def __init__(self):
        self.name = None
        self.isLightBulbOn = True
        self.sketchPoints = _SketchPoints()

    def modelToSketchSpace(self, point):
        return point


class _Sketches:
    def __init__(self):
        self.created = []

    def add(self, face):
        sketch = _Sketch()
        self.created.append((face, sketch))
        return sketch


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
            minPoint=types.SimpleNamespace(x=bb_min[0], y=bb_min[1], z=bb_min[2] if len(bb_min) > 2 else 0),
            maxPoint=types.SimpleNamespace(x=bb_max[0], y=bb_max[1], z=bb_max[2] if len(bb_max) > 2 else 0),
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
    """A side with NO real stock ANYWHERE behind it cannot physically hold
    a manual tab - confirmed live, not merely a theory - so it is excluded
    outright rather than merely deprioritized. Its share of the tab budget
    goes to the sides that DO have real stock instead, including a second
    tab on the same valid side when there's no fresh side to give it to.
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

    def test_a_side_with_no_stock_anywhere_behind_it_is_excluded_and_replaced(self):
        # Confirmed live: a side lying exactly on the plate's own
        # machining boundary (or a coordinate axis) has zero real material
        # anywhere along its outward side, and Fusion silently drops any
        # manual tab requested there. Direct instruction: skip that side
        # and add the tab it would have gotten onto a valid side instead -
        # more than one tab on that side if that's what it takes, never on
        # a curved edge or one too short to hold it.
        body, edges = self._rectangle_body_and_edges()
        # Stock stops at x=9 - EVERY point along the right side (x=10) has
        # nothing real behind it, not just the one checked; the other
        # three sides are fully backed.
        stock_bounds = (-1, 9, -1, 6)

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=stock_bounds)

        self.assertEqual(len(selected), 4)
        selected_edges = [edge for edge, _fraction in selected]
        self.assertNotIn(edges["right"], selected_edges, "an unbacked side must not receive a tab")
        for side in ("bottom", "top", "left"):
            self.assertIn(edges[side], selected_edges)
        # The 4th tab the excluded side would have gotten lands on one of
        # the valid sides instead, so a valid edge appears more than once -
        # this is what "add more than one tab for parts like this" means.
        distinct_ids = {id(e) for e in selected_edges}
        self.assertEqual(len(selected_edges), len(distinct_ids) + 1)
        # Never place two tabs at the same spot on that doubled-up edge.
        doubled = [e for e in distinct_ids if sum(1 for edge in selected_edges if id(edge) == e) == 2]
        self.assertEqual(len(doubled), 1)
        fractions = sorted(f for e, f in selected if id(e) == doubled[0])
        self.assertEqual(fractions, [1 / 3, 2 / 3])

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
        selected_ids = {id(e) for e, _fraction in selected}
        # The four longest distinct sides win; no short facet gets a tab.
        for expected in (long_a, long_b, mid_a, mid_b):
            self.assertIn(id(expected), selected_ids)
        for facet in facets:
            self.assertNotIn(id(facet), selected_ids)

    def test_backing_still_only_picks_the_segment_within_a_backed_side(self):
        # A side that HAS real stock somewhere (unlike the excluded-side
        # test above) still uses backing only to prefer which segment of
        # that side to use - unchanged from before this fix.
        body, edges = self._rectangle_body_and_edges()
        # Stock covers the whole right side here (unlike the excluded-side
        # test), so it remains a normal, eligible, single-tab side.
        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=(-1, 11, -1, 6))
        selected_edges = [edge for edge, _fraction in selected]
        self.assertIn(edges["right"], selected_edges)

    def test_every_side_backed_gets_exactly_one_tab_each(self):
        body, edges = self._rectangle_body_and_edges()
        # Every side has real stock behind it here.
        stock_bounds = (-1, 11, -1, 6)

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=stock_bounds)

        self.assertEqual(len(selected), 4)
        self.assertEqual(
            set(id(e) for e, _fraction in selected), set(id(e) for e in edges.values())
        )
        # No redistribution needed - one edge, one tab, each at its midpoint.
        self.assertTrue(all(fraction == 0.5 for _edge, fraction in selected))

    def test_two_supported_sides_absorb_tabs_from_stock_bound_sides(self):
        body, edges = self._rectangle_body_and_edges()
        # Stock exists beyond the top and bottom edges, but stops short of
        # both vertical edges.  Tabs can only anchor into the two horizontal
        # release sides, so their longer runs receive the whole budget.
        selected = TabPlacement.select_tab_edges(
            body, max_tabs=6, stock_bounds=(0.2, 9.8, -1, 6)
        )

        self.assertEqual(len(selected), 6)
        selected_edges = [edge for edge, _fraction in selected]
        self.assertEqual(selected_edges.count(edges["top"]), 3)
        self.assertEqual(selected_edges.count(edges["bottom"]), 3)
        self.assertNotIn(edges["left"], selected_edges)
        self.assertNotIn(edges["right"], selected_edges)

    def test_tab_budget_uses_nearest_spacing_interval(self):
        self.assertEqual(TabPlacement._tab_count_for_perimeter(16.0, 4, 10), 4)
        self.assertEqual(TabPlacement._tab_count_for_perimeter(16.01, 4, 10), 4)
        self.assertEqual(TabPlacement._tab_count_for_perimeter(36.01, 4, 10), 9)

    def test_a_side_much_longer_than_its_competitors_gets_more_than_one_tab(self):
        # Live-confirmed bug, reported against a real plate: one straight
        # side measured 16.317in and still received only ONE tab. Root
        # cause - select_tab_edges spends its whole max_tabs budget giving
        # every distinct usable side exactly one tab (breadth) before a
        # second tab can ever land anywhere; once a complex part has at
        # least as many distinct sides as max_tabs, that breadth pass alone
        # exhausts the budget, so the redistribution pass that would give a
        # long side extra tabs never runs at all - however much longer that
        # side is than the ones it's competing with.
        #
        # Reproduced directly: 14 short, mutually non-collinear sides (a
        # spoke pattern - same direction-based collinearity check
        # _edges_collinear uses, just picked to guarantee every spoke is a
        # distinct line) standing in for a complex outline's many short
        # notches, plus one 41.445cm (16.317in) side matching the real
        # report.
        long_side = _edge(0, 0, 0, 41.445)
        short_sides = [
            _edge(0, 0, 2.5 * math.cos(i * 0.4 + 0.1), 2.5 * math.sin(i * 0.4 + 0.1))
            for i in range(14)
        ]
        edges = [long_side, *short_sides]
        loop = _loop(True, edges)
        body = _body([_face(1.0, 1.0, [loop])], (0, 0), (10, 42))

        # With the OLD, too-low budget (10), breadth alone (15 distinct
        # sides, capped to the 10 longest) already consumes it - the long
        # side is guaranteed a slot (it's the longest), but gets only one.
        old_budget_selected = TabPlacement.select_tab_edges(body, max_tabs=10, stock_bounds=None)
        old_budget_long_side_tabs = sum(1 for edge, _fraction in old_budget_selected if edge is long_side)
        self.assertEqual(
            old_budget_long_side_tabs, 1,
            "sanity check that this scenario reproduces the reported bug under the old max_tabs=10",
        )

        # With the real (current) default, the same side must get more than one.
        selected = TabPlacement.select_tab_edges(body, max_tabs=TabPlacement.DEFAULT_MAX_TABS, stock_bounds=None)
        long_side_tabs = sum(1 for edge, _fraction in selected if edge is long_side)
        self.assertGreaterEqual(
            long_side_tabs, 2,
            "a side this much longer than its competitors must get more than one tab",
        )

    def test_a_moderately_long_side_on_an_already_well_tabbed_part_does_not_get_extra_tabs(self):
        # Live-confirmed bug, reported directly against a real plate: an
        # 8.211in side on a part that already had plenty of tabs elsewhere
        # received THREE tabs. Direct instruction: "too much tabs is not
        # good... only enough tabs to make the part stable" - a side this
        # length does not need more than one once the part already has
        # real breadth (6 distinct sides here, well past DEFAULT_MIN_TABS),
        # even with a generous max_tabs budget that has plenty of room left
        # to redistribute into if nothing capped it.
        target_side = _edge(0, 0, 0, 8.211 * 2.54)  # 8.211in, matching the live report
        # 2.5cm (~0.98in) each - comfortably above MIN_TAB_SIDE_LENGTH_IN
        # (0.75in) so these count as real, distinct, usable sides, and
        # comfortably shorter than the 8.211in target so it stays the
        # longest/most "room" candidate throughout redistribution.
        other_sides = [
            _edge(0, 0, 2.5 * math.cos(i * 0.9 + 0.2), 2.5 * math.sin(i * 0.9 + 0.2))
            for i in range(5)
        ]
        edges = [target_side, *other_sides]
        loop = _loop(True, edges)
        body = _body([_face(1.0, 1.0, [loop])], (0, 0), (10, 21))

        selected = TabPlacement.select_tab_edges(body, max_tabs=TabPlacement.DEFAULT_MAX_TABS, stock_bounds=None)

        target_side_tabs = sum(1 for edge, _fraction in selected if edge is target_side)
        self.assertEqual(
            target_side_tabs, 1,
            "an 8.211in side on an already well-tabbed part must not receive extra tabs",
        )


class GroupedTabSeparationTests(unittest.TestCase):
    def _stacked_rectangles(self, corridor_in=0.26):
        cm = 2.54
        width = 4 * cm
        height = 2 * cm
        corridor = corridor_in * cm

        lower_edges = [
            _edge(0, 0, width, 0),
            _edge(width, 0, width, height),
            _edge(width, height, 0, height),
            _edge(0, height, 0, 0),
        ]
        upper_bottom = height + corridor
        upper_edges = [
            _edge(0, upper_bottom, width, upper_bottom),
            _edge(width, upper_bottom, width, upper_bottom + height),
            _edge(width, upper_bottom + height, 0, upper_bottom + height),
            _edge(0, upper_bottom + height, 0, upper_bottom),
        ]
        lower = _body(
            [_face(1.0, 1.0, [_loop(True, lower_edges)])],
            (0, 0),
            (width, height),
        )
        upper = _body(
            [_face(1.0, 1.0, [_loop(True, upper_edges)])],
            (0, upper_bottom),
            (width, upper_bottom + height),
        )
        return lower, lower_edges[2], upper, upper_edges[0]

    def test_aligned_tabs_on_facing_grouped_edges_are_separated(self):
        lower, lower_top, upper, upper_bottom = self._stacked_rectangles()

        adjusted, moved = TabPlacement.separate_grouped_tab_candidates(
            [
                (lower, [(lower_top, 0.5)]),
                (upper, [(upper_bottom, 0.5)]),
            ],
            tab_width_in=0.6,
            object_spacing_in=0.26,
        )

        self.assertEqual([len(group) for group in adjusted], [1, 1])
        self.assertEqual(moved, 1)
        lower_edge, lower_fraction = adjusted[0][0]
        upper_edge, upper_fraction = adjusted[1][0]
        stock_gap_cm = TabPlacement._parallel_tab_span_gap(
            lower_edge,
            lower_fraction,
            upper_edge,
            upper_fraction,
            0.6 * 2.54,
        )
        self.assertGreaterEqual(
            stock_gap_cm,
            TabPlacement.GROUPED_TAB_STOCK_GAP_IN * 2.54 - 1e-6,
        )

    def test_already_separated_facing_tabs_keep_their_positions(self):
        lower, lower_top, upper, upper_bottom = self._stacked_rectangles()
        candidates = [
            (lower, [(lower_top, 0.2)]),
            (upper, [(upper_bottom, 0.2)]),
        ]

        adjusted, moved = TabPlacement.separate_grouped_tab_candidates(
            candidates,
            tab_width_in=0.6,
            object_spacing_in=0.26,
        )

        self.assertEqual(adjusted, [[(lower_top, 0.2)], [(upper_bottom, 0.2)]])
        self.assertEqual(moved, 0)

    def test_parallel_tabs_outside_the_shared_corridor_are_not_moved(self):
        lower, lower_top, upper, upper_bottom = self._stacked_rectangles(
            corridor_in=2.0
        )

        adjusted, moved = TabPlacement.separate_grouped_tab_candidates(
            [
                (lower, [(lower_top, 0.5)]),
                (upper, [(upper_bottom, 0.5)]),
            ],
            tab_width_in=0.6,
            object_spacing_in=0.26,
        )

        self.assertEqual(adjusted, [[(lower_top, 0.5)], [(upper_bottom, 0.5)]])
        self.assertEqual(moved, 0)


class MinTabsForBodyTests(unittest.TestCase):
    """_min_tabs_for_body's "exactly 3 for a triangular part" floor must
    only ever apply to a genuinely 3-sided outline, not any shape whose
    _distinct_straight_line_count happens to compute to 3 - see
    _is_a_bare_triangle's own docstring for the real, confirmed gap this
    covers (a heavily-notched or lattice-cut part reducing to 3 tab-
    eligible sides after the length filter is not a triangle, and must
    not silently override an operator's own explicit tab-count request).
    """

    def test_a_genuine_triangle_is_floored_to_three(self):
        edges = [
            _edge(0, 0, 10, 0),
            _edge(10, 0, 5, 8),
            _edge(5, 8, 0, 0),
        ]
        body = _body([_face(1.0, 1.0, [_loop(True, edges)])], (0, 0), (10, 8))

        self.assertEqual(TabPlacement._min_tabs_for_body(body, 4), 3)

    def test_a_notched_part_reducing_to_three_long_sides_keeps_the_requested_floor(self):
        # Real, confirmed gap: three genuinely long structural sides plus
        # a fourth side broken into many short jogs (a lattice/gusset
        # cutout pattern, not a triangle) used to also compute
        # _distinct_straight_line_count == 3 and get floored to 3 tabs,
        # silently overriding an operator's own explicit tab-count
        # override (e.g. 4) for a part that is not remotely triangular.
        long_bottom = _edge(0, 0, 10, 0)
        long_right = _edge(10, 0, 10, 10)
        long_top = _edge(10, 10, 0, 10)
        short_left_segments = [_edge(0, 10 - i, 0, 10 - i - 1) for i in range(10)]
        edges = [long_bottom, long_right, long_top, *short_left_segments]
        body = _body([_face(1.0, 1.0, [_loop(True, edges)])], (0, 0), (10, 10))

        self.assertEqual(TabPlacement._distinct_straight_line_count(body), 3)
        self.assertEqual(TabPlacement._min_tabs_for_body(body, 4), 4)


class MaxTabsForBodyTests(unittest.TestCase):
    """_max_tabs_for_body is the other half of the same floor above: a
    triangle only has 3 real sides, so more than 3 tabs adds no real
    holding power - direct instruction, more genuinely is not needed.
    """

    def test_a_genuine_triangle_is_capped_to_three(self):
        edges = [
            _edge(0, 0, 10, 0),
            _edge(10, 0, 5, 8),
            _edge(5, 8, 0, 0),
        ]
        body = _body([_face(1.0, 1.0, [_loop(True, edges)])], (0, 0), (10, 8))

        self.assertEqual(TabPlacement._max_tabs_for_body(body, 20), 3)

    def test_an_explicit_operator_override_above_three_is_still_capped_on_a_triangle(self):
        # camPlate.py's tab_count_override sets min_tabs == max_tabs to the
        # operator's requested value - a triangle must still get exactly 3
        # even when someone explicitly asked for more.
        edges = [
            _edge(0, 0, 10, 0),
            _edge(10, 0, 5, 8),
            _edge(5, 8, 0, 0),
        ]
        body = _body([_face(1.0, 1.0, [_loop(True, edges)])], (0, 0), (10, 8))

        self.assertEqual(TabPlacement._max_tabs_for_body(body, 8), 3)

    def test_a_notched_part_reducing_to_three_long_sides_keeps_the_requested_ceiling(self):
        long_bottom = _edge(0, 0, 10, 0)
        long_right = _edge(10, 0, 10, 10)
        long_top = _edge(10, 10, 0, 10)
        short_left_segments = [_edge(0, 10 - i, 0, 10 - i - 1) for i in range(10)]
        edges = [long_bottom, long_right, long_top, *short_left_segments]
        body = _body([_face(1.0, 1.0, [_loop(True, edges)])], (0, 0), (10, 10))

        self.assertEqual(TabPlacement._max_tabs_for_body(body, 8), 8)

    def test_a_large_triangle_does_not_scale_past_three_tabs(self):
        # Real, confirmed bug this closes: _min_tabs_for_body alone only
        # set a floor of 3 - a large triangle's own perimeter-based target
        # (_tab_count_for_perimeter) could still scale past 3, since
        # max_tabs was never adjusted for a triangle's own 3-sided shape.
        edges = [
            _edge(0, 0, 100, 0),
            _edge(100, 0, 50, 80),
            _edge(50, 80, 0, 0),
        ]
        body = _body([_face(1.0, 1.0, [_loop(True, edges)])], (0, 0), (100, 80))

        min_tabs = TabPlacement._min_tabs_for_body(body, 4)
        max_tabs = TabPlacement._max_tabs_for_body(body, 20)
        perimeter_in = TabPlacement._outer_perimeter_in(body)
        self.assertGreater(perimeter_in, TabPlacement.TARGET_TAB_SPACING_IN * 6)
        self.assertEqual(
            TabPlacement._tab_count_for_perimeter(perimeter_in, min_tabs, max_tabs), 3
        )


class MinimumSideLengthTests(unittest.TestCase):
    """A side too short to physically contain a tab must not get one.
    MIN_TAB_SIDE_LENGTH_IN reserves a modest lead-in and lead-out allowance.
    """

    def test_threshold_is_derived_from_the_tab_width(self):
        # A tab needs room to enter and leave the release edge, so the
        # threshold remains tied to one and a quarter configured tab widths.
        self.assertEqual(
            TabPlacement.MIN_TAB_SIDE_LENGTH_IN, TabPlacement.TAB_WIDTH_IN * 1.25
        )

    def _body_with(self, edges):
        loop = _loop(True, edges)
        return _body([_face(1.0, 1.0, [loop])], (0, 0), (40, 40))

    def test_a_side_shorter_than_a_tab_gets_none(self):
        cm = TabPlacement.MIN_TAB_SIDE_LENGTH_IN * 2.54
        long_a = _edge(0, 0, 0, cm * 4)
        long_b = _edge(cm * 4, 0, cm * 4, cm * 4)
        stub = _edge(0, 0, cm * 0.5, 0)   # half the required length
        body = self._body_with([long_a, long_b, stub])

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=None)

        selected_edges = [edge for edge, _fraction in selected]
        self.assertNotIn(stub, selected_edges)
        # Only 2 real sides exist (the stub is too short to count), so the
        # remaining 2 of the 4 requested tabs redistribute onto long_a and
        # long_b rather than going unused - each has room for a second one
        # at this length.
        self.assertEqual(len(selected), 4)
        self.assertEqual(set(id(e) for e in selected_edges), {id(long_a), id(long_b)})
        self.assertEqual(selected_edges.count(long_a), 2)
        self.assertEqual(selected_edges.count(long_b), 2)

    def test_filling_the_budget_cannot_re_add_a_short_side(self):
        # The redistribution pass runs when there are fewer usable sides
        # than tabs asked for; it must never fall back to a side too short
        # to hold one, even to make up the count.
        cm = TabPlacement.MIN_TAB_SIDE_LENGTH_IN * 2.54
        long_a = _edge(0, 0, 0, cm * 4)
        stubs = [_edge(0, 0, cm * 0.4, 0), _edge(cm, cm, cm * 1.4, cm)]
        body = self._body_with([long_a, *stubs])

        selected = TabPlacement.select_tab_edges(body, max_tabs=8, stock_bounds=None)

        selected_edges = [edge for edge, _fraction in selected]
        # Every tab lands on long_a - the only real side - never on a stub,
        # and it stops once long_a genuinely runs out of room rather than
        # crowding all the way to max_tabs=8.
        self.assertTrue(all(edge is long_a for edge in selected_edges))
        self.assertGreater(len(selected), 1, "a lone valid side should still pick up more than one tab")
        self.assertLess(len(selected), 8, "must not crowd more tabs onto a side than it has room for")
        self.assertEqual(sorted(f for _e, f in selected), TabPlacement._tab_fractions(len(selected)))

    def test_a_part_with_no_qualifying_side_refuses_unsafe_tabs(self):
        # A tab wider than every straight run is malformed geometry, not a
        # reason to silently relax the minimum. ConfigureTabs fails the job
        # before it can post an unsecured release contour.
        cm = TabPlacement.MIN_TAB_SIDE_LENGTH_IN * 2.54
        shorts = [
            _edge(0, 0, cm * 0.7, 0),
            _edge(cm * 0.7, 0, cm * 0.7, cm * 0.7),
            _edge(cm * 0.7, cm * 0.7, 0, cm * 0.7),
        ]
        body = self._body_with(shorts)

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=None)

        self.assertEqual(selected, [])

    def test_a_side_just_under_point_six_inches_never_gets_a_tab(self):
        cm = 2.54
        valid = _edge(0, 0, 0, 3 * cm)
        undersized = _edge(0, 0, 0.599 * cm, 0)
        body = self._body_with([valid, undersized])

        selected = TabPlacement.select_tab_edges(body, max_tabs=4, stock_bounds=None)

        self.assertTrue(selected)
        self.assertTrue(all(edge is valid for edge, _fraction in selected))


class ManualTabTests(unittest.TestCase):
    def test_disables_template_tabs_when_no_safe_manual_point_exists(self):
        parameters = {
            name: _Parameter()
            for name in ("group_tabs", "tabsPerContour", "tabPositions")
        }
        parameters["group_tabs"].value.value = True
        operation = types.SimpleNamespace(parameters=_Parameters(parameters))
        app = types.SimpleNamespace(log=lambda _message: None)

        self.assertTrue(TabPlacement._disable_tabs(app, operation))
        self.assertTrue(parameters["group_tabs"].value.value)
        self.assertEqual(parameters["tabsPerContour"].value.value, 0)
        self.assertEqual(parameters["tabPositions"].value.value, [])

    def test_sets_uniform_explicit_manual_tab_dimensions(self):
        parameters = {
            name: _Parameter()
            for name in ("tabWidth", "tabHeight", "tabsPerContour", "tabPositioning", "tabPositions")
        }
        operation = types.SimpleNamespace(parameters=_Parameters(parameters))
        app = types.SimpleNamespace(log=lambda _message: None)
        points = [object(), object(), object(), object()]

        self.assertTrue(TabPlacement._apply_manual_tabs(app, operation, points))
        self.assertEqual(parameters["tabsPerContour"].value.value, 0)
        self.assertEqual(parameters["tabPositioning"].value.value, "tabCount")
        self.assertEqual(parameters["tabWidth"].expression, "0.6in")
        self.assertEqual(parameters["tabHeight"].expression, "0.15in")
        self.assertEqual(parameters["tabPositions"].value.value, points)

    def test_uses_the_job_safe_height_for_thin_stock(self):
        parameters = {name: _Parameter() for name in ("tabHeight", "tabsPerContour", "tabPositions")}
        operation = types.SimpleNamespace(parameters=_Parameters(parameters))
        app = types.SimpleNamespace(log=lambda _message: None)

        self.assertTrue(TabPlacement._apply_manual_tabs(
            app, operation, [object()], tab_height_in=0.04375))

        self.assertEqual(parameters["tabHeight"].expression, "0.04375in")


class TabHeightTests(unittest.TestCase):
    def test_preserves_the_requested_height_on_thick_stock(self):
        body = _body([], (0, 0, 0), (1, 1, 0.25 * 2.54))

        self.assertEqual(TabPlacement._tab_height_for_bodies([body]), 0.15)

    def test_caps_height_to_a_safe_fraction_of_thin_stock(self):
        body = _body([], (0, 0, 0), (1, 1, 0.0625 * 2.54))

        self.assertAlmostEqual(TabPlacement._tab_height_for_bodies([body]), 0.04375)


class TabWidthTests(unittest.TestCase):
    def test_preserves_the_requested_width_on_normal_part_geometry(self):
        body = _body([], (0, 0, 0), (4 * 2.54, 3 * 2.54, 0.25 * 2.54))

        self.assertEqual(TabPlacement._tab_width_for_bodies([body]), 0.6)

    def test_caps_width_for_the_narrowest_nested_part(self):
        body = _body([], (0, 0, 0), (4 * 2.54, 1 * 2.54, 0.25 * 2.54))

        self.assertAlmostEqual(TabPlacement._tab_width_for_bodies([body]), 0.45)

    def test_keeps_a_small_cutter_stable_width_floor(self):
        body = _body([], (0, 0, 0), (4 * 2.54, 0.25 * 2.54, 0.25 * 2.54))

        self.assertEqual(TabPlacement._tab_width_for_bodies([body]), 0.2)


class ManualTabPointTests(unittest.TestCase):
    def _face(self):
        component = types.SimpleNamespace()
        face = types.SimpleNamespace(
            body=types.SimpleNamespace(parentComponent=component),
        )
        return face, component

    def _root_component(self):
        return types.SimpleNamespace(sketches=_Sketches())

    def test_creates_hidden_sketch_points_at_edge_midpoints(self):
        face, _ = self._face()
        root_component = self._root_component()
        app = types.SimpleNamespace(log=lambda _message: None)
        edge_fractions = [(_edge(0, 0, 4, 0), 0.5), (_edge(2, 2, 2, 8), 0.5)]

        points = TabPlacement._manual_tab_points(app, root_component, face, edge_fractions)

        self.assertEqual(len(points), 2)
        self.assertEqual([(p.point.x, p.point.y, p.point.z) for p in points], [(2, 0, 0.0), (2, 5, 0.0)])
        selected_face, sketch = root_component.sketches.created[0]
        self.assertIs(selected_face, face)
        self.assertEqual(sketch.name, "AutoCAM Manual Tab Points")
        self.assertFalse(sketch.isLightBulbOn)

    def test_uses_the_arranged_proxy_face_and_edge_coordinates(self):
        face, _ = self._face()
        root_component = self._root_component()
        face.nativeObject = types.SimpleNamespace()
        edge = _edge(200, 0, 204, 0)
        edge.nativeObject = _edge(2, 0, 6, 0)
        app = types.SimpleNamespace(log=lambda _message: None)

        point = TabPlacement._manual_tab_points(app, root_component, face, [(edge, 0.5)])[0]

        selected_face, _ = root_component.sketches.created[0]
        self.assertIs(selected_face, face)
        self.assertEqual((point.point.x, point.point.y, point.point.z), (202, 0, 0.0))

    def test_a_non_midpoint_fraction_lands_off_center(self):
        # This is the whole point of carrying a fraction at all - a second
        # tab sharing a side with the first must land at a genuinely
        # different, non-overlapping spot along it.
        face, _ = self._face()
        root_component = self._root_component()
        app = types.SimpleNamespace(log=lambda _message: None)
        edge = _edge(0, 0, 12, 0)

        points = TabPlacement._manual_tab_points(app, root_component, face, [(edge, 1 / 3), (edge, 2 / 3)])

        self.assertEqual([(p.point.x, p.point.y, p.point.z) for p in points], [(4, 0, 0.0), (8, 0, 0.0)])


class TabReadBackTests(unittest.TestCase):
    """Assignments to Fusion CAM tab parameters are verified, not trusted.

    A real tab-position bug was silent: positions came from the wrong face
    so none could be placed, while the job still reported success.
    """

    def _op(self, kept):
        params = {n: _Parameter() for n in
                  ("tabWidth", "tabHeight", "tabsPerContour", "tabPositioning", "tabPositions")}
        holder = params["tabPositions"]

        class _V:
            def __init__(self):
                self._v = []

            @property
            def value(self):
                return self._v

            @value.setter
            def value(self, points):
                # Model Fusion keeping only the points it can actually place.
                self._v = list(points)[:kept]

        holder.value = _V()
        return types.SimpleNamespace(parameters=_Parameters(params)), params

    def test_warns_when_fusion_drops_some_of_the_selected_points(self):
        logged = []
        app = types.SimpleNamespace(log=logged.append)
        operation, _ = self._op(kept=2)

        self.assertTrue(TabPlacement._apply_manual_tabs(
            app, operation, [object(), object(), object(), object()]))

        warnings = [m for m in logged if "WARNING" in m]
        self.assertTrue(warnings, "dropping 2 of 4 tab points must not be silent")
        self.assertIn("kept 2", warnings[0])

    def test_stays_quiet_when_every_point_is_kept(self):
        logged = []
        app = types.SimpleNamespace(log=logged.append)
        operation, _ = self._op(kept=4)

        self.assertTrue(TabPlacement._apply_manual_tabs(
            app, operation, [object(), object(), object(), object()]))

        self.assertEqual([m for m in logged if "WARNING" in m], [])


class _StockParameter:
    """A real Fusion stockXLow/XHigh/YLow/YHigh ModelParameter: .value is
    always a plain float in Fusion's internal centimeter unit; .expression
    is the human-readable string WITH ITS UNIT SUFFIX (e.g. "0.635 in") -
    never a bare number float() could parse.
    """

    def __init__(self, value_cm, expression):
        self.value = value_cm
        self.expression = expression


class ReadStockBoundsTests(unittest.TestCase):
    """Real, confirmed live bug: reading .expression instead of .value
    made every real call here raise (float() cannot parse a unit suffix),
    so stock_bounds silently ended up None on every real job - the whole
    real-stock-backing filter never actually ran, letting a tab get
    selected on a side with zero real material behind it (e.g. a part
    edge positioned flush against a coordinate axis).
    """

    def _setup(self, values):
        return types.SimpleNamespace(parameters=_Parameters(values))

    def test_reads_value_not_the_unit_suffixed_expression(self):
        setup = self._setup({
            "stockXLow": _StockParameter(0.0, "0 in"),
            "stockXHigh": _StockParameter(25.0, "9.84252 in"),
            "stockYLow": _StockParameter(-1.27, "-0.5 in"),
            "stockYHigh": _StockParameter(15.0, "5.90551 in"),
        })
        app = types.SimpleNamespace(log=lambda *_a: None)

        self.assertEqual(
            TabPlacement._read_stock_bounds(setup, app), (0.0, 25.0, -1.27, 15.0)
        )

    def test_falls_back_to_none_and_logs_when_a_parameter_is_missing(self):
        setup = self._setup({"stockXLow": _StockParameter(0.0, "0 in")})
        logged = []
        app = types.SimpleNamespace(log=logged.append)

        self.assertIsNone(TabPlacement._read_stock_bounds(setup, app))
        self.assertTrue(logged, "a missing parameter must not fail silently")


if __name__ == "__main__":
    unittest.main()
