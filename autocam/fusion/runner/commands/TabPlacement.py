# Configures holding tabs on the 2D Contour (outer profile) toolpath -
# direct instruction: at least 3-4 tabs, only on straight edges (never a
# rounded/filleted one - a tab needs flat contact, not a curve), preferring
# the longest straight edges available, on every material (this file has no
# material-specific logic at all - tab geometry is a stock-retention concern,
# independent of what the stock is cut from; feed rate/material handling is
# a separate, not-yet-started piece of work).
#
# Fusion's own tab parameters (tabsPerContour, tabWidth, tabHeight,
# tabPositioning, tabPositions, noTabZones, group_tabs - see the contour2d
# template's defaults) aren't part of the typed adsk.cam API surface at all
# (confirmed: no hits anywhere in the installed API for "tabPositioning") -
# they're generic, string-keyed CAM parameters Fusion defines internally per
# strategy, with no public documentation of valid enum values.
#
# Fusion's UI has a separate Manual Tabs field (`tabPositions`) alongside
# its automatic placement mode. This module supplies that manual list.
#
# Tab placement controls are discrete CAM values. Use
# ``parameter.value.value``, not ``parameter.expression``: assigning the
# latter can appear accepted while leaving the strategy in its old
# distance-placement mode. Manual-only tabs require the exact combination
# ``tabPositioning.value.value = 'tabCount'`` and
# ``tabsPerContour.value.value = 0``. The Manual Tabs parameter itself is a
# CadPoints collection, not a list of bare edges, so every selected release
# edge becomes a midpoint SketchPoint - see _manual_tab_points.
#
# WHICH operation actually gets tabs: only the one the template itself
# already designates via group_tabs=true in its own default state - a real
# material-sheet template has SEVERAL contour2d operations (finishing
# passes on individual pocket/hole features, plus one outer-profile
# release cut), and only the outer-profile one is meant to hold the part(s)
# to stock. Confirmed directly against a real exported template
# ((DEPRECATED)971 Metal Sheet.f3dhsm-template): of its three contour2d
# operations, only "2D Slot Cut" defaults group_tabs to true. This file
# used to force group_tabs=true and apply tab edges to EVERY contour2d
# operation indiscriminately - confirmed live as a real bug, tabs applied
# to finishing passes that cut a small internal feature and have nothing
# to do with holding the part to stock. Fixed by only touching operations
# where group_tabs was already true, read before this function ever
# modifies anything.
#
# GROUPED (multi-part) jobs: group_tabs is exactly Fusion's own "distribute
# tabs across every body in the setup" flag - so the one operation that has
# it true is, BY DEFINITION, the shared cut that releases every nested part
# from stock at once, not any single part's own operation. An earlier
# version of this file tried to match that operation to exactly one body
# (the right approach for a per-part finishing pass, the wrong one for
# this) - confirmed live on a real 2-part grouped job that the match always
# failed, silently leaving the one real tabbed operation with no tabs at
# all. Fixed by computing candidate tab edges from EVERY body on the plate
# and combining them - for a single-body plate this reduces to exactly the
# old single-body behavior.
import adsk.core
import adsk.fusion
import adsk.cam


DEFAULT_MIN_TABS = 4
DEFAULT_MAX_TABS = 8
# How far outward (beyond the candidate edge) to check for real stock -
# just enough to tell "is there material here at all", not "is there a lot
# of it". Matches the same order of magnitude as MIN_TAB_EDGE_LENGTH_IN
# below, not a coincidence - both are about "is this a real, usable
# anchor point," just measured along different axes of the same tab.
STOCK_BACKING_CHECK_IN = 0.2
# Roughly one tab per this many inches of a part's own outer perimeter -
# FRC-scale sheet parts (a few inches to a couple feet around) land in the
# 3-8 tab range this way rather than every part getting the same flat count
# regardless of size. No single authoritative number exists for this; chosen
# as the middle of commonly cited CNC sheet-tabbing guidance (roughly every
# 4-8in of perimeter for thin plate) rather than picked arbitrarily.
TARGET_TAB_SPACING_IN = 6.0
# Every release tab has the same operator-specified dimensions. Candidate
# edges are selected directly, so Fusion cannot distribute a tab into a
# corner between them.
TAB_WIDTH_IN = 0.6
TAB_HEIGHT_IN = 0.15

