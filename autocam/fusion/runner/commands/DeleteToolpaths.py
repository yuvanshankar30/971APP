import adsk.core, adsk.fusion, adsk.cam, traceback
import time

from .ContourChains import is_reverted_for_loop_seed
from .Orientation import _back_face_for, _loop_wall_faces, _cavity_walk, _pocket_floor_face


_POCKET_STRATEGIES = ("pocket_new", "pocket_clearing", "pocket2d", "adaptive2d")


def _is_dedicated_circular_hole_op(name_lower: str) -> bool:
    """True only for the template's own dedicated big-hole operation
    (">.3 Circular Through Hole" et al) - requires BOTH "circular" and
    "hole", not just "hole" alone. A plain substring check on "hole" was
    confirmed live to be a real bug, not just imprecise: this template
    also ships "Shape Through Hole" and "Small Shape Through Hole" -
    ordinary adaptive2d roughing passes that have nothing to do with the
    dedicated circular-hole operation but do contain the word "hole" in
    their own name - which the broader check was wrongly exempting from
    both the early-cleanup and has_pocket_floor deletion checks below,
    right alongside the real big-hole operation. Left with a genuinely
    empty toolpath (confirmed: "Generated toolpath is empty" on a real
    thin sheet part with nothing for a bulk-roughing pass to clear),
    every one of these wrongly-kept operations then made
    cam.postProcess() fail outright with "Initialization fails" - not a
    warning, a hard failure that aborted the entire job's export, so this
    was a real, job-killing bug, not just a name collision.
    """
    return "circular" in name_lower and "hole" in name_lower


def _is_dedicated_circular_pocket_op(name_lower: str) -> bool:
    """True only for the template's own dedicated circular-BLIND-POCKET
    operation (">.3 Circular Pocket" et al) - requires "circular" and
    "pocket", explicitly excluding "hole" so this never collides with
    _is_dedicated_circular_hole_op's own through-hole operation. The two
    are genuinely different features (a recessed floor vs. a full-depth
    cutout) that happen to share the "circular" and diameter-threshold
    naming convention.
    """
    return "circular" in name_lower and "pocket" in name_lower and "hole" not in name_lower

# Maps each strategy to the name of its geometry-selection parameter - the
# thing that actually holds WHAT to cut, separate from all the how-to-cut
# parameters (feeds, stepdown, etc.) already handled elsewhere. Confirmed
# by direct inspection of a real operation's parameters, not guessed.
_SELECTION_PARAM_BY_STRATEGY = {
    "contour2d": "contours",
    # The current plate template's real recessed-pocket operation uses
    # pocket_new.  It has the same ``pockets`` selection parameter as the
    # older pocket2d/adaptive variants; omitting it meant the operation could
    # never have its stale template geometry replaced after a STEP import.
    "pocket_new": "pockets",
    "pocket_clearing": "pockets",
    "pocket2d": "pockets",
    "adaptive2d": "pockets",
}

# The real reference template ships two separate circular-hole operations
# named for exactly this split - "<.3 Circular Through Hole" (bore, small
# holes) and ">.3 Circular Through Hole" (pocket2d, everything bigger,
# since a large hole needs a real helical/pocket toolpath rather than a
# single bore plunge). Direct instruction: the big hole and the small
# holes should be cut by these two different operations, not lumped
# together - so the pocket2d one's own hole recognition needs a minimum
# diameter matching the template's own ">.3" naming, or it would also
# pick up the same small holes the bore operation already handles.
_MIN_HOLE_DIAMETER_NAME_THRESHOLDS_IN = (
    (">.3", 0.3),
    ("&gt;.3", 0.3),  # XML-escaped '>' - op.name can come through either way
)


def _min_hole_diameter_cm_from_name(name_lower: str):
    """The real diameter threshold (in cm) this operation's own name
    implies, or None if its name carries no such marker at all - shared by
    both the legacy PocketRecognitionSelection path and the real
    ChainSelection-based big-hole fix below, so the two can never disagree
    about what threshold a given operation name means.
    """
    for marker, threshold_in in _MIN_HOLE_DIAMETER_NAME_THRESHOLDS_IN:
        if marker in name_lower:
            return threshold_in * 2.54
    return None


def _set_min_hole_diameter_from_name(recognition, name_lower: str) -> None:
    if not recognition.areHolesIncluded:
        return
    threshold_cm = _min_hole_diameter_cm_from_name(name_lower)
    if threshold_cm is None:
        return
    try:
        recognition.minimumHoleDiameter = threshold_cm
    except Exception:
        pass


def _top_face(body):
    """Return the physically highest planar face on a body.

    Some STEP imports report both opposing planar faces as upward-facing,
    while ordinary imports correctly report the bottom face as downward.
    In both cases, physical height identifies the machining top
    deterministically; the sign of a STEP-exported BRep normal does not.
    """
    best_face, best_z = None, None
    for face in body.faces:
        try:
            normal = face.geometry.normal
            z = face.pointOnFace.z
        except Exception:
            continue
        if abs(normal.z) > 0.9 and (best_z is None or z > best_z):
            best_z = z
            best_face = face
    return best_face


def _bottom_face(body):
    """Return the physically lowest planar face on a body.

    Direct instruction: the outer-profile/slot-cut contour selection
    should reference the BOTTOM edge of the part around its whole
    perimeter, not the top - used only by _outer_loop_edges_all_bodies
    below, not by internal-feature or tab-candidate edge selection
    elsewhere, which stay on the true top face.
    """
    best_face, best_z = None, None
    for face in body.faces:
        try:
            normal = face.geometry.normal
            z = face.pointOnFace.z
        except Exception:
            continue
        if abs(normal.z) > 0.9 and (best_z is None or z < best_z):
            best_z = z
            best_face = face
    return best_face


def _outer_loop_edges_all_bodies(design):
    """Every body's own OUTER-loop edges only, combined across the whole
    design - used to build a real outer-profile selection that a plain
    createNewSilhouetteSelection() cannot: confirmed live that a
    silhouette selection includes every visible boundary at the top face,
    internal feature loops (holes, pockets, slots that go all the way
    through) included, not just the true outer perimeter - so "2D Slot
    Cut" ended up also cutting internal features it should have left
    alone. A ChainSelection built from just each body's real isOuter loop
    has no such ambiguity. Combined across every body so a grouped
    multi-part job's shared outer-profile operation gets every part's own
    real outer boundary, not just one.

    Taken from the BOTTOM face (_bottom_face) - briefly swapped to the top
    face alongside the feature-loop fix below (same session, same
    hypothesis that both needed the same face), then confirmed live via
    direct screenshot comparison that the SWAP broke this one specifically
    - the bottom-face version was already correct (the "Closed Chain 1" /
    tabs dialog the user confirmed as the real target was captured before
    this swap, on the bottom face) - while the top face was what the
    feature loops actually needed. The two selections don't share a
    single correct face on this part; each was tuned independently
    against its own live-confirmed result.
    """
    edges = []
    for occ in design.rootComponent.allOccurrences:
        if occ.bRepBodies.count == 0:
            continue
        bottom_face = _bottom_face(occ.bRepBodies.item(0))
        if bottom_face is None:
            continue
        for loop in bottom_face.loops:
            if loop.isOuter:
                co_edges = list(loop.coEdges)
                # Each loop carries its own real chain direction, exactly
                # like every internal-feature and circular selection in this
                # file already does. This was the last selection still
                # hard-coding a direction (isReverted=True for every part),
                # and confirmed live as still wrong: on a real job where
                # every other operation's arrow was correct, the outer
                # "2D Slot Cut" was the only one reversed.
                #
                # One formula works for both outer and inner loops without
                # a special case: Fusion winds an outer loop counter-
                # clockwise and an inner loop clockwise, so the opposite
                # handedness an outer release cut needs (tool outside the
                # part, not inside the cutout) is already encoded in the
                # loop's own co-edge ordering. Reading that instead of
                # asserting it is what makes this correct per part rather
                # than correct for whichever part it was last tuned against.
                edges.append(
                    (
                        [co_edge.edge for co_edge in co_edges],
                        is_reverted_for_loop_seed(co_edges[0].isOpposedToEdge),
                    )
                )
                break
    return edges


