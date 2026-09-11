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
# Raised from 10, live-confirmed too low for a large or complex part: a
# real plate with a 16.317in straight side got only ONE tab on it, because
# select_tab_edges spends its budget covering every distinct straight side
# once (breadth) BEFORE a second tab can ever land on a side that's simply
# much longer than the others - with enough short sides (a complex outline
# has plenty), breadth alone can consume the whole budget, leaving no
# "remaining_budget" for the redistribution pass that would otherwise give
# that long side the extra tab its own length clearly warrants. This does
# not touch how any single tab is placed (select_tab_edges' spacing/
# redistribution logic here is unchanged and already tested) - only how
# much total headroom a body gets. Deliberately moderate, not the 40 an
# earlier version of this constant jumped to (see git history) - that
# change was reverted together with an unrelated, separately-introduced
# zero-margin edge exclusion after the two together caused a real job to
# lose its release contour silently; this constant is raised alone, and
# camPlate.py's _require_release_contour now fails a job loudly instead of
# silently if a change like that ever recurs.
DEFAULT_MAX_TABS = 20
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
TARGET_TAB_SPACING_IN = 4.0
# How much of its OWN length a single straight side needs before it earns
# a second (or third) tab, in the common case where nothing was excluded
# for lack of real stock backing (see select_tab_edges' has_excluded_sides
# below). Deliberately much larger than TARGET_TAB_SPACING_IN - that
# constant scales a body's TOTAL tab count off its whole perimeter, a
# different question from "does this one side need more than one." Direct,
# live-confirmed correction: a real part with plenty of tabs already
# elsewhere still put 3 tabs on a single 8.211in side - too many for that
# side alone, wasted machining time, no real stability benefit over one.
# 8.0 keeps that same 8.211in side at exactly 1 tab (round(8.211/8.0)=1)
# while still giving the earlier-reported 16.317in starved-long-side case
# (see DEFAULT_MAX_TABS's own history above) its needed 2nd tab
# (round(16.317/8.0)=2) - tuned to both real, live-reported cases, not
# picked arbitrarily.
PER_SIDE_EXTRA_TAB_SPACING_IN = 8.0
# Every release tab has the same operator-specified dimensions. Candidate
# edges are selected directly, so Fusion cannot distribute a tab into a
# corner between them.
TAB_WIDTH_IN = 0.6
TAB_HEIGHT_IN = 0.15
# Grouped parts commonly sit one cutter-width apart. Two tabs centered at
# the same position on their facing edges then become one continuous bridge
# across that corridor. Keep a visible, machinable run of ordinary stock
# between their along-edge spans instead.
GROUPED_TAB_STOCK_GAP_IN = 0.1
# Fusion's Arrange result can differ from the requested object spacing by a
# small modeling tolerance. This keeps the facing-edge check tied to the
# actual requested spacing without relying on exact floating-point equality.
GROUPED_TAB_CORRIDOR_TOLERANCE_IN = 0.05
# A smaller nested part may not have a 1.2in straight run available for the
# default tab plus lead-in/lead-out. Do not make a tab narrower than this
# unless the geometry genuinely demands it.
MIN_TAB_WIDTH_IN = 0.2
# Tab height is remaining material, so it can never exceed the sheet itself.
# Keep one geometry for every tab in a job, using the thinnest nested body
# for grouped plates. 70% preserves the existing 0.15in height on 0.25in
# stock while leaving a physically valid 0.044in tab on 0.063in sheet.
MAX_TAB_HEIGHT_FRACTION = 0.70

# The shortest side that may carry a tab, derived from the tab itself
# rather than picked as a round number.
#
# A tab occupies TAB_WIDTH_IN of the edge, so a shorter run cannot contain
# even one valid tab.  This corrects the former 0.5in floor, which was shorter
# than the 0.6in tab itself.  Deriving the gate from TAB_WIDTH_IN means it
# cannot drift if the tab size is retuned.
#
# A side shorter than the physical tab itself gets no tab.  This is a hard
# validity gate, not a preference: selecting an undersized edge causes Fusion
# to create malformed manual-tab geometry.  Keep this tied to the configured
# tab width so the threshold stays correct if the tab is retuned.
MIN_TAB_SIDE_LENGTH_IN = TAB_WIDTH_IN * 1.25

# Kept as the coarse "is this edge even worth considering" filter. The real
# gate is MIN_TAB_SIDE_LENGTH_IN above, applied per side after collinear
# segments are grouped.
MIN_TAB_EDGE_LENGTH_IN = 0.5

# Direct instruction: "TABS SHOULD NEVER GENERATE DIRECTLY ON THE PATH OF
# THE AXES" - a tab whose own position sits on (or crosses) the setup's
# own X=0 or Y=0 line visually overlaps the WCS origin's own axis gizmo
# and has produced malformed manual-tab geometry live, not merely an
# ugly-but-harmless coincidence. Confirmed live: a part nested with one
# side running near-parallel to and close against a coordinate axis had
# every one of its tabs pile onto that single side because the OTHER
# sides were excluded for lacking real stock backing - a separate, already
# -handled failure mode (see _has_real_stock_backing) that this margin
# does not replace. This margin is deliberately small: it exists to dodge
# a literal, degenerate on-the-line coincidence, not to steer tabs away
# from an edge merely because it happens to run near an axis.
AXIS_AVOIDANCE_MARGIN_IN = 0.05


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


def _body_thickness_in(body) -> float:
    try:
        bounds = body.boundingBox
        return abs(float(bounds.maxPoint.z) - float(bounds.minPoint.z)) / 2.54
    except Exception:
        return 0.0


def _body_minimum_planar_span_in(body) -> float:
    """Smallest X/Y extent of a body's arranged geometry in inches."""
    try:
        bounds = body.boundingBox
        x_span = abs(float(bounds.maxPoint.x) - float(bounds.minPoint.x)) / 2.54
        y_span = abs(float(bounds.maxPoint.y) - float(bounds.minPoint.y)) / 2.54
        return min(x_span, y_span)
    except Exception:
        return 0.0


