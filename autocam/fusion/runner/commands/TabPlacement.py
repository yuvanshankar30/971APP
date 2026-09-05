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
import adsk.core
import adsk.fusion
import adsk.cam


DEFAULT_MIN_TABS = 3
DEFAULT_MAX_TABS = 4


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
    """Straight edges on the body's top-face boundary, spread across
    distinct straight lines (longest line first) rather than clustered
    onto one, capped at max_tabs. Never returns a curved/filleted edge -
    direct instruction, not a preference to relax if a part is mostly
    rounded.

    One tab per distinct line first (so at least 2 different sides get a
    tab whenever the part actually has that many straight sides), then
    fills any remaining budget from additional segments of the longest
    line(s) if the part doesn't have enough distinct straight lines to
    reach max_tabs on its own.
    """
    top_face = _find_top_face(body)
    if top_face is None:
        return []
    straight_edges = [e for e in top_face.edges if _is_straight_edge(e)]
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

    for setup in cam.setups:
        contour_ops = [op for op in setup.operations if op.strategy == "contour2d"]
        if not contour_ops:
            continue

        # Current real usage is one part per plate - candidate edges are
        # gathered across every body on the setup and applied to every
        # contour2d operation found. A future multi-part plate would need
        # this matched per-body/per-operation instead of shared across all
        # of them; not needed by anything tested so far.
        candidate_edges = []
        for body in bodies:
            candidate_edges.extend(select_tab_edges(body, max_tabs=max_tabs))
        candidate_edges.sort(key=_edge_length, reverse=True)
        candidate_edges = candidate_edges[:max_tabs]

        if len(candidate_edges) < min_tabs:
            app.log(
                f"TabPlacement: only found {len(candidate_edges)} straight "
                f"edge(s) long enough to hold a tab (wanted at least "
                f"{min_tabs}) - using what's available rather than placing "
                "a tab on a rounded edge."
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
        # is the next reasoned attempt - not yet confirmed against a live
        # run either.
        points = candidate_edges

        for op in contour_ops:
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
                # * 8, usually far more than 3-4 tabs' worth of spacing on
                # a real plate-sized contour). Perimeter comes from the
                # first body's own top-face edge loop (the actual outer
                # profile), not the whole body's edges (which would also
                # count vertical/bottom-face/hole edges that aren't part
                # of the contour this operation is even cutting).
                top_face = _find_top_face(bodies[0]) if bodies else None
                perimeter = (
                    sum(_edge_length(e) for e in top_face.edges) if top_face else None
                )
                tab_distance = op.parameters.itemByName("tabDistance")
                if tab_distance is not None and perimeter and len(candidate_edges) > 0:
                    try:
                        spacing_in = perimeter / len(candidate_edges) / 2.54
                        tab_distance.expression = f"{spacing_in:.4f} in"
                    except Exception as e:
                        app.log(f"TabPlacement: failed to set fallback tabDistance: {e}")