# The shortest side that may carry a tab, derived from the tab itself
# rather than picked as a round number.
#
# A tab occupies TAB_WIDTH_IN of the edge, and the cutter has to ramp up
# onto it and back down off it - so the flat run has to be meaningfully
# longer than the tab, not merely longer. Published sheet-routing guidance
# puts tabs at roughly 0.25-0.5in on thin stock and asks for a straight run
# comfortably longer than the tab; twice the tab width is the common rule
# of thumb and is what this uses, giving half a tab width of lead-on and
# lead-off at 0.6in tabs.
#
# This also corrects a real inconsistency: the previous 0.5in floor was
# SHORTER than TAB_WIDTH_IN (0.6in), so an edge could qualify for a tab it
# physically could not contain. Deriving it from TAB_WIDTH_IN means that
# can't drift apart again if the tab size is ever retuned.
#
# A side shorter than this gets no tab - confirmed against a real teardrop
# bracket whose short bottom facets were being tabbed, which is both
# unnecessary on a part that size and the worst place to put one. If a part
# is so small that NO side qualifies, select_tab_edges falls back to its
# longest sides anyway: an unheld part is worse than a tight tab.
MIN_TAB_SIDE_LENGTH_IN = TAB_WIDTH_IN * 2

# Kept as the coarse "is this edge even worth considering" filter. The real
# gate is MIN_TAB_SIDE_LENGTH_IN above, applied per side after collinear
# segments are grouped.
MIN_TAB_EDGE_LENGTH_IN = 0.5


def _is_straight_edge(edge) -> bool:
    try:
        return isinstance(edge.geometry, adsk.core.Line3D)
    except Exception:
        return False


def _edge_length(edge) -> float:
    try:
        return float(edge.length)
    except Exception:
        return 0.0


def _find_tab_face(body):
    """Return the face whose outer loop the release contour is actually cut
    from - the physically LOWEST planar face, matching DeleteToolpaths.py's
    own _bottom_face.

    This must be the same face the contour uses, and that is the whole
    point of this function. A manual tab is not a free-floating position:
    its SketchPoint must be on the selected contour, so a point created on
    an edge that is not part of that contour is silently ignored.

    An earlier version deliberately took tab edges from the TOP face while
    the contour came from the bottom, on the theory that tabs and their
    contour were independent edge loops. Confirmed live that they are not,
    and that this was the reason tabs never landed where this module chose:
    on a real job the operation's manual tab list held top-face edge
    references at z=0.0in, while the contour it was attached to was built
    from edges at z=-0.0625in - an intersection of exactly ZERO. Fusion's
    dialog listed four selections and used none of them.

    Note the top face is still the RIGHT choice for anything that only has
    to describe the part's own silhouette - but nothing here does; every
    edge this module returns is handed to Fusion as a tab position.
    """
    best_face = None
    best_z = None
    for face in body.faces:
        try:
            normal = face.geometry.normal
            z = face.pointOnFace.z
        except Exception:
            continue
        # abs(): a STEP import can report both opposing broad faces with the
        # same normal sign, so height - not sign - identifies the bottom.
        if abs(normal.z) > 0.9 and (best_z is None or z < best_z):
            best_z = z
            best_face = face
    return best_face


def _outer_boundary_edges(face):
    """Only the outer loop of a face - a top face with an internal pocket
    or hole has additional inner loops whose edges are real geometry but
    are never candidates for a holding tab (a tab bridges the part to
    surrounding stock, not to material inside its own cutout). Confirmed
    directly: without this, a part with a rectangular internal pocket had
    that pocket's own straight edges competing with its real outer sides
    for tab placement.
    """
    try:
        for loop in face.loops:
            if loop.isOuter:
                return [co_edge.edge for co_edge in loop.coEdges]
    except Exception:
        pass
    return list(face.edges)


def _outer_perimeter_in(body) -> float:
    tab_face = _find_tab_face(body)
    if tab_face is None:
        return 0.0
    return sum(_edge_length(e) for e in _outer_boundary_edges(tab_face)) / 2.54


def _tab_count_for_perimeter(perimeter_in: float, min_tabs: int, max_tabs: int) -> int:
    if perimeter_in <= 0:
        return min_tabs
    target = round(perimeter_in / TARGET_TAB_SPACING_IN)
    return max(min_tabs, min(max_tabs, target))


