# Configures holding tabs on the 2D Contour (outer profile) toolpath -
# direct instruction: at least 3-4 tabs, only on straight edges (never a
# rounded/filleted one - a tab needs flat contact, not a curve), preferring
# the longest straight edges available, on every material (this file has no
# material-specific logic at all - tab geometry is a stock-retention concern,
# independent of what the stock is cut from; feed rate/material handling is
# a separate, not-yet-started piece of work).
#
# Fusion's own tab parameters (tabsPerContour, tabWidth, tabHeight,
# tabPositioning, tabPositions, group_tabs - see the contour2d template's
# defaults) aren't part of the typed adsk.cam API surface at all (confirmed:
# no hits anywhere in the installed API for "tabPositioning") - they're
# generic, string-keyed CAM parameters Fusion defines internally per
# strategy, with no public documentation of valid enum values.
#
# A first attempt guessed at tabPositioning's enum value for "manual points"
# mode and got it wrong (see git history) - a real Fusion export of a 2D
# Contour operation with manually-placed tabs
# (templates/reference-tab-positions.f3dhsm-template, description="2D Slot
# Cut" - reference only, never loaded at runtime, same role
# _upstream/ plays elsewhere in this repo) showed the real mechanism is
# different from what was guessed: tabPositioning stays 'distance' even
# with manual points -
# it's tabPositions itself that's the actual toggle/data (shown as the
# literal `true` in the exported template, since a template can't preserve
# a live geometry/point reference tied to one specific part - contours=true
# shows the same flattening for the operation's own geometry selection).
# The reference also had group_tabs=true (default is false) alongside it.
# So: leave tabPositioning alone, set group_tabs=true, and set tabPositions
# to the real computed points directly - no enum guessing needed here.
#
# GROUPED (multi-part) jobs: confirmed as a real, live bug, not theoretical.
# This file used to gather candidate tab edges from EVERY body in the
# document and apply that same mixed-body list to EVERY contour2d operation
# in the setup - correct only by coincidence for a single-part job (the only
# case this was ever tested against). On a real grouped job (multiple
# different parts nested on one plate, confirmed live via the Fusion MCP
# bridge against an actual 9-part plate), that meant a given part's cut
# operation could receive tab edges belonging to a DIFFERENT part entirely -
# a tab reference with no real stock behind it, which is exactly what
# produced a real "Failed to post data" error on an actual job. Fixed by
# matching each contour2d operation to the ONE body it actually cuts before
# picking tab edges for it, instead of assuming there's only one body.
#
# There is no direct API from an Operation back to "which body does this
# cut" - adsk.cam.Operation exposes no body/model accessor. The matching
# here works by reading the operation's own RESOLVED geometry selection
# (real curve data Fusion has already computed for it, not a guess) and
# testing which body's bounding box contains it - bodies on a nested plate
# don't overlap by construction, so this is unambiguous.
import adsk.core
import adsk.fusion
import adsk.cam


DEFAULT_MIN_TABS = 3
DEFAULT_MAX_TABS = 8
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
    """Largest planar, upward-facing face on a body - same "top face"
    concept AutoArrange.py/SetupGenerator.py already use, kept independent
    since this module has no import relationship with either.
    """
    best_face = None
    best_area = 0.0
    for face in body.faces:
        try:
            normal = face.geometry.normal
        except Exception:
            continue
        if normal.z > 0.9 and face.area > best_area:
            best_area = face.area
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


def select_tab_edges(body, max_tabs: int = DEFAULT_MAX_TABS):
    """Straight edges on the body's own outer boundary, spread across
    distinct straight lines (longest line first) rather than clustered
    onto one, capped at max_tabs. Never returns a curved/filleted edge, an
    internal-loop (hole/pocket) edge, or one too short to physically hold a
    tab - direct instruction, not a preference to relax if a part is mostly
    rounded or small.

    One tab per distinct line first (so at least 2 different sides get a
    tab whenever the part actually has that many straight sides), then
    fills any remaining budget from additional segments of the longest
    line(s) if the part doesn't have enough distinct straight lines to
    reach max_tabs on its own.
    """
    top_face = _find_top_face(body)
    if top_face is None:
        return []
    min_length_cm = MIN_TAB_EDGE_LENGTH_IN * 2.54
    straight_edges = [
        e
        for e in _outer_boundary_edges(top_face)
        if _is_straight_edge(e) and _edge_length(e) >= min_length_cm
    ]
    straight_edges.sort(key=_edge_length, reverse=True)

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


def _operation_sample_point(operation):
    """A real XYZ point Fusion has already resolved for this operation's own
    geometry selection - used only to figure out which body the operation
    belongs to (see module header), not for the tab positions themselves.
    Tries the contour2d "contours" parameter first, then the pocket-strategy
    "pockets" parameter, since which one exists depends on strategy. Returns
    None if the operation has no resolved selection yet (nothing to match
    against - caller falls back to the single-body case).
    """
    for param_name in ("contours", "pockets"):
        param = operation.parameters.itemByName(param_name)
        if param is None:
            continue
        value = param.value
        if not hasattr(value, "getCurveSelections"):
            continue
        try:
            selections = value.getCurveSelections()
            for i in range(selections.count):
                output = selections.item(i).outputGeometry
                for path in output:
                    if path.count == 0:
                        continue
                    curve = path.item(0)
                    point = getattr(curve, "startPoint", None)
                    if point is not None:
                        return point
        except Exception:
            continue
    return None


