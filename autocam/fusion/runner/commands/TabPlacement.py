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
# Fusion exposes only `distance` and `tabCount` placement modes. Manual
# tab geometry is not used here: on a real Dih job it did not preserve the
# requested physical tab count. tabCount gives Fusion the count contract;
# noTabZones gives it the geometry contract. Every rounded, short, or
# stock-unbacked outer edge is a no-tab zone, so count-based placement can
# only choose from the same straight, usable edges this module calculates.
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
# A tab needs enough straight run to actually hold a realistic tab width
# plus clearance on each side - an edge shorter than this can't take one
# safely regardless of how the count/spacing math comes out.
MIN_TAB_EDGE_LENGTH_IN = 0.5
# Went through 0.15in (too small, per direct feedback: "a tab that thin
# doesn't hold real material") and 0.25in (an intermediate compromise, back
# when tabs were still placed via tabCount/noTabZones and a too-wide tab
# could bridge a short straight run into an adjacent corner fillet). Direct
# instruction: 0.6in - the template's own original default. Bridging a
# short run into a corner is no longer the same risk it was under
# tabCount/noTabZones placement. Fusion distributes the computed count only
# across the usable straight runs left after bad edges are excluded.
TAB_WIDTH_IN = 0.6


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


def _find_top_face(body):
    """Return the highest upward-facing planar face on a body.

    STEP imports can report opposing planar faces as upward-facing. Height
    avoids the equal-area tie and unstable Fusion face iteration order.

    Direct instruction: tab candidate/exclusion edges should reference the
    upper edge of the part (unlike the outer-profile/feature-cut contour
    selections themselves, which reference the bottom edge - see
    DeleteToolpaths.py's _bottom_face) - tabs and the contour they sit on
    are deliberately different edge loops here, per direct correction.
    """
    best_face = None
    best_z = None
    for face in body.faces:
        try:
            normal = face.geometry.normal
            z = face.pointOnFace.z
        except Exception:
            continue
        if normal.z > 0.9 and (best_z is None or z > best_z):
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
    top_face = _find_top_face(body)
    if top_face is None:
        return 0.0
    return sum(_edge_length(e) for e in _outer_boundary_edges(top_face)) / 2.54


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


def _good_straight_edges(body, stock_bounds=None):
    """Every straight, long-enough, stock-backed edge on body's own outer
    boundary - the full set of genuinely usable tab locations (not capped
    to any count). Shares its filter predicate with select_tab_edges
    below; kept separate because this one is also used to compute the
    complementary noTabZones set (see _no_tab_zone_edges) via a plain "not
    in this set" check on the same face's full outer boundary.
    """
    top_face = _find_top_face(body)
    if top_face is None:
        return []
    min_length_cm = MIN_TAB_EDGE_LENGTH_IN * 2.54
    stock_check_cm = STOCK_BACKING_CHECK_IN * 2.54
    body_center = adsk.core.Point3D.create(
        (body.boundingBox.minPoint.x + body.boundingBox.maxPoint.x) / 2,
        (body.boundingBox.minPoint.y + body.boundingBox.maxPoint.y) / 2,
        0,
    )
    return [
        e
        for e in _outer_boundary_edges(top_face)
        if _is_straight_edge(e)
        and _edge_length(e) >= min_length_cm
        and _has_real_stock_backing(e, body_center, stock_bounds, stock_check_cm)
    ]


def _no_tab_zone_edges(body, stock_bounds=None):
    """Every outer-boundary edge that ISN'T a good tab candidate - curved/
    filleted, too short, or with no real stock behind it - for Fusion's own
    noTabZones parameter. Feeding these to noTabZones makes it physically
    impossible for Fusion's automatic tabCount-mode placement to land a tab
    on a curve, a too-short stub, or a side with nothing real behind it.
    """
    top_face = _find_top_face(body)
    if top_face is None:
        return []
    good_ids = {id(e) for e in _good_straight_edges(body, stock_bounds)}
    return [e for e in _outer_boundary_edges(top_face) if id(e) not in good_ids]


def _distinct_straight_line_count(body, stock_bounds=None) -> int:
    """How many genuinely different straight sides body's outer boundary
    has, after collapsing multi-segment sides (a fillet/tangent
    transition point splitting what's really one line) - used only to
    decide the target tab count (see _min_tabs_for_body), not to place
    tabs directly.
    """
    straight_edges = _good_straight_edges(body, stock_bounds)
    lines: list[list] = []
    for edge in straight_edges:
        for line in lines:
            if _edges_collinear(edge, line[0]):
                line.append(edge)
                break
        else:
            lines.append([edge])
    return len(lines)


