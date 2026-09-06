# Author- Zachariah Sharma
# Description-
import adsk.core, adsk.fusion, adsk.cam, traceback
import time


_POCKET_STRATEGIES = ("pocket_new", "pocket_clearing", "pocket2d")


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
    for body in bodies:
        bb = body.boundingBox
        top_z, bottom_z = bb.maxPoint.z, bb.minPoint.z
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
            if z > bottom_z + tolerance and z < top_z - tolerance:
                return True
    return False


def waitForGeneration(setup, waitforcontour=False, quiet_checks_required=5):
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
    quiet_streak = 0
    while quiet_streak < quiet_checks_required:
        adsk.doEvents()
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

    # Real Design product (app.activeProduct is the CAM product by this
    # point, same "'CAM' object has no attribute 'rootComponent'" reason
    # TabPlacement.py's own ConfigureTabs() already documents) - needed to
    # check body geometry for _has_real_pocket_floor below.
    real_design = adsk.fusion.Design.cast(
        app.activeDocument.products.itemByProductType("DesignProductType")
    )
    bodies = (
        [occ.bRepBodies.item(0) for occ in real_design.rootComponent.allOccurrences if occ.bRepBodies.count > 0]
        if real_design
        else []
    )
    # Default to "no pocket floor" (i.e. delete Pocket operations) if the
    # geometry lookup itself fails - between wrongly dropping a legitimate
    # Pocket operation and wrongly keeping one that clears across most of
    # a part at full depth, the former is the safe direction to fail in.
    has_pocket_floor = _has_real_pocket_floor(bodies) if bodies else False

    # Get all setups
    pastCache = 0
    allSetups = cam.setups
    # Iterate through setups
    for setup in allSetups:
        # Get toolpaths in the setup
        pastCache = 0
        while True:
            waitForGeneration(setup, waitforcontour=False)
            toolpaths = setup.operations
            if pastCache == len(toolpaths):
                break
            # Iterate through toolpaths
            pastCache = len(toolpaths)
            for toolpath in toolpaths:
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
        waitForGeneration(setup, waitforcontour=True)
        toolpaths = setup.operations
        for toolpath in toolpaths:
            app.log(f"Toolpath: {toolpath.name}, Warning: {toolpath.warning}")
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