def _is_circular_loop(edges) -> bool:
    """True if every edge in this loop is part of a circle - a genuine
    round hole boundary, already handled by the bore/circular-pocket
    operations' own dedicated hole-recognition machinery. A polygon-ish
    loop (a slot, kidney, or other pill/rounded-rectangle shape mixing
    straight and arc segments) is not circular and needs the dedicated
    ChainSelection-based finishing pass _internal_feature_loop_chains_all_bodies
    feeds instead.
    """
    if not edges:
        return False
    for edge in edges:
        try:
            if not isinstance(edge.geometry, adsk.core.Circle3D):
                return False
        except Exception:
            return False
    return True


# What separates a FEATURE from a SHAPE.
#
# These are two genuinely different things to machine, and the real
# templates model them as separate operations ("Slot Cut for Features" vs
# "Shape Through Hole"/"Shape Pocket"):
#
# - A FEATURE is a slot: long and narrow, barely wider than the cutter, so
#   the tool essentially just traces it. There is no interior to clear.
# - A SHAPE is broad: a polygon or blob with real area inside it, which
#   wants an adaptive/pocketing pass to clear that area out.
#
# Measured as the bounding box's long side over its short side, which is
# shape-agnostic - it does not care whether a slot is a straight bar, an
# I, a dogbone, a kidney or a pill, only that it is elongated. That is the
# point: this must hold for ANY slot-like feature, not one example shape.
#
# 2.5 calibrated against a real 19-loop training part, measuring every
# internal loop's own aspect ratio:
#
#   3.30  <- the one real slot (0.326 x 1.077in, ~2x the 0.1575in cutter)
#   1.80, 1.73, 1.34, 1.29, 1.17, 1.15, 1.05, 1.04, 1.02   <- broad shapes
#
# The gap between 3.30 and 1.80 is wide, so the threshold sits comfortably
# between the two populations rather than splitting a cluster.
#
# A previous attempt at aspect-ratio slot detection was removed after real
# kidney/pill cutouts (2.25 and 1.28) failed it. That removal was correct
# AT THE TIME for a different reason: anything not classified as a slot
# fell through to generic PocketRecognitionSelection, which found nothing,
# so a misclassified feature was machined as nothing at all. Shapes now
# have working operations of their own, so classifying a rounder cutout as
# a shape is a correct outcome rather than a silent loss.
_FEATURE_ASPECT_RATIO = 2.5


def _loop_aspect_ratio(edges) -> float:
    """Bounding-box elongation of a closed loop - long side / short side.

    Samples each edge's endpoints plus a point along it, so an arc-sided
    loop (a pill, a dogbone's rounded ends) is measured by the space it
    actually occupies rather than by its vertices alone. Returns 0.0 when
    the loop cannot be measured, which reads as "not elongated" and leaves
    it classified as a shape - the safer default, since a shape operation
    can machine a slot's area but a slot pass cannot clear a shape's.
    """
    xs, ys = [], []
    for edge in edges:
        for getter in ("startVertex", "endVertex"):
            try:
                point = getattr(edge, getter).geometry
                xs.append(point.x)
                ys.append(point.y)
            except Exception:
                continue
        try:
            point = edge.pointOnEdge
            xs.append(point.x)
            ys.append(point.y)
        except Exception:
            pass
    if len(xs) < 2:
        return 0.0
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    longer, shorter = max(width, height), min(width, height)
    if shorter <= 1e-6:
        return 0.0
    return longer / shorter


def _is_feature_slot_op(name_lower: str) -> bool:
    """True for the template's own dedicated feature-slot operation
    ("Slot Cut for Features"). Requires both "slot" and "feature" so it can
    never match the outer release cut, which is also slot-named ("2D Slot
    Cut", "Slot Cut for Edges") but is identified by group_tabs instead.
    """
    return "slot" in name_lower and "feature" in name_lower


def _circle_loop_diameter_cm(edges) -> float:
    """The real diameter of a circular loop, in cm - only defined for the
    common case of a single full-circle edge (every circular hole this
    project has actually seen). Returns 0.0 for anything else rather than
    guessing, so a malformed/multi-segment "circular" loop is simply
    treated as too small to qualify rather than silently mismeasured.
    """
    if len(edges) != 1:
        return 0.0
    try:
        return edges[0].geometry.radius * 2
    except Exception:
        return 0.0


def _big_circular_loop_edges_all_bodies(design, min_diameter_cm: float):
    """Every body's own internal circular loop whose diameter is at least
    min_diameter_cm, combined across every body (same reasoning as
    _outer_loop_edges_all_bodies) - the template's own dedicated big-hole
    operation needs a real ChainSelection built from these, for the exact
    same reason _internal_feature_loop_chains_all_bodies needed one instead
    of generic PocketRecognitionSelection: confirmed live that
    PocketRecognitionSelection's areHolesIncluded hole-search finds
    nothing for this part's real big circular through-hole even with
    minimumHoleDiameter set correctly (isSetupModelSelected=True,
    isToolpathValid=True, but "Generated toolpath is empty" - a genuinely
    empty result, not a timing artifact) - it's built for a real recessed
    pocket with a floor or a small bore-style hole, not reliably for an
    arbitrary large full-depth-through circular cutout either. A round
    loop under the threshold is left to the bore operation's own working
    hole-recognition, unaffected by this function returning it or not,
    since the bore operation doesn't call this at all - see
    _repair_missing_selections's own is_big_hole_op branch, the only
    caller.

    Each entry pairs the loop's edges with its own real chain direction
    (see is_reverted_for_loop_seed / docs/contour-chain-direction.md) -
    confirmed live as a real bug, not hypothetical: this used to hand back
    bare edge lists and the caller hardcoded isReverted=False for all of
    them, same as the internal-feature loops did before that was fixed -
    a shared BRepEdge can run either way on a given face, so a circular
    hole's own chain direction arrow can point the wrong way exactly like
    a polygon loop's can.
    """
    loops = []
    for occ in design.rootComponent.allOccurrences:
        if occ.bRepBodies.count == 0:
            continue
        bottom_face = _bottom_face(occ.bRepBodies.item(0))
        if bottom_face is None:
            continue
        for loop in bottom_face.loops:
            if loop.isOuter:
                continue
            co_edges = list(loop.coEdges)
            edges = [co_edge.edge for co_edge in co_edges]
            if not edges or not _is_circular_loop(edges):
                continue
            if _circle_loop_diameter_cm(edges) >= min_diameter_cm:
                is_reverted = is_reverted_for_loop_seed(co_edges[0].isOpposedToEdge)
                loops.append((edges, is_reverted))
    return loops