def _match_body_for_point(bodies, point, margin_cm: float = 0.5):
    """Which body's own footprint contains this point, if any. Nested parts
    on a plate don't overlap by construction, so a small margin (to absorb
    the point sitting exactly on a boundary) is enough to disambiguate
    safely - this is not a fuzzy/best-guess match, it's the one body whose
    real bounding box actually contains the point.
    """
    if point is None:
        return None
    matches = []
    for body in bodies:
        bb = body.boundingBox
        if (
            bb.minPoint.x - margin_cm <= point.x <= bb.maxPoint.x + margin_cm
            and bb.minPoint.y - margin_cm <= point.y <= bb.maxPoint.y + margin_cm
        ):
            matches.append(body)
    if len(matches) == 1:
        return matches[0]
    return None


def _apply_tab_positions(app, operation, points) -> bool:
    """Sets tabPositions to the real computed points and group_tabs=true,
    per a real Fusion export showing this is the actual mechanism (see this
    module's header comment) - tabPositioning itself is left untouched.
    Returns True only if tabPositions was actually accepted - the caller
    falls back to safe automatic placement otherwise, and this always logs
    which outcome happened so it's visible in Fusion's Text Commands
    console instead of failing silently.
    """
    positions_param = operation.parameters.itemByName("tabPositions")
    if positions_param is None:
        app.log("TabPlacement: this operation has no tabPositions parameter - leaving tabs at whatever the template default is.")
        return False

    group_tabs_param = operation.parameters.itemByName("group_tabs")
    if group_tabs_param is not None:
        try:
            group_tabs_param.expression = "true"
        except Exception as e:
            app.log(f"TabPlacement: failed to set group_tabs: {e}")

    try:
        positions_param.value.value = list(points)
    except Exception as e:
        app.log(f"TabPlacement: setting tabPositions to {len(points)} point(s) failed: {e}")
        return False

    app.log(f"TabPlacement: tabPositions set to {len(points)} point(s)")
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

    single_body = bodies[0] if len(bodies) == 1 else None

    for setup in cam.setups:
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
            # Single-part jobs (still the common case) have no ambiguity -
            # skip the geometry-matching machinery entirely and use the one
            # body directly. Grouped jobs match each operation to its own
            # body via its already-resolved selection geometry (see
            # _operation_sample_point/_match_body_for_point above) - if that
            # match fails for some reason (operation not yet generated,
            # unexpected geometry shape), skip tabs for THIS operation only
            # rather than guessing with another part's edges, which is the
            # exact bug this rework fixes.
            if single_body is not None:
                body = single_body
            else:
                point = _operation_sample_point(op)
                body = _match_body_for_point(bodies, point)
                if body is None:
                    app.log(
                        f"TabPlacement: could not match '{op.name}' to a single "
                        "body on this grouped plate - skipping tabs for this "
                        "operation rather than risking edges from a different "
                        "part."
                    )
                    continue

            perimeter_in = _outer_perimeter_in(body)
            target_tabs = _tab_count_for_perimeter(perimeter_in, min_tabs, max_tabs)
            candidate_edges = select_tab_edges(body, max_tabs=target_tabs)

            if len(candidate_edges) < min_tabs:
                app.log(
                    f"TabPlacement: '{op.name}' - only found "
                    f"{len(candidate_edges)} straight edge(s) long enough to "
                    f"hold a tab (wanted at least {min_tabs} of {target_tabs} "
                    f"target, perimeter {perimeter_in:.1f}in) - using what's "
                    "available rather than placing a tab on a rounded or "
                    "too-short edge."
                )
            if not candidate_edges:
                continue

            # A real run showed setting tabPositions to bare adsk.core.Point3D
            # coordinates fails: "InternalValidationError:
            # Xl::Utils::findObjectPath(item.get(), logicalPath)" - Fusion's
            # generic parameter system resolves an object's "logical path"
            # within the document, which a synthesized coordinate has no way
            # to provide (it isn't a real document entity). The candidate
            # edges themselves ARE real document entities with a resolvable
            # path, so passing those directly instead of computed midpoints
            # is what's used here - confirmed working against real jobs.
            points = candidate_edges

            tabs_per_contour = op.parameters.itemByName("tabsPerContour")
            if tabs_per_contour is not None:
                try:
                    tabs_per_contour.expression = str(len(candidate_edges))
                except Exception as e:
                    app.log(f"TabPlacement: failed to set tabsPerContour: {e}")

            applied = _apply_tab_positions(app, op, points)
            if not applied:
                # Safe fallback: still automatic/distance-based, but sized
                # so the target tab count is at least roughly achieved
                # instead of leaving the template's default (tool_diameter
                # * 8, usually far more than a few tabs' worth of spacing on
                # a real plate-sized contour). Perimeter/edge count are this
                # operation's OWN matched body's, not a different part's.
                tab_distance = op.parameters.itemByName("tabDistance")
                if tab_distance is not None and perimeter_in and len(candidate_edges) > 0:
                    try:
                        spacing_in = perimeter_in / len(candidate_edges)
                        tab_distance.expression = f"{spacing_in:.4f} in"
                    except Exception as e:
                        app.log(f"TabPlacement: failed to set fallback tabDistance: {e}")