def _min_tabs_for_body(body, min_tabs: int, stock_bounds=None) -> int:
    """A triangular part only has 3 real sides to begin with - padding a
    4th tab onto one already-tabbed side doesn't add real holding power,
    it just doubles up on one side. Direct instruction: 4 or more tabs
    normally, but exactly 3 for a triangular shape. Anything with 4+
    distinct sides still uses the normal min_tabs floor (parametric -
    ConfigureTabs's own min_tabs/max_tabs arguments, not hardcoded here).
    """
    if _distinct_straight_line_count(body, stock_bounds) == 3:
        return 3
    return min_tabs


def select_tab_edges(body, max_tabs: int = DEFAULT_MAX_TABS, stock_bounds=None):
    """Straight edges on the body's own outer boundary, spread across
    distinct straight lines (longest line first) rather than clustered
    onto one, capped at max_tabs. Never returns a curved/filleted edge, an
    internal-loop (hole/pocket) edge, one too short to physically hold a
    tab, or one with no real stock behind it (see _has_real_stock_backing)
    - direct instruction, not a preference to relax if a part is mostly
    rounded, small, or sitting close to the plate's own edge.

    Used by ConfigureTabs to confirm there is at least one usable straight
    run and to build the complementary _no_tab_zone_edges list. Fusion's
    `tabCount` mode does the final placement; no-tab zones are what keep it
    off the bad edges.

    One tab per distinct line first (so at least 2 different sides get a
    tab whenever the part actually has that many straight sides), then
    fills any remaining budget from additional segments of the longest
    line(s) if the part doesn't have enough distinct straight lines to
    reach max_tabs on its own.
    """
    straight_edges = sorted(_good_straight_edges(body, stock_bounds), key=_edge_length, reverse=True)

    lines: list[list] = []
    for edge in straight_edges:
        for line in lines:
            if _edges_collinear(edge, line[0]):
                line.append(edge)
                break
        else:
            lines.append([edge])
    lines.sort(key=lambda line: _edge_length(line[0]), reverse=True)

    selected = [line[0] for line in lines[:max_tabs]]
    if len(selected) < max_tabs:
        for line in lines:
            for edge in line[1:]:
                if len(selected) >= max_tabs:
                    break
                selected.append(edge)
            if len(selected) >= max_tabs:
                break
    return selected


def _apply_automatic_tabs(app, operation, zone_edges, tab_count) -> bool:
    """Configure count-based tabs while excluding every unsafe edge.

    `tabCount` is the only source of tab count. `noTabZones` prevents its
    automatic placement from choosing rounded corners, short stubs, or an
    edge with no stock backing. This intentionally never writes Fusion's
    Manual Tabs (`tabPositions`) parameter.
    """
    positioning_param = operation.parameters.itemByName("tabPositioning")
    if positioning_param is not None:
        try:
            positioning_param.expression = "'tabCount'"
        except Exception as e:
            app.log(f"TabPlacement: failed to set tabPositioning to tabCount: {e}")

    # See TAB_WIDTH_IN's own comment - the template's own default (0.6in)
    # is too wide for this part's own straight runs, confirmed live to
    # bridge past a short edge into an adjacent corner fillet.
    width_param = operation.parameters.itemByName("tabWidth")
    if width_param is not None:
        try:
            width_param.expression = f"{TAB_WIDTH_IN}in"
        except Exception as e:
            app.log(f"TabPlacement: failed to set tabWidth: {e}")

    tabs_per_contour = operation.parameters.itemByName("tabsPerContour")
    if tabs_per_contour is None:
        app.log("TabPlacement: this operation has no tabsPerContour parameter.")
        return False
    try:
        tabs_per_contour.expression = str(tab_count)
    except Exception as e:
        app.log(f"TabPlacement: failed to set tabsPerContour to {tab_count}: {e}")
        return False

    zones_param = operation.parameters.itemByName("noTabZones")
    if zones_param is not None and zone_edges:
        try:
            zones_param.value.value = list(zone_edges)
        except Exception as e:
            app.log(f"TabPlacement: setting noTabZones to {len(zone_edges)} edge(s) failed: {e}")

    app.log(
        f"TabPlacement: tabCount={tab_count}, width={TAB_WIDTH_IN}in, "
        f"no-tab zones set on {len(zone_edges)} edge(s)"
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
            all_candidates = []
            all_zone_edges = []
            total_perimeter_in = 0.0
            total_target_tabs = 0
            for body in bodies:
                perimeter_in = _outer_perimeter_in(body)
                body_min_tabs = _min_tabs_for_body(body, min_tabs, stock_bounds)
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
                all_candidates.extend(body_candidates)
                all_zone_edges.extend(_no_tab_zone_edges(body, stock_bounds))
                total_perimeter_in += perimeter_in
                total_target_tabs += target_tabs
            candidate_edges = all_candidates
            perimeter_in = total_perimeter_in

            if not candidate_edges:
                app.log(f"TabPlacement: '{op.name}' - no usable tab edges found on any body, skipping.")
                continue

            applied = _apply_automatic_tabs(app, op, all_zone_edges, total_target_tabs)
            if not applied:
                app.log(f"TabPlacement: '{op.name}' could not configure automatic tabs.")