def _internal_feature_loop_chains_all_bodies(design):
    """Every body's own internal (non-outer), non-circular through-loop,
    split into ``(shape_chains, slot_chains)`` - see _FEATURE_ASPECT_RATIO
    for what separates the two and why they are machined differently.

    Both halves carry the same (seed edge, is_reverted) shape, so a caller
    that has no dedicated feature operation can simply concatenate them and
    treat everything as it did before.

    This used to only collect loops whose bounding box was elongated past
    a 2.5:1 aspect-ratio threshold (treating anything rounder as "not a
    slot," left to generic PocketRecognitionSelection instead) - dropped
    after a real part (a router stiffener) surfaced two genuine through-cut
    kidney/pill features with measured aspect ratios of 2.25 and 1.28, both
    under that threshold. Confirmed live: both fell through to generic
    recognition, which found nothing (PocketRecognitionSelection is built
    for a real recessed pocket with a floor, not a full-depth-through
    cutout - the same reason the outer profile itself needed a real
    ChainSelection instead of createNewSilhouetteSelection, see that
    function's own docstring), leaving both operations empty and deleted
    by DeleteToolpaths's own cleanup - the part's two real weight-reduction
    cutouts machined as nothing at all. A round hole is excluded here on
    purpose (see _is_circular_loop) since it already has its own dedicated
    operation; nothing else internal needs elongation to qualify.

    On the BOTTOM face (_bottom_face) - direct instruction, after the top
    face was confirmed live to still leave real internal features
    uncut on a real, more complex part (Anton plate - 8 internal loops,
    not x44_stiffner's simpler 2). Matches _outer_loop_edges_all_bodies's
    own bottom face now too, so the feature-cut and outer-profile
    selections share one consistent face reference on this part instead
    of two independently-tuned ones.
    """
    shape_chains = []
    slot_chains = []
    for occ in design.rootComponent.allOccurrences:
        if occ.bRepBodies.count == 0:
            continue
        bottom_face = _bottom_face(occ.bRepBodies.item(0))
        if bottom_face is None:
            continue
        for loop in bottom_face.loops:
            if loop.isOuter:
                continue
            co_edges = list(loop.coEdges)
            edges = [co_edge.edge for co_edge in co_edges]
            if not edges or _is_circular_loop(edges):
                continue
            # A BRepEdge's direction is global, but this selected face's
            # BRepCoEdge records the loop direction.  Preserve that relation
            # in ChainSelection rather than imposing one direction on every
            # imported feature.  See docs/contour-chain-direction.md.
            seed = co_edges[0]
            entry = (seed.edge, is_reverted_for_loop_seed(seed.isOpposedToEdge))
            if _loop_aspect_ratio(edges) >= _FEATURE_ASPECT_RATIO:
                slot_chains.append(entry)
            else:
                shape_chains.append(entry)
    return shape_chains, slot_chains


def _blind_pocket_loops_all_bodies(design):
    """Every body's own real blind-pocket loop - a recessed feature with
    its own floor, split into (circular loops, non-circular chain seeds)
    the same way through-features already are (see
    _big_circular_loop_edges_all_bodies / _internal_feature_loop_chains_all_bodies)
    since the template gives circular and general pockets separate
    dedicated operations.

    The geometry actually selected for each blind loop is its own FLOOR
    face's outer loop (see _pocket_floor_face), not the opening loop on
    the part's top surface - the top face is only used to locate each
    cavity and decide blind-vs-through, via the same wall-adjacency
    topology Orientation.py's own orientation logic already uses (imported
    directly, not reimplemented, so the two can never disagree about what
    counts as blind). A real pocket-clearing operation's own selection
    should reference where the tool actually stops (the floor), not the
    opening it enters through - confirmed live as the real fix, not the
    first attempt: building the chain from the OPENING loop's edges (even
    after trying to correct its direction with a flip) still produced the
    wrong chain arrow, because the opening loop and the floor loop are
    entirely different edges with their own independent orientation, not
    a simple top/bottom mirroring a boolean flip could correct for.

    Also confirmed live as the reason a normal-sign comparison can't be
    used here at all: a STEP import can report a plate's two truly
    opposite broad faces with the IDENTICAL raw normal, and
    PocketRecognitionSelection's own automatic search
    (isSetupModelSelected=True) came back "Generated toolpath is empty"
    for a real, confirmed blind pocket (a hex cutout) on an actual test
    part - the exact same class of Fusion recognition failure this file
    already worked around for through-features and big circular holes.
    """
    circular_loops = []
    other_chains = []
    for occ in design.rootComponent.allOccurrences:
        if occ.bRepBodies.count == 0:
            continue
        body = occ.bRepBodies.item(0)
        top_face = _top_face(body)
        if top_face is None:
            continue
        back_face = _back_face_for(body, top_face)
        if back_face is None:
            continue
        for loop in top_face.loops:
            if loop.isOuter:
                continue
            opening_edges = [co_edge.edge for co_edge in loop.coEdges]
            if not opening_edges:
                continue
            walls = _loop_wall_faces(top_face, loop)
            if not walls:
                continue
            reaches_back, visited = _cavity_walk(walls, top_face, back_face)
            if reaches_back:
                continue  # a through-cut, handled elsewhere - not blind
            # The pocket's own floor - not the opening loop on the part's
            # top surface. Confirmed live as the real fix, not the first
            # attempt: building the chain from the OPENING loop's edges
            # (even after correcting for the direction that loop's own
            # coedges implied) still gave the wrong result, because the
            # opening loop and the floor loop are entirely different edges
            # with their own independent orientation - not a top/bottom
            # face mirroring that a boolean flip could correct for.
            floor_face = _pocket_floor_face(top_face, visited)
            if floor_face is None:
                continue  # no real floor found - skip rather than guess
            floor_outer_loop = next((l for l in floor_face.loops if l.isOuter), None)
            if floor_outer_loop is None:
                continue
            floor_co_edges = list(floor_outer_loop.coEdges)
            floor_edges = [ce.edge for ce in floor_co_edges]
            if not floor_edges:
                continue
            seed = floor_co_edges[0]
            is_reverted = is_reverted_for_loop_seed(seed.isOpposedToEdge)
            if _is_circular_loop(floor_edges):
                circular_loops.append((floor_edges, is_reverted))
            else:
                other_chains.append((seed.edge, is_reverted))
    return circular_loops, other_chains