def _tab_width_for_bodies(bodies) -> float:
    """Return one safe, uniform tab width for all bodies in this setup."""
    spans = [span for span in (_body_minimum_planar_span_in(body) for body in bodies) if span > 0]
    if not spans:
        return TAB_WIDTH_IN

    # The side-selection rule reserves two tab widths: the tab itself plus
    # useful lead-in/lead-out. Leave a small lower floor for cutter stability;
    # exceptionally tiny parts still use the existing longest-side fallback.
    return min(TAB_WIDTH_IN, max(MIN_TAB_WIDTH_IN, min(spans) * 0.45))


def _tab_height_for_bodies(bodies) -> float:
    """Return one safe, uniform tab height for all bodies in this setup."""
    thicknesses = [thickness for thickness in (_body_thickness_in(body) for body in bodies) if thickness > 0]
    if not thicknesses:
        # Geometry inspection should not turn into an unheld part. Preserve
        # the established maximum when Fusion cannot report a body thickness.
        return TAB_HEIGHT_IN
    return min(TAB_HEIGHT_IN, min(thicknesses) * MAX_TAB_HEIGHT_FRACTION)


def _tab_count_for_perimeter(perimeter_in: float, min_tabs: int, max_tabs: int) -> int:
    if perimeter_in <= 0:
        return min_tabs
    target = round(perimeter_in / TARGET_TAB_SPACING_IN)
    return max(min_tabs, min(max_tabs, target))


def _tab_desired_count(line_length_in: float) -> int:
    """How many tabs a single straight side's own length calls for - see
    PER_SIDE_EXTRA_TAB_SPACING_IN for why this uses a much larger spacing
    than the whole-body budget does. Never below 1: only ever consulted
    for a line that already holds at least one tab.
    """
    return max(1, round(line_length_in / PER_SIDE_EXTRA_TAB_SPACING_IN))


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


def _edge_point_at_fraction(edge, fraction: float):
    """A point ``fraction`` of the way from an edge's start to its end -
    0.5 is the midpoint, used for the normal one-tab-per-side case; other
    values let more than one tab share a single straight side (see
    _tab_fractions and select_tab_edges).
    """
    geom = edge.geometry
    start, end = geom.startPoint, geom.endPoint
    return adsk.core.Point3D.create(
        start.x + (end.x - start.x) * fraction,
        start.y + (end.y - start.y) * fraction,
        start.z + (end.z - start.z) * fraction,
    )


def _edge_midpoint(edge):
    return _edge_point_at_fraction(edge, 0.5)


def _to_wcs_uv(point, wcs_frame):
    """point (any object with .x/.y/.z, in the same root/arranged frame
    edge.geometry is already expressed in - see _manual_tab_points' own
    docstring on why that must already be true) re-expressed as (u, v)
    coordinates in wcs_frame's own axes. wcs_frame is (origin, x_axis,
    y_axis), each an (x, y, z) tuple - origin is the WCS's own position in
    that same root frame, x_axis/y_axis its own (already unit-length)
    basis vectors. This is the actual coordinate system a real WCS origin
    gizmo is drawn in, which a body's own raw geometry coordinates are NOT
    the same thing as (a part's own local/arranged coordinates can place
    its corner literally at (0, 0, 0) with no relationship at all to
    where the CAM setup's own WCS origin actually sits) - confirmed live
    as a real bug in an earlier version of the axis-avoidance check below,
    which compared raw edge coordinates against literal zero and
    (correctly, but for the wrong reason) flagged every edge of a test
    fixture rectangle deliberately built with a corner at the origin.
    """
    origin, x_axis, y_axis = wcs_frame
    dx, dy, dz = point.x - origin[0], point.y - origin[1], point.z - origin[2]
    u = dx * x_axis[0] + dy * x_axis[1] + dz * x_axis[2]
    v = dx * y_axis[0] + dy * y_axis[1] + dz * y_axis[2]
    return u, v


def _axis_crossing_fraction_ranges(edge, margin_cm: float, wcs_frame) -> list[tuple[float, float]]:
    """Fraction ranges (0-1, clamped) along edge whose point falls within
    margin_cm of the coordinate-axis lines U=0 or V=0 in wcs_frame's own
    axes - "on the path of the axes," meaning the real WCS origin gizmo
    visible in Fusion's own viewport, not a coincidental raw-coordinate
    zero (see _to_wcs_uv). Empty when the edge never comes within
    margin_cm of either axis anywhere along its own length. A range can be
    the full (0.0, 1.0) span when the edge runs exactly along an axis for
    its entire length (a constant u or v within the margin) - that side
    has no safe position at all, not just a forbidden sub-range of one.

    wcs_frame is None whenever the real WCS is not available to the
    caller (a unit test with no live Fusion setup, or a caller that
    genuinely could not read it) - axis-checking is skipped entirely
    rather than guessing at what "the axes" means without it, the same
    "None means don't filter" convention stock_bounds already uses
    elsewhere in this module.
    """
    if wcs_frame is None:
        return []
    geom = edge.geometry
    start_u, start_v = _to_wcs_uv(geom.startPoint, wcs_frame)
    end_u, end_v = _to_wcs_uv(geom.endPoint, wcs_frame)
    ranges = []
    for start_coord, end_coord in ((start_u, end_u), (start_v, end_v)):
        delta = end_coord - start_coord
        if abs(delta) < 1e-9:
            # Constant coordinate along the whole edge - forbidden for its
            # entire length if that constant itself is within the margin.
            if abs(start_coord) <= margin_cm:
                ranges.append((0.0, 1.0))
            continue
        # coord(f) = start_coord + f * delta; solve |coord(f)| <= margin_cm.
        f_a = (-margin_cm - start_coord) / delta
        f_b = (margin_cm - start_coord) / delta
        lo, hi = (f_a, f_b) if f_a <= f_b else (f_b, f_a)
        lo = max(0.0, lo)
        hi = min(1.0, hi)
        if lo <= hi:
            ranges.append((lo, hi))
    return ranges


def _is_fraction_axis_safe(edge, fraction: float, margin_cm: float, wcs_frame) -> bool:
    return not any(lo <= fraction <= hi for lo, hi in _axis_crossing_fraction_ranges(edge, margin_cm, wcs_frame))


