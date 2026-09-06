# Author- Zachariah Sharma
# Description-
import adsk.core, adsk.fusion, adsk.cam, traceback
import time


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
            elif toolpath.isToolpathValid == False:
                # Direct instruction: an operation the template included
                # that doesn't actually apply to this job's geometry (no
                # valid toolpath came out of it) should be deleted outright,
                # not just Drill-specific as the loop above already handles.
                toolpath.deleteMe()
        cam.generateAllToolpaths(True)
        waitForGeneration(setup, waitforcontour=True)
