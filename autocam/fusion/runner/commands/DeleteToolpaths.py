import adsk.core, adsk.fusion, adsk.cam, traceback
import time


_POCKET_STRATEGIES = ("pocket_new", "pocket_clearing", "pocket2d")

# Maps each strategy to the name of its geometry-selection parameter - the
# thing that actually holds WHAT to cut, separate from all the how-to-cut
# parameters (feeds, stepdown, etc.) already handled elsewhere. Confirmed
# by direct inspection of a real operation's parameters, not guessed.
_SELECTION_PARAM_BY_STRATEGY = {
    "contour2d": "contours",
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


def _set_min_hole_diameter_from_name(recognition, name_lower: str) -> None:
    if not recognition.areHolesIncluded:
        return
    for marker, threshold_in in _MIN_HOLE_DIAMETER_NAME_THRESHOLDS_IN:
        if marker in name_lower:
            try:
                recognition.minimumHoleDiameter = threshold_in * 2.54
            except Exception:
                pass
            return


def _top_face(body):
    """Return the highest upward-facing planar face on a body.

    Some STEP imports report both opposing planar faces as upward-facing.
    Choosing by area can then tie and depend on Fusion's iteration order;
    Z height identifies the physical top face deterministically.
    """
    best_face, best_z = None, None
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


def _bottom_face(body):
    """Return the lowest upward-facing planar face on a body - see
    _top_face's own docstring for why "upward-facing" alone doesn't
    already mean "the top" on a real part (a STEP-export orientation
    quirk can report the bottom face's normal as upward too).

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
        if normal.z > 0.9 and (best_z is None or z < best_z):
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

    Taken from the BOTTOM face specifically (_bottom_face, not _top_face)
    - direct instruction: the outer/slot-cut contour selection should
    reference the bottom edge of the part around its entire perimeter.
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
                edges.append([co_edge.edge for co_edge in loop.coEdges])
                break
    return edges


def _is_circular_loop(edges) -> bool:
    """True if every edge in this loop is part of a circle - a genuine
    round hole boundary, already handled by the bore/circular-pocket
    operations' own dedicated hole-recognition machinery. A polygon-ish
    loop (a slot, kidney, or other pill/rounded-rectangle shape mixing
    straight and arc segments) is not circular and needs the dedicated
    ChainSelection-based finishing pass _internal_feature_loop_edges_all_bodies
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


def _internal_feature_loop_edges_all_bodies(design):
    """Every body's own internal (non-outer), non-circular loop - a real
    through-cut feature (a slot, kidney, pill, or any other non-round
    cutout) that needs its own dedicated ChainSelection-based finishing
    pass, combined across every body (same reasoning as
    _outer_loop_edges_all_bodies).

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

    Taken from the BOTTOM face (_bottom_face), same as
    _outer_loop_edges_all_bodies - direct instruction: the feature/slot
    cut selections should reference the bottom edge of the part, matching
    the outer profile's own contour selection.
    """
    feature_edges = []
    for occ in design.rootComponent.allOccurrences:
        if occ.bRepBodies.count == 0:
            continue
        top_face = _bottom_face(occ.bRepBodies.item(0))
        if top_face is None:
            continue
        for loop in top_face.loops:
            if loop.isOuter:
                continue
            edges = [co_edge.edge for co_edge in loop.coEdges]
            if not edges or _is_circular_loop(edges):
                continue
            feature_edges.append(edges)
    return feature_edges


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
    feature_edges_cache = None

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

    # First pass, read-only: every non-outer-profile contour2d finishing
    # pass in the setup - known up front so the second pass can pick the
    # single primary one to hold ALL of this part's real internal features
    # together, rather than spreading them across every available
    # finishing-pass operation. Direct instruction: every real internal
    # feature belongs in ONE "Feature Slot Cut" operation, not split
    # across "Feature Slot Cut" + "Feature Cut 2" - matches the real
    # reference program's own structure (a single "FEATURE SLOT CUT"
    # section covering every internal cutout). Sorted so an operation
    # whose template name already says "feature" (e.g. the New Router
    # metal template's own "Slot Cut for Features") is picked as that one
    # operation - the real, purpose-built operation for this - rather than
    # whichever generic "Shape ... Finishing Pass" happens to iterate
    # first.
    #
    # Do not gate contour finishing passes on _needs_repair: Fusion can
    # report stale template selections as healthy after a fresh STEP import.
    # This pass is rebuilt from the part's current internal features.
    finishing_pass_ops = sorted(
        (op for op in ops_snapshot if op.strategy == "contour2d" and not _is_outer_profile(op)),
        key=lambda op: 0 if "feature" in op.name.lower() else 1,
    )
    primary_feature_op = finishing_pass_ops[0] if finishing_pass_ops else None
    if primary_feature_op is not None:
        design = _design()
        feature_edges_cache = _internal_feature_loop_edges_all_bodies(design) if design else []
    # Only the ONE primary operation is treated as "the" feature-cut
    # operation - every OTHER contour2d finishing pass in the template
    # (a real part rarely needs more than one) falls through to the
    # ordinary conditional repair path below and, having no real feature
    # left to give it, ends up empty and is removed by this file's own
    # existing empty-toolpath cleanup, same as any other operation the
    # template shipped that doesn't apply to this specific part.
    feature_op_index = {primary_feature_op.operationId: 0} if primary_feature_op is not None else {}

    for op in ops_snapshot:
        is_outer = _is_outer_profile(op)
        is_feature_op = op.operationId in feature_op_index
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
        is_big_hole_op = (
            op.strategy == "pocket2d"
            and "circular" in op.name.lower()
            and "hole" in op.name.lower()
        )
        # Outer profile and feature-finishing-pass operations are always
        # repaired outright (see finishing_pass_ops's own comment on why
        # trusting "does this look missing" for them is flaky); everything
        # else (pocket2d/adaptive2d roughing, and any contour2d finishing
        # pass this part has no real feature left to give) keeps the
        # original conditional repair.
        repair_state = (
            _curve_selection_state(op) if (is_outer or is_feature_op or is_big_hole_op) else _needs_repair(op)
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
            for edges in outer_edges_cache:
                chain = selections.createNewChainSelection()
                chain.isOpen = False
                chain.isReverted = False
                chain.inputGeometry = edges
        elif is_feature_op and feature_edges_cache:
            # The ONE primary feature-cut operation gets EVERY real
            # internal feature loop on the part, each as its own
            # ChainSelection within the same operation - direct
            # instruction: every internal feature belongs in one "Feature
            # Slot Cut" operation, not split across several. feature_op_index
            # only ever maps the single primary_feature_op, so reaching
            # this branch at all already means "this is the one" - no
            # per-operation slicing needed. Built via ChainSelection, the
            # same proven technique as the outer profile above - not the
            # global PocketRecognitionSelection every other (genuinely
            # pocket-with-a-floor) finishing pass still uses, which has no
            # way to target these specific features and can't reliably
            # find a through-cut one at all.
            for edges in feature_edges_cache:
                chain = selections.createNewChainSelection()
                chain.isOpen = False
                chain.isReverted = False
                chain.inputGeometry = edges
            # Only rename a generically-named finishing pass being
            # repurposed for this (e.g. "Shape Through Finishing Pass") -
            # a template operation already named for this purpose (the New
            # Router metal template's own real "Slot Cut for Features")
            # keeps its own real name as-is.
            if "feature" not in name_lower:
                op.name = "Feature Slot Cut"
        else:
            recognition = selections.createNewPocketRecognitionSelection()
            # Without isSetupModelSelected, a PocketRecognitionSelection
            # has no model to search at all and silently recognizes
            # nothing - confirmed live as the cause of circular pockets
            # not generating any toolpath at all.
            recognition.isSetupModelSelected = True
            # areHolesIncluded is off by default (every pocket/adaptive
            # operation would otherwise also try to cut circular holes
            # meant for their own dedicated operation); only turn it on for
            # the operation actually named for that.
            recognition.areHolesIncluded = "circular" in name_lower and "hole" in name_lower
            _set_min_hole_diameter_from_name(recognition, name_lower)
        value.applyCurveSelections(selections)
        repaired.append(op.name)
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
        # object has no attribute 'refresh'), not a theoretical case. The
        # refresh here is a best-effort nudge to help Fusion notice toolpath
        # generation progress, not something the wait loop actually depends
        # on to function correctly.
        if app.activeViewport is not None:
            app.activeViewport.refresh()
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
                # A contour2d operation (the outer profile, or a candidate
                # feature-cut finishing pass) and a hole-named pocket2d
                # operation (the template's own dedicated big-hole cut)
                # both get their geometry selection unconditionally
                # rebuilt by _repair_missing_selections below, specifically
                # BECAUSE their stale template-carried selection can read
                # as broken/empty before that repair ever runs. Deleting
                # them here, on that same stale pre-repair warning, skips
                # the repair entirely - confirmed live as the exact reason
                # the big-hole operation kept disappearing even after its
                # own repair logic was fixed: this loop removed it first,
                # every time, before _repair_missing_selections ever got a
                # chance to run. Deferred to the later isToolpathValid
                # cleanup (after generateAllToolpaths + repair have both
                # run), which reflects their real, post-repair state.
                name_lower = toolpath.name.lower()
                is_deferred = toolpath.strategy == "contour2d" or (
                    toolpath.strategy == "pocket2d" and "hole" in name_lower
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
        # tabPositions/group_tabs/tabsPerContour on the contour/tab
        # operation, which invalidates its toolpath, but nothing had
        # explicitly asked Fusion to regenerate it since. Raising
        # waitForGeneration's quiet-check threshold didn't help, because
        # there was nothing actually generating to wait out - the operation
        # just sat invalid, isGenerating=False, indefinitely, and the
        # eventual isToolpathValid==False check below deleted a real,
        # untouched operation. Confirmed directly: a real job's log showed
        # `2D Contour2 (9), strategy=contour2d, isToolpathValid=False` at
        # the exact deletion check, immediately after ConfigureTabs's own
        # "tabPositions set to 4 point(s)" log line for that same operation
        # - invalidated by the tab mutation, never regenerated afterward.
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
                and "hole" not in toolpath.name.lower()
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