def _axis_safe_interior_bounds(edge, margin_cm: float, half_width_cm: float, wcs_frame):
    """The (low, high) fraction span on edge that is BOTH inside its own
    usable interior (half_width_cm clear of each corner, same margin every
    tab on this module already needs for lead-in/lead-out) AND off both
    coordinate axes - None if no such span exists at all, meaning this
    edge cannot safely hold a tab anywhere along its length (it runs along
    an axis for its full interior span, or that span is too short for the
    tab's own half-width to begin with). Always returns the full interior
    span (no exclusion) when wcs_frame is None - see
    _axis_crossing_fraction_ranges.
    """
    edge_length = _edge_length(edge)
    if edge_length <= 0 or edge_length < half_width_cm * 2:
        return None
    half_width_frac = half_width_cm / edge_length
    low, high = half_width_frac, 1.0 - half_width_frac
    if low > high:
        return None
    forbidden = _axis_crossing_fraction_ranges(edge, margin_cm, wcs_frame)
    # Walk the interior span left to right, keeping whichever safe segment
    # is largest - a side split by a single axis crossing near its middle
    # (the common real case: the axis passes through, not along, the edge)
    # still has two real candidate segments, and the larger one should win.
    boundaries = sorted({low, high, *(b for r in forbidden for b in r if low <= b <= high)})
    best = None
    for a, b in zip(boundaries, boundaries[1:]):
        midpoint = (a + b) / 2
        if any(lo <= midpoint <= hi for lo, hi in forbidden):
            continue
        if best is None or (b - a) > (best[1] - best[0]):
            best = (a, b)
    return best


def _nearest_axis_safe_fraction(edge, preferred_fraction: float, margin_cm: float, half_width_cm: float, wcs_frame):
    """The fraction nearest preferred_fraction that keeps the tab both off
    the coordinate axes and inside edge's own usable interior span - None
    if _axis_safe_interior_bounds finds no such span exists on this edge
    at all (the caller must then treat the whole edge as unusable, the
    same way a too-short or unbacked edge already is - see
    select_tab_edges' own usable/backed filtering).
    """
    bounds = _axis_safe_interior_bounds(edge, margin_cm, half_width_cm, wcs_frame)
    if bounds is None:
        return None
    low, high = bounds
    return min(high, max(low, preferred_fraction))


def _outward_edge_normal(edge, body_center):
    """Unit XY normal pointing from a body's candidate edge into stock."""
    direction, _ = _edge_direction_and_point(edge)
    midpoint = _edge_midpoint(edge)
    normal = adsk.core.Vector3D.create(-direction.y, direction.x, 0)
    toward_edge = adsk.core.Vector3D.create(
        midpoint.x - body_center.x,
        midpoint.y - body_center.y,
        0,
    )
    if normal.dotProduct(toward_edge) < 0:
        normal = adsk.core.Vector3D.create(-normal.x, -normal.y, 0)
    normal.normalize()
    return normal


def _parallel_tab_span_gap(edge_a, fraction_a, edge_b, fraction_b, tab_width_cm):
    """Along-edge stock gap between two parallel tab spans, in centimeters."""
    direction_a, _ = _edge_direction_and_point(edge_a)
    direction_b, _ = _edge_direction_and_point(edge_b)
    if abs(direction_a.dotProduct(direction_b)) < 0.98:
        return None
    point_a = _edge_point_at_fraction(edge_a, fraction_a)
    point_b = _edge_point_at_fraction(edge_b, fraction_b)
    center_separation = abs(
        (point_b.x - point_a.x) * direction_a.x
        + (point_b.y - point_a.y) * direction_a.y
    )
    return center_separation - tab_width_cm


def _grouped_tabs_conflict(
    body_a,
    edge_a,
    fraction_a,
    body_b,
    edge_b,
    fraction_b,
    tab_width_cm,
    stock_gap_cm,
    corridor_max_cm,
):
    """Whether tabs on two bodies touch across the same stock corridor."""
    direction_a, _ = _edge_direction_and_point(edge_a)
    direction_b, _ = _edge_direction_and_point(edge_b)
    if abs(direction_a.dotProduct(direction_b)) < 0.98:
        return False

    midpoint_a = _edge_midpoint(edge_a)
    midpoint_b = _edge_midpoint(edge_b)
    between_midpoints = adsk.core.Vector3D.create(
        midpoint_b.x - midpoint_a.x,
        midpoint_b.y - midpoint_a.y,
        0,
    )
    normal_a = _outward_edge_normal(edge_a, _body_center(body_a))
    normal_b = _outward_edge_normal(edge_b, _body_center(body_b))
    # The edges must face one another. Parallel edges on the outer sides of
    # two parts do not share stock and must retain their normal midpoints.
    if normal_a.dotProduct(between_midpoints) <= 0:
        return False
    if normal_b.dotProduct(between_midpoints) >= 0:
        return False

    point_a = _edge_point_at_fraction(edge_a, fraction_a)
    point_b = _edge_point_at_fraction(edge_b, fraction_b)
    dx = point_b.x - point_a.x
    dy = point_b.y - point_a.y
    perpendicular_distance = abs(dx * direction_a.y - dy * direction_a.x)
    if perpendicular_distance > corridor_max_cm:
        return False

    span_gap = _parallel_tab_span_gap(
        edge_a, fraction_a, edge_b, fraction_b, tab_width_cm
    )
    return span_gap is not None and span_gap < stock_gap_cm - 1e-6


def _same_line_tabs_conflict(
    edge_a, fraction_a, edge_b, fraction_b, tab_width_cm, stock_gap_cm
):
    """Keep relocated tabs from crowding another tab on the same part side."""
    if not _edges_collinear(edge_a, edge_b):
        return False
    span_gap = _parallel_tab_span_gap(
        edge_a, fraction_a, edge_b, fraction_b, tab_width_cm
    )
    return span_gap is not None and span_gap < stock_gap_cm - 1e-6