def _repair_missing_selections(setup) -> list[str]:
    """A template applied to a DIFFERENT part than the one it was originally
    exported from can carry geometry selections that don't resolve - "1 of 3
    files a real Fusion-exported template stores are edge/face IDs from the
    ORIGINAL part, and createFromCAMTemplate2 has no way to re-pick
    equivalent geometry on a new one. Confirmed directly on a real job
    (autocamtraining.step, a "many different operations" test part): 8 of 9
    operations from templates/971-real/(DEPRECATED)971 Metal Sheet.f3dhsm-
    template came back with a "missing selections to machine" warning
    despite all having Fusion's own auto-detection already enabled
    (contours=true / pockets=true in the raw template) - inspecting the
    actual selection objects showed real ChainSelection entries, each with
    its own `hasWarning=True, warning="Missing selection"` - the stale
    reference from whichever part the template was originally captured
    against, not something these auto-detect flags override on their own.

    Fix: replace the geometry selection with a fresh, model-based one -
    SilhouetteSelection for a contour2d perimeter/profile cut,
    PocketRecognitionSelection for a pocket2d/adaptive2d pocket-clearing
    operation - both auto-compute from the actual bound geometry instead of
    referencing specific edges/faces from another part. Verified directly:
    every one of the 8 broken operations came back isToolpathValid=True
    with no warning after this, and posted real, substantial G-code (2.5KB-
    149KB depending on the operation) with zero postProcess errors.

    An operation that still finds nothing after this (no warning cleared,
    or a genuinely empty toolpath) has no matching feature on this specific
    part - not this function's job to fix that; the isToolpathValid/empty-
    warning checks already in DeleteToolpaths() below handle it the same
    way they always have.
    """
    repaired = []
    # Computed at most once per call, lazily, only if actually needed -
    # walking every body's top face is real work, no reason to repeat it
    # per operation. design is shared by both caches below.
    design_cache = []  # single-item list used as a mutable box (no `nonlocal` needed)
    outer_edges_cache = None
    feature_chains_cache = None
    big_hole_edges_cache = None
    blind_pocket_cache = None  # (circular_loops, non_circular_chains), see _blind_pocket_loops_all_bodies

    def _design():
        if not design_cache:
            design_cache.append(
                adsk.fusion.Design.cast(
                    adsk.core.Application.get().activeDocument.products.itemByProductType(
                        "DesignProductType"
                    )
                )
            )
        return design_cache[0]

    def _curve_selection_state(op):
        """The (param, value, selections) triple for this op's real
        geometry-selection parameter, unconditionally - repair the caller
        decides to do is up to it. Returns None only when this op's own
        strategy has no such parameter at all.
        """
        param_name = _SELECTION_PARAM_BY_STRATEGY.get(op.strategy)
        if param_name is None:
            return None
        param = op.parameters.itemByName(param_name)
        if param is None:
            return None
        value = param.value
        if not hasattr(value, "getCurveSelections"):
            return None
        return (param, value, value.getCurveSelections())

    def _needs_repair(op):
        state = _curve_selection_state(op)
        if state is None:
            return None
        _param, _value, selections = state
        # A template's saved reference can disappear completely when the
        # source body is replaced - Fusion then returns an EMPTY collection
        # (count == 0) rather than a stale entry carrying hasWarning=True.
        # any() over an empty range is False, so this used to read as "not
        # missing" and skip repair entirely - confirmed live as the cause of
        # circular pockets silently generating no toolpath at all (the
        # operation kept its original, now-empty selection).
        has_missing = selections.count == 0 or any(
            selections.item(i).hasWarning for i in range(selections.count)
        )
        return state if has_missing else None

    def _is_outer_profile(op):
        # A contour2d operation is either the ONE real outer-profile cut
        # (group_tabs=true in the template's own default - see
        # TabPlacement.py for the full explanation of this same signal) or
        # a finishing pass for one specific internal feature (a hole,
        # pocket, or slot/kidney/pill a sibling roughing operation already
        # cleared).
        group_tabs_param = op.parameters.itemByName("group_tabs")
        return (
            op.strategy == "contour2d"
            and group_tabs_param is not None
            and str(group_tabs_param.expression).strip().lower() == "true"
        )

    # A single snapshot, used for both passes below - setup.operations is
    # Fusion's own live collection, and separate accesses to it are not
    # guaranteed to hand back the same Python proxy object for the same
    # underlying operation (confirmed by this file's own established
    # pattern elsewhere of snapshotting before any mutation - see
    # DeleteToolpaths's own toolpaths = list(setup.operations) comment).
    # A dict keyed by these proxy objects across two separate
    # `setup.operations` reads would silently never match; keying off one
    # shared snapshot instead removes the question entirely.
    ops_snapshot = list(setup.operations)

    # A non-circular loop on the physical bottom face is a through-cut, not
    # a blind pocket. Keep it in the template's own named Shape Through
    # operations. The old code relabeled the first arbitrary contour pass as
    # "Feature Slot Cut" and fed it every loop from a normal-filtered face;
    # on ordinary STEP files that face could be the pocket-bearing top, so a
    # simple pocketed plate acquired a fake feature-slot operation and wrong
    # geometry. A real Shape Through Hole / Shape Through Finishing Pass is
    # both clearer in CAM review and correctly scoped to through features.
    # "through" in the name, not just the two originally-seen exact
    # patterns - confirmed live as a real bug, not hypothetical: a
    # template's own "Small Shape Through Hole" operation (adaptive2d, a
    # smaller sibling of "Shape Through Hole") didn't match either of the
    # original two patterns, so it fell through to the generic blind-
    # pocket branch below instead - which fed it a real pocket's own floor
    # geometry while its own template-default depth stayed configured for
    # a through-cut ('from surface bottom', full material depth). Net
    # result: a real blind pocket got machined through the material
    # anyway, cut twice - once correctly (by whichever operation actually
    # is the general pocket op) and once straight through (by this one).
    # "circular" is excluded so this never collides with the dedicated
    # circular-hole operation below (">.3 Circular Through Hole" also
    # contains "through" but needs its own circular-loop-specific
    # handling, not this generic one).
    through_shape_ops = [
        op
        for op in ops_snapshot
        if "through" in op.name.lower() and "circular" not in op.name.lower()
    ]
    # The template's own dedicated feature-slot operation, if it ships one.
    # Confirmed against the two real templates: the New Router's
    # "new router metal sheet" template has "Slot Cut for Features"
    # (contour2d, group_tabs=false) alongside "Slot Cut for Edges"
    # (contour2d, group_tabs=true - the outer release cut), while the UNC
    # Router's "(DEPRECATED)971 Metal Sheet" template has only "2D Slot
    # Cut" and no feature-slot operation at all.
    feature_slot_ops = [op for op in ops_snapshot if _is_feature_slot_op(op.name.lower())]

    through_chain_assignments = {}
    if through_shape_ops or feature_slot_ops:
        design = _design()
        shape_chains, slot_chains = (
            _internal_feature_loop_chains_all_bodies(design) if design else ([], [])
        )
        # A slot only goes to a feature operation if the template actually
        # has one. Where it doesn't, slots stay with the through-shape
        # operations exactly as before - that keeps every template without
        # a feature operation working unchanged rather than silently
        # dropping its slots on the floor.
        if feature_slot_ops and slot_chains:
            for op in feature_slot_ops:
                through_chain_assignments[op.operationId] = slot_chains
            shape_only = shape_chains
        else:
            shape_only = shape_chains + slot_chains
        if shape_only:
            for op in through_shape_ops:
                through_chain_assignments[op.operationId] = shape_only

    # Pocket finishing passes are not a substitute for a real Shape Pocket:
    # their stale template references are removed. The adaptive Shape Pocket
    # operation below is rebuilt from PocketRecognitionSelection and owns
    # actual recessed floors; Shape Through Finishing Pass owns through-cut
    # chains. No generic "Feature Slot Cut" remains for a part that has no
    # slot feature.
    finishing_pass_ops = [
        op for op in ops_snapshot if op.strategy == "contour2d" and not _is_outer_profile(op)
    ]
    active_through_ids = set(through_chain_assignments)
    inactive_finishing_ops = [
        op for op in finishing_pass_ops if op.operationId not in active_through_ids
    ]
    inactive_finishing_ids = {op.operationId for op in inactive_finishing_ops}

    for op in ops_snapshot:
        if op.operationId in inactive_finishing_ids:
            continue
        is_outer = _is_outer_profile(op)
        is_through_shape_op = op.operationId in active_through_ids
        # The template's own dedicated big-hole operation (pocket2d,
        # named for exactly this - see _set_min_hole_diameter_from_name's
        # own comment) suffers the identical stale-selection flakiness
        # confirmed on the contour2d finishing passes above: Fusion can
        # report it as "not missing" after a fresh STEP import even
        # though the reference doesn't actually apply to this part, so
        # gating its repair on _needs_repair below would silently skip it
        # on some runs and leave it to be deleted by the generic
        # isToolpathValid==False cleanup - exactly what made this
        # operation look "never used" before this fix. Always repaired
        # outright, same treatment as the outer/feature operations.
        is_big_hole_op = op.strategy == "pocket2d" and _is_dedicated_circular_hole_op(op.name.lower())
        is_dedicated_circular_pocket_op = (
            op.strategy in _POCKET_STRATEGIES and _is_dedicated_circular_pocket_op(op.name.lower())
        )
        # Outer profile and feature-finishing-pass operations are always
        # repaired outright (see finishing_pass_ops's own comment on why
        # trusting "does this look missing" for them is flaky); everything
        # else (pocket2d/adaptive2d roughing, and any contour2d finishing
        # pass this part has no real feature left to give) keeps the
        # original conditional repair.
        # A template's saved PocketRecognitionSelection can look healthy
        # while still referring to the template's original model. Rebuild
        # every generic pocket operation from the imported part, not only
        # the ones Fusion happens to flag as missing. This is especially
        # important for blind pockets: their recognition is only valid after
        # the importer has deliberately put the pocket-bearing side on top.
        is_generic_pocket_op = (
            op.strategy in _POCKET_STRATEGIES
            and not is_big_hole_op
            and not is_dedicated_circular_pocket_op
        )
        repair_state = (
            _curve_selection_state(op)
            if (
                is_outer
                or is_through_shape_op
                or is_big_hole_op
                or is_dedicated_circular_pocket_op
                or is_generic_pocket_op
            )
            else _needs_repair(op)
        )
        if repair_state is None:
            continue
        param, value, selections = repair_state
        selections.clear()
        name_lower = op.name.lower()
        if is_outer:
            # createNewSilhouetteSelection() is NOT scoped to just the true
            # outer perimeter - confirmed live that it also picks up every
            # internal feature loop that goes all the way through the
            # material (holes, pockets, slots), so "2D Slot Cut" ended up
            # also cutting internal features it should have left entirely
            # alone. Built instead from each body's own real isOuter loop
            # edges only - the same distinction TabPlacement.py already
            # relies on for tab edges - via an explicit ChainSelection.
            # Combined across every body so a grouped job's shared
            # outer-profile operation gets every part's own outer boundary.
            if outer_edges_cache is None:
                design = _design()
                outer_edges_cache = _outer_loop_edges_all_bodies(design) if design else []
            for edges, is_reverted in outer_edges_cache:
                chain = selections.createNewChainSelection()
                chain.isOpen = False
                # Follows this loop's own co-edge winding rather than
                # asserting one direction for every part - see
                # _outer_loop_edges_all_bodies for why one formula covers
                # both outer and inner loops.
                #
                # Direction matters here for a specific, confirmed reason:
                # with the chain wound the wrong way relative to this
                # operation's 'left' compensation, the tool offsets INWARD
                # (into the part, toward its interior features) instead of
                # OUTWARD (into the scrap/stock side) for an outer release
                # cut. The raw edge-to-hole clearance on a real part was as
                # little as 0.1495in against a 0.1575in tool, so it only
                # stays ungouged if the tool offsets away from those
                # interior features.
                chain.isReverted = is_reverted
                chain.inputGeometry = edges
        elif is_through_shape_op:
            # Every real non-circular through feature belongs to the
            # template's existing Shape Through operation(s). ChainSelection
            # is necessary here: PocketRecognitionSelection recognizes a
            # recessed pocket floor, not arbitrary full-depth cutouts.
            #
            # Seeded from a single edge, not the outer profile's own
            # full-edge-list technique (assigning every edge in the loop to
            # inputGeometry at once) - confirmed live that technique
            # produces visibly wrong geometry here even though it works
            # for the outer profile. Fusion's own ChainSelection
            # auto-completes the rest of a closed, tangent-connected loop
            # from just one of its edges, so this doesn't depend on
            # loop.coEdges already being in the exact order/winding
            # Fusion's chain builder expects, the way passing every edge
            # explicitly does.
            for seed_edge, is_reverted in through_chain_assignments.get(op.operationId, []):
                chain = selections.createNewChainSelection()
                chain.isOpen = False
                # Follow this loop's co-edge orientation. A shared BRepEdge
                # can run either way on a face, so a hard-coded False made
                # some imported feature chains point the wrong way.
                chain.isReverted = is_reverted
                chain.inputGeometry = [seed_edge]
            # Tabs only belong to the final outer release contour. The
            # internal Shape Through Finishing Pass must never bridge a
            # cutout to the part, even if a template happens to carry a tab
            # default.
            tabs_per_contour = op.parameters.itemByName("tabsPerContour")
            if tabs_per_contour is not None:
                try:
                    tabs_per_contour.expression = "0"
                except Exception:
                    pass
            # Direct instruction, after a real part (Anton plate) needed a
            # second feature-cut operation and its actual G-code came out
            # cutting to Z0.025 - barely below the surface, not through the
            # material at all - while the first operation correctly cut to
            # Z-2.095. Root cause: the template's own raw operations don't
            # all share the same depth convention. Whichever one became the
            # first feature op already had bottomHeight_mode='from surface
            # bottom' (a real through-cut, 0.02in past the true bottom
            # face for clean breakthrough); the one repurposed as a second
            # operation had bottomHeight_mode='from contour' instead - tied
            # to the selected geometry's OWN Z (the top face, ~0), so it
            # never cut deeper than the surface it started from. Forced
            # explicitly on every feature-cut operation, not just trusted
            # from whatever the raw template op defaulted to, so a part
            # needing 2, 3, or more feature-cut operations always gets a
            # real through-cut on every one of them.
            top_height_mode = op.parameters.itemByName("topHeight_mode")
            if top_height_mode is not None:
                try:
                    top_height_mode.expression = "'from stock top'"
                except Exception:
                    pass
            top_height_offset = op.parameters.itemByName("topHeight_offset")
            if top_height_offset is not None:
                try:
                    top_height_offset.expression = "0in"
                except Exception:
                    pass
            bottom_height_mode = op.parameters.itemByName("bottomHeight_mode")
            if bottom_height_mode is not None:
                try:
                    bottom_height_mode.expression = "'from surface bottom'"
                except Exception:
                    pass
            bottom_height_offset = op.parameters.itemByName("bottomHeight_offset")
            if bottom_height_offset is not None:
                try:
                    bottom_height_offset.expression = "(-.02) * 1in"
                except Exception:
                    pass
        elif is_big_hole_op:
            # PocketRecognitionSelection's areHolesIncluded hole-search
            # cannot reliably find this part's real big circular
            # through-hole - confirmed live: isSetupModelSelected=True,
            # minimumHoleDiameter set correctly from the operation's own
            # ">.3" name, isToolpathValid=True, but "Generated toolpath is
            # empty" - a genuinely empty result on a truly fresh
            # SetupGenerator run, not a timing artifact (a prior "it
            # works" result turned out to be testing against a document
            # that already had this operation's selection correctly set
            # from an earlier, unrelated manual run - not a real repair by
            # this code path at all). Same root cause already fixed for
            # the internal kidney/pill features above:
            # PocketRecognitionSelection is built for a real recessed
            # pocket with a floor, not reliably for an arbitrary large
            # full-depth-through circular cutout either. Built via
            # ChainSelection instead, from the real circular loop edges
            # whose diameter meets this operation's own name threshold.
            if big_hole_edges_cache is None:
                design = _design()
                threshold_cm = _min_hole_diameter_cm_from_name(name_lower) or 0.0
                big_hole_edges_cache = (
                    _big_circular_loop_edges_all_bodies(design, threshold_cm) if design else []
                )
            if big_hole_edges_cache:
                for edges, is_reverted in big_hole_edges_cache:
                    chain = selections.createNewChainSelection()
                    chain.isOpen = False
                    chain.isReverted = is_reverted
                    chain.inputGeometry = edges
            else:
                # No real loop on this part actually meets this
                # operation's own name threshold - fall back to generic
                # recognition (harmless: this file's own cleanup removes
                # the operation afterward if that also finds nothing,
                # same as any other template operation that doesn't apply
                # to this specific part).
                recognition = selections.createNewPocketRecognitionSelection()
                recognition.isSetupModelSelected = True
                recognition.areHolesIncluded = True
                _set_min_hole_diameter_from_name(recognition, name_lower)
        elif is_dedicated_circular_pocket_op:
            # Same Fusion recognition failure as is_big_hole_op above, but
            # for a real BLIND circular pocket instead of a through-hole -
            # confirmed live: PocketRecognitionSelection(isSetupModelSelected
            # =True) came back "Generated toolpath is empty" for a real,
            # confirmed (topologically - see _blind_pocket_loops_all_bodies)
            # blind circular pocket on an actual test part. Built via
            # ChainSelection instead, from the real blind circular loops
            # whose diameter meets this operation's own name threshold -
            # same technique, same threshold convention as is_big_hole_op,
            # just sourced from the TOP face's blind loops instead of the
            # bottom face's through loops.
            if blind_pocket_cache is None:
                design = _design()
                blind_pocket_cache = _blind_pocket_loops_all_bodies(design) if design else ([], [])
            circular_blind_loops, _ = blind_pocket_cache
            threshold_cm = _min_hole_diameter_cm_from_name(name_lower) or 0.0
            matching = [
                (edges, is_reverted) for edges, is_reverted in circular_blind_loops
                if _circle_loop_diameter_cm(edges) >= threshold_cm
            ]
            if matching:
                for edges, is_reverted in matching:
                    chain = selections.createNewChainSelection()
                    chain.isOpen = False
                    chain.isReverted = is_reverted
                    chain.inputGeometry = edges
            else:
                # No real blind circular loop on this part meets this
                # operation's own name threshold - fall back to generic
                # recognition, same as is_big_hole_op's own fallback.
                recognition = selections.createNewPocketRecognitionSelection()
                recognition.isSetupModelSelected = True
                recognition.areHolesIncluded = True
                _set_min_hole_diameter_from_name(recognition, name_lower)
        else:
            # The general pocket-clearing operation (e.g. "Shape Pocket") -
            # every real blind pocket loop that ISN'T a dedicated circular
            # pocket's own job: every non-circular blind loop, plus any
            # blind circular loop too small to meet a dedicated circular
            # pocket operation's own name threshold (or if this template
            # has no such dedicated operation at all) - nothing blind is
            # left unassigned. Built via ChainSelection for the same reason
            # is_dedicated_circular_pocket_op is: PocketRecognitionSelection
            # confirmed live to return a genuinely empty toolpath for a
            # real blind pocket (a hex cutout) despite isSetupModelSelected
            # =True finding nothing wrong with the selection itself.
            if blind_pocket_cache is None:
                design = _design()
                blind_pocket_cache = _blind_pocket_loops_all_bodies(design) if design else ([], [])
            circular_blind_loops, non_circular_blind_chains = blind_pocket_cache
            claimed_diameters_cm = [
                _min_hole_diameter_cm_from_name(other.name.lower())
                for other in ops_snapshot
                if other.strategy in _POCKET_STRATEGIES
                and _is_dedicated_circular_pocket_op(other.name.lower())
            ]
            min_claimed_cm = min(
                (d for d in claimed_diameters_cm if d is not None), default=None
            )
            leftover_circular = [
                (edges, is_reverted) for edges, is_reverted in circular_blind_loops
                if min_claimed_cm is None or _circle_loop_diameter_cm(edges) < min_claimed_cm
            ]
            if non_circular_blind_chains or leftover_circular:
                for seed_edge, is_reverted in non_circular_blind_chains:
                    chain = selections.createNewChainSelection()
                    chain.isOpen = False
                    chain.isReverted = is_reverted
                    chain.inputGeometry = [seed_edge]
                for edges, is_reverted in leftover_circular:
                    chain = selections.createNewChainSelection()
                    chain.isOpen = False
                    chain.isReverted = is_reverted
                    chain.inputGeometry = edges
            else:
                # No real blind pocket found on this part at all - fall
                # back to generic recognition (harmless: this file's own
                # cleanup removes the operation afterward if that also
                # finds nothing, same as every other operation that
                # doesn't apply to this specific part).
                recognition = selections.createNewPocketRecognitionSelection()
                recognition.isSetupModelSelected = True
                recognition.areHolesIncluded = "circular" in name_lower and "hole" in name_lower
                _set_min_hole_diameter_from_name(recognition, name_lower)
        value.applyCurveSelections(selections)
        repaired.append(op.name)

    for op in inactive_finishing_ops:
        try:
            removed_name = op.name
            op.deleteMe()
            repaired.append(f"removed unused contour pass: {removed_name}")
        except Exception:
            # The final cleanup can still remove an empty operation if
            # Fusion declines to delete it before the next regeneration.
            pass
    return repaired


