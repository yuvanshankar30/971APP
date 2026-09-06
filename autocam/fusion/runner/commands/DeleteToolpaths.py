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


def _top_face(body):
    """Largest planar, upward-facing face on a body - same concept
    TabPlacement.py's _find_top_face uses, kept independent since this
    module has no import relationship with that one.
    """
    best_face, best_area = None, 0.0
    for face in body.faces:
        try:
            normal = face.geometry.normal
        except Exception:
            continue
        if normal.z > 0.9 and face.area > best_area:
            best_area = face.area
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
    (the same distinction TabPlacement.py already relies on for tab
    edges) has no such ambiguity. Combined across every body so a grouped
    multi-part job's shared outer-profile operation gets every part's own
    real outer boundary, not just one.
    """
    edges = []
    for occ in design.rootComponent.allOccurrences:
        if occ.bRepBodies.count == 0:
            continue
        top_face = _top_face(occ.bRepBodies.item(0))
        if top_face is None:
            continue
        for loop in top_face.loops:
            if loop.isOuter:
                edges.append([co_edge.edge for co_edge in loop.coEdges])
                break
    return edges


# A closed internal loop's own bounding-box long axis divided by its short
# axis - a real reference CAM program (a manual setup for the same kind of
# part) treats an elongated slot cutout as a genuinely different operation
# ("Slot Cut For Features") from a roughly-circular hole or pocket
# ("Circular Pocket", "Shape Pocket"). No single authoritative ratio
# distinguishes "slot" from "not a slot"; 2.5 is a middle ground clear of a
# real square/circular feature's ratio of 1 while still catching a real
# reference slot's own measured ratio (a 23mm x 4mm rounded slot in
# practice.ngc, ~6:1).
_SLOT_ASPECT_RATIO = 2.5


def _slot_loop_edges_all_bodies(design):
    """Every body's own internal (non-outer) loops whose bounding box is
    elongated rather than roughly circular/square - real slot-shaped
    cutouts, not a round hole or a compact pocket. See _SLOT_ASPECT_RATIO
    for why 2.5. Combined across every body, same reasoning as
    _outer_loop_edges_all_bodies.
    """
    slot_edges = []
    for occ in design.rootComponent.allOccurrences:
        if occ.bRepBodies.count == 0:
            continue
        top_face = _top_face(occ.bRepBodies.item(0))
        if top_face is None:
            continue
        for loop in top_face.loops:
            if loop.isOuter:
                continue
            edges = [co_edge.edge for co_edge in loop.coEdges]
            xs, ys = [], []
            for edge in edges:
                try:
                    start = edge.pointOnEdge
                except Exception:
                    continue
                xs.append(start.x)
                ys.append(start.y)
            if len(xs) < 2:
                continue
            width = max(xs) - min(xs)
            height = max(ys) - min(ys)
            long_axis, short_axis = max(width, height), min(width, height)
            if short_axis <= 1e-6:
                continue
            if long_axis / short_axis >= _SLOT_ASPECT_RATIO:
                slot_edges.append(edges)
    return slot_edges


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
    slot_edges_cache = None
    feature_slot_assigned = False

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

    for op in setup.operations:
        param_name = _SELECTION_PARAM_BY_STRATEGY.get(op.strategy)
        if param_name is None:
            continue
        param = op.parameters.itemByName(param_name)
        if param is None:
            continue
        value = param.value
        if not hasattr(value, "getCurveSelections"):
            continue
        selections = value.getCurveSelections()
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
        if not has_missing:
            continue
        selections.clear()
        # A contour2d operation is either the ONE real outer-profile cut
        # (group_tabs=true in the template's own default - see
        # TabPlacement.py for the full explanation of this same signal) or
        # a finishing pass for one specific internal feature (a hole,
        # pocket, or slot a sibling roughing operation already cleared).
        # The real reference CAM program (a manual setup for the same kind
        # of part) keeps these as genuinely separate operations - "Shape
        # Through Finishing Pass", "Shape Pocket Finishing Pass", "Slot
        # Cut For Features" are three distinct named sections, not one
        # merged operation - so each contour2d finishing pass here keeps
        # its own template name and gets its own repaired selection; nothing
        # here deletes or renames them.
        group_tabs_param = op.parameters.itemByName("group_tabs")
        is_outer_profile = (
            op.strategy == "contour2d"
            and group_tabs_param is not None
            and str(group_tabs_param.expression).strip().lower() == "true"
        )
        name_lower = op.name.lower()
        if is_outer_profile:
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
        else:
            # The first non-outer-profile contour2d finishing pass that
            # needs repair on a part with a real elongated slot cutout
            # becomes the dedicated slot operation, renamed "Feature Slot
            # Cut" to match the reference program's own naming - built
            # from just that slot loop's edges via ChainSelection, the
            # same proven technique as the outer profile above, not the
            # global PocketRecognitionSelection every other finishing pass
            # uses (which has no way to target one specific feature and
            # would recognize this slot along with everything else too).
            # Every other finishing pass keeps its own template name and
            # the existing whole-model recognition - a real part may have
            # no slot at all, in which case this branch never fires and
            # nothing changes from before.
            if op.strategy == "contour2d" and not feature_slot_assigned:
                if slot_edges_cache is None:
                    design = _design()
                    slot_edges_cache = _slot_loop_edges_all_bodies(design) if design else []
                if slot_edges_cache:
                    for edges in slot_edges_cache:
                        chain = selections.createNewChainSelection()
                        chain.isOpen = False
                        chain.isReverted = False
                        chain.inputGeometry = edges
                    op.name = "Feature Slot Cut"
                    feature_slot_assigned = True
                    value.applyCurveSelections(selections)
                    repaired.append(op.name)
                    continue
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
        value.applyCurveSelections(selections)
        repaired.append(op.name)
    return repaired


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
            elif toolpath.strategy in _POCKET_STRATEGIES and not has_pocket_floor:
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
                toolpath.deleteMe()
            elif toolpath.isToolpathValid == False:
                # Direct instruction: an operation the template included
                # that doesn't actually apply to this job's geometry (no
                # valid toolpath came out of it) should be deleted outright,
                # not just Drill-specific as the loop above already handles.
                toolpath.deleteMe()
        cam.generateAllToolpaths(True)
        waitForGeneration(setup, waitforcontour=True)