def _relocation_fraction_options(edge, preferred_fraction, blockers, tab_width_cm, stock_gap_cm):
    """Nearest valid fractions, including exact boundaries around blockers."""
    edge_length = _edge_length(edge)
    if edge_length <= 0 or edge_length < tab_width_cm:
        return []
    half_width = tab_width_cm / 2
    low = half_width
    high = edge_length - half_width
    preferred = min(high, max(low, preferred_fraction * edge_length))
    centers = {preferred, low, high}
    direction, start = _edge_direction_and_point(edge)
    required_separation = tab_width_cm + stock_gap_cm
    for blocker_edge, blocker_fraction in blockers:
        blocker_point = _edge_point_at_fraction(blocker_edge, blocker_fraction)
        projected = (
            (blocker_point.x - start.x) * direction.x
            + (blocker_point.y - start.y) * direction.y
        )
        centers.add(min(high, max(low, projected - required_separation)))
        centers.add(min(high, max(low, projected + required_separation)))
    return [
        center / edge_length
        for center in sorted(centers, key=lambda value: (abs(value - preferred), value))
    ]


def _relocation_edges(body, selected, stock_bounds, tab_width_in):
    """Safe edges a conflicting grouped tab may move to, preferred first."""
    minimum_length_cm = tab_width_in * 1.25 * 2.54
    body_center = _body_center(body)
    stock_check_cm = STOCK_BACKING_CHECK_IN * 2.54
    usable = [
        edge for edge in _all_straight_edges(body)
        if _edge_length(edge) >= minimum_length_cm
    ]
    backed = [
        edge for edge in usable
        if _has_real_stock_backing(edge, body_center, stock_bounds, stock_check_cm)
    ]
    pool = backed if backed else usable

    ordered = []
    for edge in [edge for edge, _fraction in selected] + sorted(
        pool, key=_edge_length, reverse=True
    ):
        if all(edge is not existing for existing in ordered):
            ordered.append(edge)
    return ordered


def separate_grouped_tab_candidates(
    grouped_candidates,
    tab_width_in,
    object_spacing_in,
    stock_bounds=None,
):
    """Move aligned facing tabs apart while preserving every body's count.

    ``grouped_candidates`` is ``[(body, [(edge, fraction), ...]), ...]``.
    The first body's choices remain stable; later bodies use the nearest
    valid position on a safe straight edge. A job fails instead of emitting
    touching tabs if its geometry cannot satisfy the invariant.

    Known gap, not yet closed: the incoming candidates are already axis-
    safe (they come from select_tab_edges, which enforces this), but a
    RELOCATION this function computes to resolve a facing-tab conflict
    (_relocation_fraction_options) does not itself check the coordinate
    axes - only stock backing and same-line/facing-tab spacing. A
    relocated position could in principle land back on an axis on a
    grouped (2+ body) job where conflict relocation actually triggers.
    Left for a follow-up pass rather than folded in here, given how much
    more this function's own conflict-search space already has to satisfy
    at once (line/edge, spacing from every other accepted tab across every
    other body, corridor width) - lower risk to add a real axis-avoidance
    hard requirement to select_tab_edges' own SELECTION first (done) and
    verify it live before also threading it through this quite different,
    already-intricate relocation search.
    """
    if len(grouped_candidates) < 2:
        return [list(candidates) for _body, candidates in grouped_candidates], 0

    tab_width_cm = tab_width_in * 2.54
    stock_gap_cm = GROUPED_TAB_STOCK_GAP_IN * 2.54
    corridor_max_cm = (
        object_spacing_in + GROUPED_TAB_CORRIDOR_TOLERANCE_IN
    ) * 2.54
    accepted_across_bodies = []
    adjusted_groups = []
    moved_count = 0

    for body, candidates in grouped_candidates:
        adjusted = []
        relocation_edges = _relocation_edges(
            body, candidates, stock_bounds, tab_width_in
        )
        for index, (preferred_edge, preferred_fraction) in enumerate(candidates):
            future_same_body = candidates[index + 1:]
            same_body_blockers = adjusted + future_same_body
            chosen = None

            edge_options = [preferred_edge] + [
                edge for edge in relocation_edges if edge is not preferred_edge
            ]
            for edge in edge_options:
                fraction_options = _relocation_fraction_options(
                    edge,
                    preferred_fraction if edge is preferred_edge else 0.5,
                    [
                        (other_edge, other_fraction)
                        for _other_body, other_edge, other_fraction in accepted_across_bodies
                    ] + same_body_blockers,
                    tab_width_cm,
                    stock_gap_cm,
                )
                for fraction in fraction_options:
                    if any(
                        _same_line_tabs_conflict(
                            edge,
                            fraction,
                            other_edge,
                            other_fraction,
                            tab_width_cm,
                            stock_gap_cm,
                        )
                        for other_edge, other_fraction in same_body_blockers
                    ):
                        continue
                    if any(
                        _grouped_tabs_conflict(
                            body,
                            edge,
                            fraction,
                            other_body,
                            other_edge,
                            other_fraction,
                            tab_width_cm,
                            stock_gap_cm,
                            corridor_max_cm,
                        )
                        for other_body, other_edge, other_fraction in accepted_across_bodies
                    ):
                        continue
                    chosen = (edge, fraction)
                    break
                if chosen is not None:
                    break

            if chosen is None:
                raise RuntimeError(
                    "grouped part geometry has no tab position that leaves stock "
                    "between neighboring tabs"
                )
            if chosen[0] is not preferred_edge or abs(chosen[1] - preferred_fraction) > 1e-6:
                moved_count += 1
            adjusted.append(chosen)
            accepted_across_bodies.append((body, chosen[0], chosen[1]))
        adjusted_groups.append(adjusted)

    return adjusted_groups, moved_count


def _tab_fractions(n: int) -> list[float]:
    """``n`` positions evenly spread along an edge's interior span, away
    from its own two corners - where lead-in/lead-out and the adjacent
    side's own tab live. A single tab still lands at the midpoint
    (fraction 0.5, matching (i+1)/(n+1) for n=1), so this is a strict
    generalization of every prior version of this module, not a behavior
    change for the common one-tab-per-side case.
    """
    if n <= 0:
        return []
    return [(i + 1) / (n + 1) for i in range(n)]