def _cap_other_way_feedrate(setup) -> list[str]:
    """adaptive2d (roughing) operations carry their own otherWayFeedrate
    parameter - Fusion's own built-in strategy default for the return pass
    of a bothWays clearing move, set independently of the tool's own
    programmed cutting feed (tool_feedCutting) and NOT part of this
    template's own XML (confirmed: not present anywhere in the raw
    .f3dhsm-template file) or the tool preset dict _conservative_router_preset
    scales - it's applied by Fusion itself at operation-creation time.

    Confirmed live as a real, direct consequence of lowering
    _ROUTER_FEED_RATE_SCALE in templateTools.py: with tool_feedCutting
    scaled down (80 -> 20 in/min) but otherWayFeedrate untouched at its
    original default (60in/min, now internally reported as 1524 vs 508 in
    Fusion's own units), every adaptive2d operation failed outright with
    "Other Way Feedrate: The other way feedrate exceeds the primary
    cutting feedrate" and produced zero toolpath - a real regression, not
    hypothetical (three real operations on a real part hit this: "Shape
    Through Hole", "Small Shape Through Hole", "Shape Pocket"). Clamping
    otherWayFeedrate down to tool_feedCutting whenever it exceeds it
    removes the warning outright, confirmed live; whatever real "Generated
    toolpath is empty" state remains after that (a real thin sheet part
    generally has nothing for a bulk-roughing pass to clear at all) is
    already handled by this file's own existing empty-toolpath cleanup
    below, unrelated to this fix.
    """
    capped = []
    for op in setup.operations:
        if op.strategy != "adaptive2d":
            continue
        other_param = op.parameters.itemByName("otherWayFeedrate")
        cutting_param = op.parameters.itemByName("tool_feedCutting")
        if other_param is None or cutting_param is None:
            continue
        try:
            other_value = other_param.value
            cutting_value = cutting_param.value.value
            if other_value.value > cutting_value:
                other_value.value = cutting_value
                capped.append(op.name)
        except Exception:
            continue
    return capped


