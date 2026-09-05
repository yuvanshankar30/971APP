# Author- Zachariah Sharma
# Description-
import adsk.core, adsk.fusion, adsk.cam, traceback
import time


def waitForGeneration(setup, waitforcontour=False):
    app = adsk.core.Application.get()
    while True:
        # Settle before checking isGenerating, every iteration including
        # the first. cam.generateAllToolpaths() (DeleteToolpaths, below)
        # kicks generation off asynchronously and returns immediately -
        # its own return value, a GenerateToolpathFuture, isn't even
        # captured at either call site - so calling this function right
        # after it, the very first isGenerating check used to run before
        # Fusion had flipped the flag on ANY operation, see "nothing
        # generating" on an operation that hadn't started, and exit before
        # generation had actually begun. That is the exact shape of a real
        # bug this caused: cam.postProcess() failed with "Initialization
        # fails" on the FIRST toolpath posted (a Pocket) while an identical
        # call for the very next toolpath (a Profile) succeeded moments
        # later, once background generation had caught up on its own in the
        # meantime.
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
        if not generating:
            break
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
        cam.generateAllToolpaths(True)
        waitForGeneration(setup, waitforcontour=True)