def _manual_tab_points(app, root_component, tab_face, tab_edge_fractions):
    """Create explicit Manual Tabs SketchPoints at the vetted (edge,
    fraction) positions - see select_tab_edges for what fraction means and
    why more than one position can share the same edge.

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
    if tab_face is None or not tab_edge_fractions:
        return []
    try:
        sketch = root_component.sketches.add(tab_face)
        sketch.name = "AutoCAM Manual Tab Points"
        try:
            sketch.isLightBulbOn = False
        except Exception:
            pass

        tab_points = []
        for edge, fraction in tab_edge_fractions:
            # ``edge`` is intentionally the occurrence proxy returned from
            # rootComponent.allOccurrences. Its geometry is already in the
            # exact arranged coordinate frame of this setup.
            point = sketch.modelToSketchSpace(_edge_point_at_fraction(edge, fraction))
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
    deliberately NOT filtered by stock backing.  The caller filters whole
    sides once it can inspect their outward stock support; retaining all
    straight edges here makes that decision explicit and testable.
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


def _is_a_bare_triangle(body) -> bool:
    """Whether body's outer boundary is genuinely just a 3-sided shape,
    not a more complex outline that happens to reduce to 3 tab-eligible
    sides after _all_straight_edges' own length filter drops the rest.

    Real, confirmed gap: _distinct_straight_line_count only counts edges
    that already survived that length filter, so a heavily-notched or
    lattice-cut outline (many short straight jogs alongside a handful of
    genuinely long structural sides) could ALSO reduce to exactly 3
    groups - tripping the same "triangular part" floor below and
    silently overriding an operator's own explicit tab-count override
    (e.g. requesting 4+ tabs) down to 3, even though the part is not
    remotely triangular and the instruction this floor exists for
    ("a triangular part only has 3 real sides to begin with") does not
    apply to it at all. Requires every straight edge on the boundary to
    have survived the filter - if any were dropped for being too short,
    this a genuinely more complex outline, not a bare triangle.
    """
    tab_face = _find_tab_face(body)
    if tab_face is None:
        return False
    all_straight = [e for e in _outer_boundary_edges(tab_face) if _is_straight_edge(e)]
    return len(all_straight) == 3 and _distinct_straight_line_count(body) == 3


def _min_tabs_for_body(body, min_tabs: int) -> int:
    """A triangular part only has 3 real sides to begin with, and its
    3rd (shortest) side is very often the one this module's own stock-
    backing/length gates would reject anyway. Direct instruction: 4 or
    more tabs normally, but exactly 2 for a triangular shape, placed on
    its two longer sides - a 3rd tab on the shortest side doubled up on
    one of the other two with real holding power, it just doubled up on
    one side. Anything with 4+ distinct sides still uses the normal
    min_tabs floor (parametric - ConfigureTabs's own min_tabs/max_tabs
    arguments, not hardcoded here).
    """
    if _is_a_bare_triangle(body):
        return 2
    return min_tabs


def _max_tabs_for_body(body, max_tabs: int) -> int:
    """The other half of _min_tabs_for_body's own floor: a triangle's two
    longer sides are where real holding power lives - a 3rd tab on the
    shortest side, or a 2nd tab doubled onto an already-selected side,
    adds no real holding power either. Direct instruction: exactly 2 for
    a triangular shape, on its longer sides, full stop. Caps the
    perimeter-based scaling that would otherwise grow tab count on a
    large triangle the same way it does for a normal 4+-sided part, and -
    same as the min-tabs floor above - overrides even an explicit
    operator tab-count request (camPlate.py's tab_count_override sets
    min_tabs == max_tabs to that value; a triangle still gets exactly 2
    regardless of what was asked for, since more genuinely is not needed).
    """
    if _is_a_bare_triangle(body):
        return 2
    return max_tabs


def _axis_safe_fractions_for_line(edge, n: int, margin_cm: float, half_width_cm: float, tab_width_in: float, wcs_frame):
    """Up to n well-spaced fractions on edge's own largest axis-safe
    interior sub-segment (see _axis_safe_interior_bounds) - fewer than n
    when that segment is too short to fit all of them at the same
    2x-tab-width spacing every tab on this module already requires. The
    caller (select_tab_edges) redistributes any shortfall onto other real
    sides, the same way an excluded (unbacked, or too-short) side's own
    budget already gets redistributed.
    """
    if n <= 0:
        return []
    if wcs_frame is None:
        # No axis constraint in play at all - _tab_fractions(n) directly on
        # the whole edge, exactly like every version of this module before
        # axis-avoidance existed. Skipping the interior-sub-segment
        # remapping below when there is nothing to route around also
        # avoids it introducing its own floating-point rounding into the
        # common, unconstrained case (algebraically the same midpoint for
        # a single tab, but not bit-for-bit identical after that many more
        # arithmetic operations - a real regression a strict `== 0.5`
        # comparison in this module's own test suite caught directly).
        edge_length = _edge_length(edge)
        if edge_length <= 0 or edge_length < half_width_cm * 2:
            return []
        return list(_tab_fractions(n))
    bounds = _axis_safe_interior_bounds(edge, margin_cm, half_width_cm, wcs_frame)
    if bounds is None:
        return []
    low, high = bounds
    span = high - low
    edge_length = _edge_length(edge)
    if span <= 0 or edge_length <= 0:
        return [low]
    min_gap_frac = (tab_width_in * 2 * 2.54) / edge_length
    fits = n if min_gap_frac <= 0 else min(n, max(1, int(span / min_gap_frac) + 1))
    return [low + position * span for position in _tab_fractions(fits)]


def select_tab_edges(
    body,
    max_tabs: int = DEFAULT_MAX_TABS,
    stock_bounds=None,
    tab_width_in: float = TAB_WIDTH_IN,
    wcs_frame=None,
):
    """(edge, fraction) positions on the body's own outer boundary, spread
    across every distinct USABLE straight side. Never returns a
    curved/filleted edge, an internal-loop (hole/pocket) edge, or one too
    short to physically hold a tab - direct instruction, not a preference
    to relax if a part is mostly rounded or small. ``fraction`` (0-1)
    marks where along that edge the tab sits - 0.5 for the normal single
    tab, other values when more than one tab shares a side (see below).

    Used by ConfigureTabs as the actual Manual Tabs geometry, via
    _manual_tab_points. Each selected position is an explicit, safe
    release-tab location; Fusion's automatic placement is disabled rather
    than allowed to place more tabs elsewhere.

    A side with NO real stock ANYWHERE behind it is excluded outright, not
    merely deprioritized. Confirmed live: a side lying exactly on the
    plate's own machining boundary or a coordinate axis - so that every
    point along it has zero material on the outward side - silently drops
    any manual tab position requested there, no matter how carefully it is
    placed; Fusion has nothing to attach it to. An earlier version of this
    module treated stock backing as a same-side preference only ("which
    edge to pick within a side," never "whether the side gets a tab at
    all") on the theory that a tab there, while not anchored into real
    material, still helped hold the part. That theory does not survive
    contact with what Fusion actually does with such a request.

    Rather than let an excluded side simply reduce the tab count, its
    share of the budget is put onto the sides that DO have real stock -
    including a SECOND (or third) tab on the same valid side when there
    isn't a fresh side to give it to. Direct instruction: "just add more
    tabs to these parts on sides that are already there (you can add more
    than one tab for parts like this)". Extra tabs only ever land on a
    side with real spare length for them (see the redistribution loop
    below) and only on sides already past the straight-edge / minimum-
    length gates - never on a curved edge or a facet too short to hold one.

    Longest-first, capped at max_tabs (which _tab_count_for_perimeter has
    already scaled to the part's own size, so a small part asks for ~4 and
    a large one for more): the long structural sides win over a fan of
    short facets - confirmed live on a real teardrop bracket that had been
    picking up a tab on every one of its short bottom facets.

    wcs_frame (origin, x_axis, y_axis) is the setup's own real WCS, in the
    same root/arranged frame this body's own edges are already expressed
    in - direct instruction: a tab must never land on the path of the
    coordinate axes (the WCS origin gizmo visible in Fusion's own
    viewport), not a coincidental raw-coordinate zero (see _to_wcs_uv's
    own docstring for the real bug that distinction fixes). None (the
    default) disables this check entirely rather than guessing at what
    "the axes" means without a real WCS to check against.
    """
    stock_check_cm = STOCK_BACKING_CHECK_IN * 2.54
    axis_margin_cm = AXIS_AVOIDANCE_MARGIN_IN * 2.54
    half_width_cm = tab_width_in * 2.54 / 2
    body_center = _body_center(body)

    def is_backed(edge):
        return _has_real_stock_backing(edge, body_center, stock_bounds, stock_check_cm)

    def is_axis_safe(edge):
        return _axis_safe_interior_bounds(edge, axis_margin_cm, half_width_cm, wcs_frame) is not None

    all_edges = sorted(_all_straight_edges(body), key=_edge_length, reverse=True)
    lines = _group_into_lines(all_edges)
    lines.sort(key=lambda line: _edge_length(line[0]), reverse=True)

    def best_edge_for_line(line):
        # Prefer a segment that is both stock-backed and clear of the
        # coordinate axes; relax one requirement at a time rather than
        # dropping the whole line outright - a side represented by several
        # collinear segments (see _group_into_lines) can have one segment
        # crossing an axis while another, real, usable segment on that
        # exact same side does not.
        for predicate in (lambda e: is_backed(e) and is_axis_safe(e), is_backed, is_axis_safe):
            candidates = [e for e in line if predicate(e)]
            if candidates:
                return max(candidates, key=_edge_length)
        return max(line, key=_edge_length)

    def line_length_in(line) -> float:
        return _edge_length(best_edge_for_line(line)) / 2.54

    def line_is_backed(line) -> bool:
        return any(is_backed(e) for e in line)

    def line_is_axis_safe(line) -> bool:
        return is_axis_safe(best_edge_for_line(line))

    # Drop sides too short to actually hold a tab. Measured on the segment that would carry the
    # tab, not the side's summed length: a side split into several short
    # collinear pieces still has to fit the tab within ONE of them. Also
    # drop a side whose best segment has no axis-safe interior position at
    # all (it runs along a coordinate axis for its full usable span) -
    # direct instruction: tabs must never generate on the path of the
    # axes, and this side genuinely has nowhere safe to put one, the same
    # "cannot be made safe by relaxing geometry" reasoning the length gate
    # below already uses.
    min_side_cm = tab_width_in * 1.25 * 2.54
    usable = [
        line for line in lines
        if _edge_length(best_edge_for_line(line)) >= min_side_cm and line_is_axis_safe(line)
    ]
    if not usable:
        # A tab cannot be made safe by silently relaxing its own minimum
        # geometry. The caller fails the job before postprocessing instead
        # of letting Fusion create malformed tabs on a short/curved outline.
        return []

    backed_usable = [line for line in usable if line_is_backed(line)]
    pool = backed_usable if backed_usable else usable

    # True when some real, sufficiently-long side got dropped for lacking
    # real stock backing (see _has_real_stock_backing) OR for having no
    # axis-safe position at all - the specific case "just add more tabs to
    # these parts on sides that are already there" (direct instruction)
    # was written for: an excluded side's share of the budget has to land
    # somewhere, more than one extra tab on the same valid side if that's
    # what it takes. When nothing was excluded, max_tabs is just this
    # body's overall ceiling (see _tab_count_for_perimeter) - a side
    # earning extra tabs simply because that ceiling happens to be
    # generous relative to how many real sides this part has is the
    # reported bug (an 8.211in side on an already well-tabbed part getting
    # 3 tabs it did not need), not the behavior that instruction asked for.
    has_excluded_sides = len(pool) < len(usable) or len(usable) < len(lines)

    primary = pool[:max_tabs]
    counts = {id(line): 1 for line in primary}

    # The per-side cap below (has_excluded_sides being False) only applies
    # once the part already has real breadth - at least DEFAULT_MIN_TABS
    # distinct sides already holding a tab. A part with genuinely few real
    # sides (a couple of long edges, everything else too short to qualify)
    # still needs the older "fill remaining room" behavior to reach a
    # reasonable total tab count at all - the cap's whole point is
    # stopping a well-covered part from over-tabbing one side, not
    # under-tabbing a small part that has nowhere else to put tabs.
    apply_per_side_cap = not has_excluded_sides and len(primary) >= DEFAULT_MIN_TABS

    # Redistribute whatever the exclusion above left unfilled: add a
    # second (or third) tab to one of the already-selected valid sides,
    # longest/roomiest first, rather than reaching for a shorter facet or
    # a side that cannot hold one. A line only gains another tab when it
    # genuinely has the spare length for it, at the same 2x-tab-width
    # spacing every tab on this module already requires - this can stop
    # short of max_tabs on a small part with no more room, which is
    # correct: a crowded tab is worse than one fewer. Once
    # apply_per_side_cap is true, a line also stops once it reaches its
    # own _tab_desired_count - too many tabs is not good, only enough to
    # make the part stable, and stability is a property of the whole part
    # (breadth) more than of any one side (depth).
    remaining_budget = max_tabs - len(primary)
    guard = 0
    while remaining_budget > 0 and primary and guard < max_tabs * 6:
        guard += 1

        def room_for_one_more(line):
            n = counts[id(line)]
            if apply_per_side_cap and n >= _tab_desired_count(line_length_in(line)):
                return float("-inf")
            return line_length_in(line) - (n + 1) * tab_width_in * 2

        candidate = max(primary, key=room_for_one_more)
        if room_for_one_more(candidate) < 0:
            break
        counts[id(candidate)] += 1
        remaining_budget -= 1

    # Fractions are computed on each line's own largest axis-safe
    # sub-segment (see _axis_safe_fractions_for_line), never the raw
    # _tab_fractions(n) spread across the whole edge - a line whose axis-
    # safe segment is too short to fit every tab its count assigned it
    # places fewer, and the difference (shortfall) is redistributed below
    # exactly like an excluded side's own budget already is.
    selected = []
    shortfall = 0
    for line in primary:
        edge = best_edge_for_line(line)
        n = counts[id(line)]
        placed = _axis_safe_fractions_for_line(edge, n, axis_margin_cm, half_width_cm, tab_width_in, wcs_frame)
        shortfall += n - len(placed)
        for fraction in placed:
            selected.append((edge, fraction))

    def _unselected_axis_safe_edges():
        selected_edge_ids = {id(edge) for edge, _fraction in selected}
        remaining = [
            e for e in all_edges
            if id(e) not in selected_edge_ids and _edge_length(e) >= min_side_cm and is_axis_safe(e)
        ]
        remaining.sort(key=lambda e: (not is_backed(e), -_edge_length(e)))
        return remaining

    # Top up a same-side shortfall first, on a fresh axis-safe edge -
    # direct instruction: never place the tab on the axis itself rather
    # than silently under-placing this line's own assigned count.
    for edge in _unselected_axis_safe_edges():
        if shortfall <= 0:
            break
        fraction = _nearest_axis_safe_fraction(edge, 0.5, axis_margin_cm, half_width_cm, wcs_frame)
        if fraction is None:
            continue
        selected.append((edge, fraction))
        shortfall -= 1

    # Only if the part genuinely has fewer distinct USABLE sides than tabs
    # asked for even after doubling up wherever there was room (a triangle
    # with two very short sides, say) do additional, different edges get
    # pulled in as a last resort - stock-backed ones first, same threshold
    # as everything above so this can't quietly re-add a short facet, and
    # still never a position on the coordinate axes.
    if len(selected) < max_tabs:
        for edge in _unselected_axis_safe_edges():
            if len(selected) >= max_tabs:
                break
            fraction = _nearest_axis_safe_fraction(edge, 0.5, axis_margin_cm, half_width_cm, wcs_frame)
            if fraction is None:
                continue
            selected.append((edge, fraction))
    return selected


def _apply_manual_tabs(
    app,
    operation,
    tab_points,
    tab_width_in: float = TAB_WIDTH_IN,
    tab_height_in: float = TAB_HEIGHT_IN,
) -> bool:
    """Configure uniform explicit positions in Fusion's Manual Tabs field.

    ``tabPositions`` receives explicit SketchPoints on the release contour.
    The points, rather than edge references, make the requested location and
    its chain direction unambiguous to Fusion's CAM kernel.
    """
    width_param = operation.parameters.itemByName("tabWidth")
    if width_param is not None:
        try:
            width_param.expression = f"{tab_width_in}in"
        except Exception as e:
            app.log(f"TabPlacement: failed to set tabWidth: {e}")

    height_param = operation.parameters.itemByName("tabHeight")
    if height_param is not None:
        try:
            height_param.expression = f"{tab_height_in}in"
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
        f"(operation kept {accepted}), {tab_width_in:.4f}in wide x "
        f"{tab_height_in:.4f}in tall"
    )
    return True


def _disable_tabs(app, operation) -> bool:
    """Disable tab geometry without changing the release contour's identity.

    ``group_tabs`` is also the template's durable marker for the outer
    release contour. DeleteToolpaths uses that marker to rebuild the actual
    outside chain. Clearing it here made a tabless release cut look like an
    unused internal finishing pass, so it was deleted before CAM generation.
    """
    try:
        tabs_per_contour = operation.parameters.itemByName("tabsPerContour")
        if tabs_per_contour is not None:
            tabs_per_contour.value.value = 0
        positions = operation.parameters.itemByName("tabPositions")
        if positions is not None:
            positions.value.value = []
        return True
    except Exception as e:
        app.log(f"TabPlacement: could not disable invalid template tabs: {e}")
        return False


def _read_stock_bounds(setup, app):
    """The real machining bounds of this setup's plate, straight from
    Fusion's own computed stock parameters - not a guess, and not the
    part's own bounding box (a part positioned close to the plate's own
    edge - AutoArrange's frame margin used up on that side, or a corner
    placement - can have real sides with little to no stock actually
    behind them; see _has_real_stock_backing). None (any parameter
    missing) means "skip this filter, don't place zero tabs from a name
    lookup failing."

    Two real, confirmed-live bugs this has gone through, in order:

    1. .expression returns the parameter as a human-readable STRING WITH
       ITS UNIT SUFFIX (e.g. "0.635 in"), which float() cannot parse at
       all - every call raised immediately, so stock_bounds silently
       ended up None on every real job, ever, and this filter never ran.
    2. The fix for #1 switched to .value - but a CAM setup parameter's
       own .value is itself a FloatParameterValue wrapper object, not a
       bare float (confirmed live: "TypeError: '<=' not supported between
       instances of 'FloatParameterValue' and 'float'" the moment a real
       job compared it). This module's own top-of-file comment already
       documented the fix for exactly this - CAM parameters need
       ``parameter.value.value``, not ``parameter.value`` or
       ``parameter.expression`` (see tabPositioning/tabsPerContour/
       positions below, all already written that way) - this just hadn't
       been applied here yet. .value.value is the actual plain float,
       already in the same centimeter unit _edge_outward_point's own edge
       geometry is in - no string parsing, no unit mismatch, no wrapper.
    """
    try:
        x_low = setup.parameters.itemByName("stockXLow").value.value
        x_high = setup.parameters.itemByName("stockXHigh").value.value
        y_low = setup.parameters.itemByName("stockYLow").value.value
        y_high = setup.parameters.itemByName("stockYHigh").value.value
        return (x_low, x_high, y_low, y_high)
    except Exception as e:
        app.log(f"TabPlacement: could not read stock bounds, skipping the real-stock-backing check: {e}")
        return None


def _read_wcs_frame(setup, app):
    """This setup's real WCS, as (origin, x_axis, y_axis) tuples in the
    same root/arranged frame this module's own edge geometry is already
    expressed in (see _to_wcs_uv) - None (any read failure) means "skip
    this filter," the same convention _read_stock_bounds already uses.

    UNVERIFIED for a milling/2D setup: Setup.workCoordinateSystem.
    getAsCoordinateSystem() was separately confirmed live to report its
    origin translation in millimeters (not the centimeters every other
    Fusion geometry API uses) for a TURNING setup specifically - whether
    that same quirk applies to a milling setup's own WCS has not been
    checked live. No unit correction is applied here for that reason: a
    wrong guess at a conversion factor would be worse than skipping the
    filter outright on a bad read, the same "None means don't filter"
    reasoning _read_stock_bounds itself already documents. Confirm this
    against a real milling setup (compare the returned origin to a known
    real WCS position, the same way the turning-setup quirk itself was
    confirmed) before trusting the axis-avoidance check on a job whose
    part sits anywhere near the WCS origin.
    """
    try:
        origin, x_axis, y_axis, _z_axis = setup.workCoordinateSystem.getAsCoordinateSystem()
        return (
            (origin.x, origin.y, origin.z),
            (x_axis.x, x_axis.y, x_axis.z),
            (y_axis.x, y_axis.y, y_axis.z),
        )
    except Exception as e:
        app.log(f"TabPlacement: could not read the setup's own WCS, skipping the axis-avoidance check: {e}")
        return None


def ConfigureTabs(
    min_tabs: int = DEFAULT_MIN_TABS,
    max_tabs: int = DEFAULT_MAX_TABS,
    object_spacing_in: float = 0.26,
):
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

    tab_width_in = _tab_width_for_bodies(bodies)
    tab_height_in = _tab_height_for_bodies(bodies)
    if tab_width_in < TAB_WIDTH_IN:
        app.log(
            f"TabPlacement: reduced tab width from {TAB_WIDTH_IN}in to "
            f"{tab_width_in:.4f}in for the narrowest nested body."
        )
    if tab_height_in < TAB_HEIGHT_IN:
        app.log(
            f"TabPlacement: reduced tab height from {TAB_HEIGHT_IN}in to "
            f"{tab_height_in:.4f}in for the thinnest nested body."
        )

    cam = adsk.cam.CAM.cast(
        app.activeDocument.products.itemByProductType("CAMProductType")
    )
    if cam is None:
        return

    for setup in cam.setups:
        stock_bounds = _read_stock_bounds(setup, app)
        wcs_frame = _read_wcs_frame(setup, app)

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
            body_tab_candidates = []
            for body in bodies:
                perimeter_in = _outer_perimeter_in(body)
                body_min_tabs = _min_tabs_for_body(body, min_tabs)
                body_max_tabs = _max_tabs_for_body(body, max_tabs)
                target_tabs = _tab_count_for_perimeter(perimeter_in, body_min_tabs, body_max_tabs)
                body_candidates = select_tab_edges(
                    body,
                    max_tabs=target_tabs,
                    stock_bounds=stock_bounds,
                    tab_width_in=tab_width_in,
                    wcs_frame=wcs_frame,
                )
                if len(body_candidates) < body_min_tabs:
                    app.log(
                        f"TabPlacement: '{op.name}' - a nested body only had "
                        f"{len(body_candidates)} straight edge(s) long enough "
                        f"to hold a tab (wanted at least {body_min_tabs} of "
                        f"{target_tabs} target, perimeter {perimeter_in:.1f}in) "
                        "- using what's available rather than placing a tab "
                        "on a rounded or too-short edge."
                )
                body_tab_candidates.append((body, body_candidates))

            adjusted_candidates, moved_count = separate_grouped_tab_candidates(
                body_tab_candidates,
                tab_width_in,
                object_spacing_in,
                stock_bounds=stock_bounds,
            )
            if moved_count:
                app.log(
                    f"TabPlacement: '{op.name}' - moved {moved_count} grouped tab(s) "
                    f"to leave at least {GROUPED_TAB_STOCK_GAP_IN}in of stock "
                    "between neighboring tabs."
                )

            all_tab_points = []
            for (body, body_candidates), adjusted_body_candidates in zip(
                body_tab_candidates, adjusted_candidates
            ):
                tab_face = _find_tab_face(body)
                tab_points = _manual_tab_points(
                    app, comp, tab_face, adjusted_body_candidates
                )
                if len(tab_points) != len(body_candidates):
                    app.log(
                        f"TabPlacement: '{op.name}' - could not create all explicit tab points "
                        f"for a nested body; leaving this operation unchanged."
                    )
                    all_tab_points = []
                    break
                all_tab_points.extend(tab_points)

            if not all_tab_points:
                raise RuntimeError(
                    f"TabPlacement: '{op.name}' has no safe explicit tab points; "
                    "refusing to post an unsecured release contour."
                )

            applied = _apply_manual_tabs(app, op, all_tab_points, tab_width_in, tab_height_in)
            if not applied:
                raise RuntimeError(
                    f"TabPlacement: '{op.name}' could not configure verified Manual Tabs."
                )