def _has_real_pocket_floor(bodies, tolerance=1e-4) -> bool:
    """A genuine pocket has a flat floor strictly between a body's top and
    bottom - a through-hole or an outer profile only ever touches the top
    and bottom faces themselves, nothing in between. Confirmed directly on
    a real part (holes + outer profile, no pocket): its only flat-face Z
    heights were the top and bottom faces exactly, nothing between them.

    Why this check exists at all: the "Pocket" template operation this
    library uses is configured to cut the full stock depth (topHeight
    'from stock top' to bottomHeight 'from stock bottom') within a boundary
    that defaults to roughly the model's own footprint - correct for a part
    that actually has a recessed pocket, but on a part that doesn't, this
    combination has no real floor to stop at and instead clears across
    nearly the entire part face at full depth. Confirmed directly:
    boundaryMode's other choices ('none', 'silhouette', 'selection') don't
    fix this either - 'none' produced an even LARGER, less-contained
    toolpath than the default 'bounding-box', not a smaller one. The actual
    fix is knowing the operation doesn't apply to this part's geometry at
    all and removing it, the same principle DeleteToolpaths already applies
    to the template's disabled "Suppress" placeholder and to genuinely
    empty toolpaths - this is a third case of the same rule.
    """
    app = adsk.core.Application.get()
    for body in bodies:
        bb = body.boundingBox
        top_z, bottom_z = bb.maxPoint.z, bb.minPoint.z
        flat_zs = []
        for face in body.faces:
            try:
                normal = face.geometry.normal
            except Exception:
                continue
            if abs(normal.z) <= 0.99:
                continue
            try:
                z = face.pointOnFace.z
            except Exception:
                continue
            flat_zs.append(z)
        app.log(
            f"_has_real_pocket_floor: body top={top_z:.5f} bottom={bottom_z:.5f} "
            f"flat_face_zs={sorted(set(round(z, 5) for z in flat_zs))}"
        )
        for z in flat_zs:
            if z > bottom_z + tolerance and z < top_z - tolerance:
                return True
    return False