def _edge_direction_and_point(edge):
    geom = edge.geometry
    start = geom.startPoint
    end = geom.endPoint
    direction = adsk.core.Vector3D.create(end.x - start.x, end.y - start.y, end.z - start.z)
    direction.normalize()
    return direction, start


def _edges_collinear(edge_a, edge_b, tolerance: float = 1e-3) -> bool:
    """True if two straight edges lie along the same infinite line - a
    single straight side of a part is sometimes represented as several
    adjoining segments rather than one edge (tangent/fillet transition
    points splitting it), and tabs should spread across genuinely
    different sides of the part, not every segment of what's really one
    line - direct instruction: at least 2 distinct lines, not all tabs on
    one.
    """
    dir_a, point_a = _edge_direction_and_point(edge_a)
    dir_b, point_b = _edge_direction_and_point(edge_b)
    # Parallel check (dot product near +-1, allowing either direction sense).
    if abs(dir_a.dotProduct(dir_b)) < 1 - tolerance:
        return False
    # Same-line check: the vector between a point on each edge must also
    # be parallel to that shared direction (or the edges already touch).
    connecting = adsk.core.Vector3D.create(point_b.x - point_a.x, point_b.y - point_a.y, point_b.z - point_a.z)
    if connecting.length < tolerance:
        return True
    connecting.normalize()
    return abs(connecting.dotProduct(dir_a)) > 1 - tolerance