def waitForGeneration(setup, waitforcontour=False, quiet_checks_required=30):
    app = adsk.core.Application.get()
    # Settling before the check (below) closes the *first*-check race
    # (calling this immediately after cam.generateAllToolpaths() used to see
    # "nothing generating" before Fusion had flipped the flag on ANY
    # operation, and exit before generation had actually begun - the exact
    # shape of a real bug: cam.postProcess() failed with "Initialization
    # fails" on the FIRST toolpath posted while an identical call for the
    # very next toolpath succeeded moments later). It does NOT close a
    # second, later race: operations don't all start generating at once,
    # so there can be a real gap where op A has finished and op B hasn't
    # started yet - a single clean "nothing generating" read during that
    # gap looks identical to "everything is actually done". Confirmed this
    # second race is real, not theoretical: it deleted a fully valid,
    # untouched "2D Contour2" operation from a real job's Setup (the
    # perimeter/tab cut that frees the part from stock) - the operation
    # generated cleanly with no warning when re-created and waited on with
    # extra margin, so DeleteToolpaths's `isToolpathValid == False` check
    # below caught it mid-gap, not actually broken. Fixed by requiring
    # several consecutive clean reads before trusting the loop is done,
    # not just one.
    #
    # 5 (0.5s) was tried first and looked sufficient - it wasn't. A separate
    # bug (DeleteToolpaths mutating setup.operations while iterating it,
    # fixed elsewhere in this file) was skipping over the very item that
    # would have exposed 5 as too short, so a fix that only ever ran against
    # already-invalid-when-checked data looked like it worked. Once that
    # skip was fixed, the contour/tab operation was STILL being deleted as
    # invalid with quiet_checks_required=5 on a real job. Raised well past
    # what was observed necessary rather than re-tuning to the exact edge.
    quiet_streak = 0
    while quiet_streak < quiet_checks_required:
        adsk.doEvents()
        # activeViewport is None whenever Fusion's window isn't the active
        # one on screen (minimized, unfocused, or - as observed live during
        # unattended Runner testing - simply not the foreground app at that
        # instant) - confirmed live as a real crash (AttributeError: 'NoneType'
        # object has no attribute 'refresh'), not a theoretical case. A
        # second, related crash confirmed live: activeViewport can be a real,
        # non-None object and still have .refresh() raise (RuntimeError 2:
        # "InternalValidationError") during a Fusion UI transition (e.g. the
        # window not fully settled as foreground yet). The refresh here is a
        # best-effort nudge to help Fusion notice toolpath generation
        # progress, not something the wait loop actually depends on to
        # function correctly - so a failing refresh must never abort the
        # whole CAM job over a nudge that didn't need to succeed.
        if app.activeViewport is not None:
            try:
                app.activeViewport.refresh()
            except RuntimeError:
                pass
        time.sleep(0.1)
        if waitforcontour:
            generating = [
                (op.name, op.isGenerating) for op in setup.operations if op.isGenerating
            ]
        else:
            generating = [
                (op.name, op.isGenerating)
                for op in setup.operations
                if op.isGenerating and "Drill" in op.name
            ]
        if generating:
            quiet_streak = 0
        else:
            quiet_streak += 1
        # app.log(
        #     "waiting for generation...["
        #     + str([op for op in generating])
        #     + "] length:"
        #     + str(len(generating))
        # )