def _edge_midpoint(edge):
    geom = edge.geometry
    start, end = geom.startPoint, geom.endPoint
    return adsk.core.Point3D.create((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2)


def _manual_tab_points(app, root_component, tab_face, tab_edges):
    """Create explicit Manual Tabs SketchPoints at vetted edge midpoints.

    Fusion stores ``tabPositions`` as a CadPoints collection. Assigning BRep
    edges may display those edges in the operation dialog, but it does not
    identify a position along each edge; the CAM kernel can then retain only
    some of them depending on chain direction. The sketch itself MUST belong
    to the setup's root component and receive the already-arranged face proxy
    in that root context. Creating the sketch in the source component then
    proxying its points afterward makes Fusion evaluate some locations in the
    unarranged local frame, which was the cause of tabs appearing on only two
    sides of autocamtraining.
    """
    if tab_face is None or not tab_edges:
        return []
    try:
        sketch = root_component.sketches.add(tab_face)
        sketch.name = "AutoCAM Manual Tab Points"
        try:
            sketch.isLightBulbOn = False
        except Exception:
            pass

        tab_points = []
        for edge in tab_edges:
            # ``edge`` is intentionally the occurrence proxy returned from
            # rootComponent.allOccurrences. Its geometry is already in the
            # exact arranged coordinate frame of this setup.
            point = sketch.modelToSketchSpace(_edge_midpoint(edge))
            sketch_point = sketch.sketchPoints.add(point)
            tab_points.append(sketch_point)
        return tab_points
    except Exception as e:
        app.log(f"TabPlacement: could not create explicit Manual Tab points: {e}")
        return []


def _edge_outward_point(edge, body_center, offset_cm):
    """A point just beyond this edge, on the side AWAY from the part's own
    body - the side a tab would actually need real stock behind. The edge
    itself has two perpendicular directions; the one whose offset point
    ends up FARTHER from the body's own center is outward, since a convex
    part's outer boundary always faces away from its own centroid.
    """
    direction, _ = _edge_direction_and_point(edge)
    mid = _edge_midpoint(edge)
    # Either perpendicular to the edge's own direction, in the face plane (z=0 component).
    perp = adsk.core.Vector3D.create(-direction.y, direction.x, 0)
    perp.normalize()
    candidate_a = adsk.core.Point3D.create(mid.x + perp.x * offset_cm, mid.y + perp.y * offset_cm, mid.z)
    candidate_b = adsk.core.Point3D.create(mid.x - perp.x * offset_cm, mid.y - perp.y * offset_cm, mid.z)
    dist_a = (candidate_a.x - body_center.x) ** 2 + (candidate_a.y - body_center.y) ** 2
    dist_b = (candidate_b.x - body_center.x) ** 2 + (candidate_b.y - body_center.y) ** 2
    return candidate_a if dist_a > dist_b else candidate_b


def _has_real_stock_backing(edge, body_center, stock_bounds, offset_cm) -> bool:
    """A tab on this edge is meaningless if the material just beyond it
    isn't real stock - direct instruction: a part positioned close to the
    plate's own edge (AutoArrange's frame margin used up on that side, or
    a corner placement) can have one or more sides with little to no
    stock actually behind them; a tab there has nothing real to anchor
    into. stock_bounds is (xLow, xHigh, yLow, yHigh) from the setup's own
    real stockXLow/XHigh/YLow/YHigh parameters - the plate's actual
    machining bounds, not a guess. None (stock bounds unavailable) means
    "don't filter" rather than "reject everything" - a missing bounds
    check should never be the reason a part ends up with zero tabs.
    """
    if stock_bounds is None:
        return True
    x_low, x_high, y_low, y_high = stock_bounds
    point = _edge_outward_point(edge, body_center, offset_cm)
    return x_low <= point.x <= x_high and y_low <= point.y <= y_high


def _body_center(body):
    return adsk.core.Point3D.create(
        (body.boundingBox.minPoint.x + body.boundingBox.maxPoint.x) / 2,
        (body.boundingBox.minPoint.y + body.boundingBox.maxPoint.y) / 2,
        0,
    )


def _all_straight_edges(body):
    """Every straight, long-enough edge on body's own outer boundary -
    deliberately NOT filtered by stock backing. Direct instruction: every
    distinct straight side of a part gets at least one tab even when it
    has no real stock behind it (a part positioned close to the plate's
    own edge, or a corner placement, can leave a whole side without real
    backing) - a tab there may not have real material to bite into, but
    the part still needs to be physically held at every side, not just
    the sides that happen to back onto stock. Stock backing is used only
    to PREFER which edge to pick within a side when more than one
    candidate segment exists (see select_tab_edges) - never to drop a
    whole side to zero tabs.
    """
    tab_face = _find_tab_face(body)
    if tab_face is None:
        return []
    min_length_cm = MIN_TAB_EDGE_LENGTH_IN * 2.54
    return [
        e
        for e in _outer_boundary_edges(tab_face)
        if _is_straight_edge(e) and _edge_length(e) >= min_length_cm
    ]


def _group_into_lines(edges):
    """Collapse a body's straight edges into distinct straight sides - a
    single straight side of a part is sometimes represented as several
    adjoining segments rather than one edge (tangent/fillet transition
    points splitting it); see _edges_collinear.
    """
    lines: list[list] = []
    for edge in edges:
        for line in lines:
            if _edges_collinear(edge, line[0]):
                line.append(edge)
                break
        else:
            lines.append([edge])
    return lines


def _distinct_straight_line_count(body) -> int:
    """How many genuinely different straight sides body's outer boundary
    has - used only to decide the target tab count (see
    _min_tabs_for_body), not to place tabs directly. Counts every real
    straight side, stock-backed or not - a side with no stock behind it
    still needs its own tab (see _all_straight_edges), so it still counts
    as a real side here too.
    """
    return len(_group_into_lines(_all_straight_edges(body)))


def _min_tabs_for_body(body, min_tabs: int) -> int:
    """A triangular part only has 3 real sides to begin with - padding a
    4th tab onto one already-tabbed side doesn't add real holding power,
    it just doubles up on one side. Direct instruction: 4 or more tabs
    normally, but exactly 3 for a triangular shape. Anything with 4+
    distinct sides still uses the normal min_tabs floor (parametric -
    ConfigureTabs's own min_tabs/max_tabs arguments, not hardcoded here).
    """
    if _distinct_straight_line_count(body) == 3:
        return 3
    return min_tabs


def select_tab_edges(body, max_tabs: int = DEFAULT_MAX_TABS, stock_bounds=None):
    """Straight edges on the body's own outer boundary, spread across
    every distinct straight side. Never returns a curved/filleted edge, an
    internal-loop (hole/pocket) edge, or one too short to physically hold
    a tab - direct instruction, not a preference to relax if a part is
    mostly rounded or small.

    Used by ConfigureTabs as the actual Manual Tabs geometry. Each selected
    edge is an explicit, safe release-tab location; Fusion's automatic
    placement is disabled rather than allowed to place more tabs elsewhere.

    One tab per distinct side, longest side first, capped at max_tabs
    (which _tab_count_for_perimeter has already scaled to the part's own
    size). A side is never skipped just because it has no real stock
    behind it - within a side a stock-backed segment is preferred, falling
    back to its longest segment otherwise, so a part sitting close to the
    plate's edge still gets held. Only if the part has fewer distinct
    sides than tabs asked for do additional segments of those sides get
    used, stock-backed ones first.
    """
    stock_check_cm = STOCK_BACKING_CHECK_IN * 2.54
    body_center = _body_center(body)

    def is_backed(edge):
        return _has_real_stock_backing(edge, body_center, stock_bounds, stock_check_cm)

    all_edges = sorted(_all_straight_edges(body), key=_edge_length, reverse=True)
    lines = _group_into_lines(all_edges)
    lines.sort(key=lambda line: _edge_length(line[0]), reverse=True)

    def best_edge_for_line(line):
        backed = [e for e in line if is_backed(e)]
        pool = backed if backed else line
        return max(pool, key=_edge_length)

    # One tab per distinct side, longest side first, capped at max_tabs.
    #
    # The cap is the point. An earlier version guaranteed a tab on EVERY
    # distinct straight side regardless of max_tabs, which is right for a
    # rectangle (4 sides, 4 tabs) but wrong for the shape this pipeline
    # actually cuts most often: a small bracket whose outline is a long
    # profile plus a fan of short facets. Confirmed live on a real part -
    # a teardrop bracket a few inches across picked up a tab on every one
    # of its little bottom facets, far more than a part that size needs to
    # stay put, and clustered where they were least useful.
    #
    # Longest-first is what makes the cap land well: the long structural
    # sides get the tabs and the short facets lose out, which is also where
    # a tab actually has room to hold. _tab_count_for_perimeter has already
    # scaled max_tabs to the part's own size before this is called, so a
    # small part asks for ~4 and a large one asks for more.
    # Drop sides too short to actually hold a tab (see
    # MIN_TAB_SIDE_LENGTH_IN). Measured on the segment that would carry the
    # tab, not the side's summed length: a side split into several short
    # collinear pieces still has to fit the tab within ONE of them.
    min_side_cm = MIN_TAB_SIDE_LENGTH_IN * 2.54
    usable = [line for line in lines if _edge_length(best_edge_for_line(line)) >= min_side_cm]

    # Never return nothing. On a part so small that no side clears the
    # threshold, a tab that is tight is still better than a part that comes
    # loose mid-cut, so fall back to its longest sides.
    if not usable:
        usable = lines

    selected = [best_edge_for_line(line) for line in usable[:max_tabs]]

    # Only if the part genuinely has fewer distinct sides than tabs asked
    # for (a triangle, say) do additional segments of the sides it does
    # have get used, stock-backed ones first. These are held to the same
    # length threshold as the first pass - otherwise filling the budget
    # would quietly put tabs back on exactly the short facets the
    # threshold just excluded.
    if len(selected) < max_tabs:
        selected_ids = {id(e) for e in selected}
        remaining = [
            e for e in all_edges
            if id(e) not in selected_ids and _edge_length(e) >= min_side_cm
        ]
        remaining.sort(key=lambda e: (not is_backed(e), -_edge_length(e)))
        for edge in remaining:
            if len(selected) >= max_tabs:
                break
            selected.append(edge)
    return selected


def _apply_manual_tabs(app, operation, tab_points) -> bool:
    """Configure uniform explicit positions in Fusion's Manual Tabs field.

    ``tabPositions`` receives explicit SketchPoints on the release contour.
    The points, rather than edge references, make the requested location and
    its chain direction unambiguous to Fusion's CAM kernel.
    """
    width_param = operation.parameters.itemByName("tabWidth")
    if width_param is not None:
        try:
            width_param.expression = f"{TAB_WIDTH_IN}in"
        except Exception as e:
            app.log(f"TabPlacement: failed to set tabWidth: {e}")

    height_param = operation.parameters.itemByName("tabHeight")
    if height_param is not None:
        try:
            height_param.expression = f"{TAB_HEIGHT_IN}in"
        except Exception as e:
            app.log(f"TabPlacement: failed to set tabHeight: {e}")

    # Fusion exposes these as discrete CAM values, not unit expressions.
    # Assigning an expression can look accepted in the parameter dialog yet
    # leave the strategy in its previous distance-placement mode. That is
    # exactly how a four-point selection degraded to the template's two
    # automatic tabs on autocamtraining. The documented working API pattern
    # is to set the nested value directly before assigning SketchPoints.
    group_tabs = operation.parameters.itemByName("group_tabs")
    if group_tabs is not None:
        try:
            group_tabs.value.value = True
        except Exception as e:
            app.log(f"TabPlacement: failed to enable grouped tabs: {e}")

    positioning_param = operation.parameters.itemByName("tabPositioning")
    if positioning_param is not None:
        try:
            positioning_param.value.value = "tabCount"
        except Exception as e:
            app.log(f"TabPlacement: failed to set tabPositioning: {e}")

    tabs_per_contour = operation.parameters.itemByName("tabsPerContour")
    if tabs_per_contour is None:
        app.log("TabPlacement: this operation has no tabsPerContour parameter.")
        return False
    try:
        tabs_per_contour.value.value = 0
    except Exception as e:
        app.log(f"TabPlacement: failed to disable automatic tabs: {e}")
        return False

    positions_param = operation.parameters.itemByName("tabPositions")
    if positions_param is None:
        app.log("TabPlacement: this operation has no tabPositions (Manual Tabs) parameter.")
        return False
    if not tab_points:
        app.log("TabPlacement: no candidate points to assign to Manual Tabs.")
        return False
    try:
        positions_param.value.value = list(tab_points)
    except Exception as e:
        app.log(f"TabPlacement: setting Manual Tabs to {len(tab_points)} point(s) failed: {e}")
        return False

    # Read back what Fusion actually kept, rather than assuming the
    # assignment above stuck.
    #
    # Nothing here used to verify anything, and that is exactly how this
    # module's real tab-placement bug stayed invisible. Tab positions were
    # being taken from the wrong face for a long time - every one of them
    # off the contour, so not a single manual tab could be placed - and the
    # job still reported success every time.
    #
    # The pattern in both: a Fusion CAM parameter accepts what it is given,
    # reports success, and does something else. So assignments here are
    # checked, not trusted.
    accepted = None
    try:
        accepted = len(positions_param.value.value)
    except Exception:
        pass
    if accepted is not None and accepted != len(tab_points):
        app.log(
            f"TabPlacement: WARNING - selected {len(tab_points)} tab point(s) but the "
            f"operation kept {accepted}. The dropped points are not on the contour "
            f"being cut, so Fusion cannot place a tab on them."
        )

    app.log(
        f"TabPlacement: Manual Tabs set to {len(tab_points)} point(s) "
        f"(operation kept {accepted}), {TAB_WIDTH_IN}in wide x "
        f"{TAB_HEIGHT_IN}in tall"
    )
    return True


def ConfigureTabs(min_tabs: int = DEFAULT_MIN_TABS, max_tabs: int = DEFAULT_MAX_TABS):
    app = adsk.core.Application.get()
    # Not app.activeProduct - by the time this runs, SetupGenerator() has
    # already switched the active product to CAM (camWS.activate()), so
    # app.activeProduct is a CAM object with no rootComponent (confirmed
    # by a real run: "AttributeError: 'CAM' object has no attribute
    # 'rootComponent'"). Same DesignProductType lookup camPlate.py's own
    # start() already uses elsewhere for exactly this reason.
    design = adsk.fusion.Design.cast(
        app.activeDocument.products.itemByProductType("DesignProductType")
    )
    if design is None:
        app.log("TabPlacement: no active Design product found, skipping tab configuration")
        return
    comp: adsk.fusion.Component = design.rootComponent

    bodies = [
        occ.bRepBodies.item(0)
        for occ in comp.allOccurrences
        if occ.bRepBodies.count > 0
    ]
    if not bodies:
        app.log("TabPlacement: no bodies found, skipping tab configuration")
        return

    cam = adsk.cam.CAM.cast(
        app.activeDocument.products.itemByProductType("CAMProductType")
    )
    if cam is None:
        return

    for setup in cam.setups:
        # The real machining bounds of this setup's plate, straight from
        # Fusion's own computed stock parameters - not a guess, and not
        # the part's own bounding box (a part positioned close to the
        # plate's own edge - AutoArrange's frame margin used up on that
        # side, or a corner placement - can have real sides with little
        # to no stock actually behind them; see _has_real_stock_backing).
        # None (any parameter missing) means "skip this filter, don't
        # place zero tabs from a name lookup failing."
        stock_bounds = None
        try:
            x_low = float(setup.parameters.itemByName("stockXLow").expression)
            x_high = float(setup.parameters.itemByName("stockXHigh").expression)
            y_low = float(setup.parameters.itemByName("stockYLow").expression)
            y_high = float(setup.parameters.itemByName("stockYHigh").expression)
            stock_bounds = (x_low, x_high, y_low, y_high)
        except Exception as e:
            app.log(f"TabPlacement: could not read stock bounds, skipping the real-stock-backing check: {e}")

        # Only the ONE contour2d operation the template itself designates
        # for tabs (group_tabs already true in the template's own default,
        # read here before this function ever touches it) - confirmed
        # directly against the real exported template
        # ((DEPRECATED)971 Metal Sheet.f3dhsm-template): of its three
        # contour2d operations ("Shape Through Finishing Pass", "Shape
        # Pocket Finishing Pass", "2D Slot Cut"), only "2D Slot Cut"
        # defaults group_tabs to true - the other two are finishing passes
        # for individual internal features, not the outer profile that
        # actually holds the part to stock. This function used to enable
        # group_tabs and apply the BODY's outer-boundary tab edges to every
        # contour2d operation indiscriminately, including those finishing
        # passes - confirmed live as a real bug (small, wrong-looking tabs
        # applied to operations that cut internal features, nothing to do
        # with holding the part to stock).
        contour_ops = []
        for op in setup.operations:
            if op.strategy != "contour2d":
                continue
            group_tabs_param = op.parameters.itemByName("group_tabs")
            if group_tabs_param is None:
                continue
            try:
                already_tabbed = str(group_tabs_param.expression).strip().lower() == "true"
            except Exception:
                already_tabbed = False
            if already_tabbed:
                contour_ops.append(op)
        if not contour_ops:
            continue

        for op in contour_ops:
            # An operation reaching here already has group_tabs=true in the
            # template's own default - group_tabs is exactly Fusion's own
            # "distribute tabs across every body in the setup" flag, so this
            # operation is BY DEFINITION the one shared outer-profile cut
            # that releases every nested part from stock at once, not one
            # specific part's own operation. Confirmed live: on a real
            # 2-part grouped job, this is a single "2D Slot Cut" operation
            # whose own resolved geometry selection spans both bodies - an
            # earlier version of this function tried to match it to exactly
            # ONE body (the right approach for a part-specific finishing
            # pass, the wrong one for this), which always failed to match
            # and silently left this operation with NO tabs at all on every
            # grouped job. Fixed by computing candidate/exclusion edges from
            # EVERY body on the plate and combining them, single-part or
            # grouped - for a single-body plate this is exactly the old
            # single_body behavior (the loop below runs once).
            all_tab_points = []
            for body in bodies:
                perimeter_in = _outer_perimeter_in(body)
                body_min_tabs = _min_tabs_for_body(body, min_tabs)
                target_tabs = _tab_count_for_perimeter(perimeter_in, body_min_tabs, max_tabs)
                body_candidates = select_tab_edges(body, max_tabs=target_tabs, stock_bounds=stock_bounds)
                if len(body_candidates) < body_min_tabs:
                    app.log(
                        f"TabPlacement: '{op.name}' - a nested body only had "
                        f"{len(body_candidates)} straight edge(s) long enough "
                        f"to hold a tab (wanted at least {body_min_tabs} of "
                        f"{target_tabs} target, perimeter {perimeter_in:.1f}in) "
                        "- using what's available rather than placing a tab "
                        "on a rounded or too-short edge."
                )
                tab_face = _find_tab_face(body)
                tab_points = _manual_tab_points(app, comp, tab_face, body_candidates)
                if len(tab_points) != len(body_candidates):
                    app.log(
                        f"TabPlacement: '{op.name}' - could not create all explicit tab points "
                        f"for a nested body; leaving this operation unchanged."
                    )
                    all_tab_points = []
                    break
                all_tab_points.extend(tab_points)

            if not all_tab_points:
                app.log(f"TabPlacement: '{op.name}' - no usable explicit tab points found on any body, skipping.")
                continue

            applied = _apply_manual_tabs(app, op, all_tab_points)
            if not applied:
                app.log(f"TabPlacement: '{op.name}' could not configure Manual Tabs.")