def DeleteToolpaths():
    ui = None
    app = adsk.core.Application.get()
    ui = app.userInterface
    design = app.activeProduct

    # Ensure we are in the CAM workspace
    cam = adsk.cam.CAM.cast(design)

    # Get all setups
    pastCache = 0
    allSetups = cam.setups
    # Iterate through setups
    for setup in allSetups:
        # Fix a real regression before anything below reads a warning or
        # decides what to delete - see _cap_other_way_feedrate's own
        # docstring. Must run first: the empty-toolpath cleanup loop right
        # below reads each operation's CURRENT warning, and an
        # otherWayFeedrate violation reports a different warning entirely
        # ("Other Way Feedrate...", not "empty"), so an uncapped roughing
        # operation would sail through this cleanup with zero toolpath and
        # never get caught.
        capped = _cap_other_way_feedrate(setup)
        if capped:
            app.log(f"Capped otherWayFeedrate (exceeded the scaled cutting feed) on: {capped}")
            # A parameter mutation invalidates the operation's toolpath but
            # does not itself queue regeneration (same real gap
            # ConfigureTabs's own mutations hit elsewhere in this file) -
            # without this, the empty-toolpath cleanup loop right below
            # would read each capped operation's STALE pre-fix warning
            # instead of its real post-fix state.
            cam.generateAllToolpaths(True)
            waitForGeneration(setup, waitforcontour=True)

        # Get toolpaths in the setup
        pastCache = 0
        while True:
            waitForGeneration(setup, waitforcontour=False)
            live_toolpaths = setup.operations
            if pastCache == len(live_toolpaths):
                break
            # Iterate through toolpaths
            pastCache = len(live_toolpaths)
            # list(...) snapshot for the same reason as the final loop below
            # - deleteMe() inside this loop mutates setup.operations while
            # it's being iterated, which can skip over an item that shifted
            # into an already-visited index. The pastCache/while-True retry
            # here would eventually catch a skipped item on a later pass
            # (length wouldn't match), but there's no reason to rely on that
            # when iterating a stable snapshot avoids the skip in the first
            # place.
            for toolpath in list(live_toolpaths):
                # Contours and every pocket-style operation get their
                # current model geometry rebuilt by _repair_missing_selections
                # below. A template's stale selection can look empty before
                # that repair, so deleting it here would remove a legitimate
                # Shape Through Hole or Shape Pocket before it gets a chance
                # to recognize the newly imported STEP. The later cleanup is
                # intentionally after regeneration and is the trustworthy
                # place to remove genuinely inapplicable operations.
                is_deferred = (
                    toolpath.strategy == "contour2d"
                    or toolpath.strategy in _POCKET_STRATEGIES
                )
                if is_deferred:
                    continue
                # Check the machining time of the toolpath
                if (
                    "Empty" in str(toolpath.warning)
                    or "empty" in str(toolpath.warning)
                    or "No holes" in str(toolpath.warning)
                ):
                    toolpath.deleteMe()
                elif "Drill" in toolpath.name and toolpath.isToolpathValid == False:
                    toolpath.deleteMe()
                elif "Drill" in toolpath.name:
                    cam.generateToolpath(toolpath)

        # Force regeneration before trusting isToolpathValid below - not
        # just settling. Root cause of a real bug: ConfigureTabs() mutates
        # group_tabs/tabsPerContour/noTabZones on the contour/tab operation,
        # which invalidates its toolpath, but nothing had
        # explicitly asked Fusion to regenerate it since. Raising
        # waitForGeneration's quiet-check threshold didn't help, because
        # there was nothing actually generating to wait out - the operation
        # just sat invalid, isGenerating=False, indefinitely, and the
        # eventual isToolpathValid==False check below deleted a real,
        # untouched operation. Confirmed directly: a real job's log showed
        # `2D Contour2 (9), strategy=contour2d, isToolpathValid=False` at
        # the exact deletion check, immediately after ConfigureTabs changed
        # that operation's tab configuration - invalidated by the mutation,
        # never regenerated afterward.
        # This file already had a "regenerate everything, then wait" call,
        # but only at the very end, after the deletion decisions below had
        # already been made against stale data - too late to matter.
        cam.generateAllToolpaths(True)
        waitForGeneration(setup, waitforcontour=True)

        # Repair geometry selections that didn't survive being applied to a
        # different part than the template was captured against (see
        # _repair_missing_selections's own docstring), then regenerate and
        # wait again so the operations below reflect their POST-repair
        # state - without this second wait, a just-repaired operation reads
        # the same way an invalidated-but-not-yet-regenerated one did in the
        # bug this file already fixed above.
        repaired = _repair_missing_selections(setup)
        if repaired:
            app.log(f"Repaired missing geometry selections on: {repaired}")
            cam.generateAllToolpaths(True)
            waitForGeneration(setup, waitforcontour=True)

        # Real Design product (app.activeProduct is the CAM product by this
        # point, same "'CAM' object has no attribute 'rootComponent'" reason
        # TabPlacement.py's own ConfigureTabs() already documents) - needed
        # to check body geometry for _has_real_pocket_floor below.
        real_design = adsk.fusion.Design.cast(
            app.activeDocument.products.itemByProductType("DesignProductType")
        )
        bodies = (
            [occ.bRepBodies.item(0) for occ in real_design.rootComponent.allOccurrences if occ.bRepBodies.count > 0]
            if real_design
            else []
        )
        # Default to "no pocket floor" (i.e. delete Pocket operations) if the
        # geometry lookup itself fails - between wrongly dropping a
        # legitimate Pocket operation and wrongly keeping one that clears
        # across most of a part at full depth, the former is the safe
        # direction to fail in.
        has_pocket_floor = _has_real_pocket_floor(bodies) if bodies else False

        # list(...) is load-bearing, not stylistic: setup.operations is
        # Fusion's own live collection, and deleteMe() below mutates it
        # while this loop is iterating over it. That's a real, confirmed
        # bug this session actually hit - deleting "Suppress" (index 1 of
        # e.g. [Bore, Suppress, Pocket, Contour]) shifts Pocket down into
        # index 1 and Contour into index 2; the iterator then moves on to
        # "the next index" (2), which is now Contour, having skipped over
        # Pocket entirely without ever evaluating it. Confirmed directly:
        # _has_real_pocket_floor correctly returned False (no pocket) on a
        # real run, yet the Pocket operation still weren't deleted - purely
        # because it got skipped by this index shift, not because the
        # pocket-floor check or generation timing was ever wrong. Iterating
        # a plain Python list snapshot instead means later deletions can't
        # move earlier not-yet-visited items out from under the iterator.
        toolpaths = list(setup.operations)
        for toolpath in toolpaths:
            app.log(
                f"Toolpath: {toolpath.name}, strategy={toolpath.strategy}, "
                f"isToolpathValid={toolpath.isToolpathValid}, Warning: {toolpath.warning}"
            )
            # No hole-name exemption here, unlike the has_pocket_floor
            # check further below - direct correction after this exemption
            # was confirmed live to be wrong on a second real part
            # (Anton plate, 1/16in aluminum): that part has no real hole
            # meeting the big-hole operation's own diameter threshold at
            # all, so _repair_missing_selections's own ChainSelection
            # fallback correctly found nothing and fell back to generic
            # recognition, which also found nothing - a genuinely empty
            # result, not a timing artifact, since this check runs AFTER
            # _repair_missing_selections's own regenerate+wait has already
            # settled. Exempting it here unconditionally kept a truly
            # inapplicable operation alive with zero toolpath, which then
            # made cam.postProcess() fail outright with "Initialization
            # fails" and aborted the whole job's export - a second,
            # different real bug behind the same symptom the original
            # exemption was written for. The ORIGINAL problem this
            # exemption was meant to solve (the big-hole op being deleted
            # here on a real part that DOES have a matching hole) is
            # already fixed by is_deferred in the earlier empty-cleanup
            # loop above, which defers hole-named pocket2d operations
            # until after repair - this later check reflects real,
            # post-repair state and should be trusted as such.
            if "empty" in str(toolpath.warning).lower():
                toolpath.deleteMe()
            elif toolpath.name == "Suppress":
                # Every template ships this as a disabled placeholder
                # operation - never meant to actually run. Previously only
                # skipped during export (NewNCProgram.py), which left it
                # sitting in the setup; a direct instruction to delete any
                # operation not actually in the job applies to this by
                # definition. Safe here specifically because this loop runs
                # after the full waitForGeneration(waitforcontour=True)
                # above, so non-Drill operations have actually finished
                # generating by this point.
                toolpath.deleteMe()
            elif (
                toolpath.strategy in _POCKET_STRATEGIES
                and not has_pocket_floor
                and not _is_dedicated_circular_hole_op(toolpath.name.lower())
            ):
                # Confirmed on a real job: this template's Pocket operation
                # is configured to cut the full stock depth within
                # ~the model's own footprint - correct for a part with a
                # real recessed pocket, but with no floor to stop at on a
                # part that doesn't have one, it clears across nearly the
                # entire part at full depth instead (isToolpathValid is
                # still True - Fusion considers this "successful", it's
                # just successfully doing the wrong thing). See
                # _has_real_pocket_floor's own docstring for how this was
                # confirmed and why boundaryMode isn't the actual fix.
                #
                # "hole" in the name is excluded on purpose: the template's
                # own ">.3 Circular Through Hole" is a pocket2d strategy
                # too (a bigger hole needs a real helical/pocket toolpath,
                # not a single bore plunge) but is a genuine through-hole
                # recognition operation, not a recessed pocket - direct
                # instruction confirmed this operation existed in the
                # template but was "never used" because this blanket
                # no-pocket-floor check deleted it outright before its own
                # hole-recognition ever got a chance to run. A real
                # "Pocket" operation (no "hole" in its name) still has no
                # such exemption and is still removed exactly as before.
                toolpath.deleteMe()
            elif toolpath.isToolpathValid == False:
                # Direct instruction: an operation the template included
                # that doesn't actually apply to this job's geometry (no
                # valid toolpath came out of it) should be deleted outright,
                # not just Drill-specific as the loop above already handles.
                toolpath.deleteMe()
        cam.generateAllToolpaths(True)
        waitForGeneration(setup, waitforcontour=True)
