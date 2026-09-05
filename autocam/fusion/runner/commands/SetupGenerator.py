import traceback
import adsk.core
import adsk.fusion
import adsk.cam
import os
from typing import Optional


def SetupGenerator(
    machine, truedepth, material, depth, *, template_path: Optional[str] = None
):
    app = adsk.core.Application.get()
    ui = app.userInterface
    camWS: adsk.core.Workspace = ui.workspaces.itemById("FusionSolidEnvironment")
    camWS: adsk.core.Workspace = ui.workspaces.itemById("CAMEnvironment")
    comp: adsk.fusion.Component = app.activeProduct.rootComponent
    occurances = []
    for occ in comp.allOccurrences:
        if occ.bRepBodies.count > 0:
            occurances.append(occ.bRepBodies.item(0))
    app.log(str(len(occurances)) + " parts to setup")
    camWS.activate()
    cam = adsk.cam.CAM.cast(
        app.activeDocument.products.itemByProductType("CAMProductType")
    )
    setupInput = cam.setups.createInput(0)
    setupInput.name = "Setup"
    setup = cam.setups.add(setupInput)
    setup.stockMode = adsk.cam.SetupStockModes.RelativeBoxStock
    setup.parameters.itemByName("job_stockOffsetMode").expression = "'all'"
    setup.parameters.itemByName("job_stockOffsetXBack").expression = ".5 in"
    setup.parameters.itemByName("job_stockOffsetYFront").expression = ".5 in"
    setup.parameters.itemByName("job_stockOffsetZFront").expression = (
        f"{truedepth-depth} in"
    )
    setup.parameters.itemByName("job_model").value.value = occurances
    # Z axis/plane + Y axis mode (not the two-in-plane-axes mode) - X is
    # derived automatically via the right-hand rule from Z and Y, rather
    # than picked directly, so its direction can only be controlled via
    # flipZ/flipY (there's no separate flipX in this mode). This exact
    # combination - no flips at all, box point 'bottom 1' - was verified
    # live against the real slapdih document via the Fusion MCP bridge by
    # directly checking the numbers (not just eyeballing a screenshot):
    # +Z points up, and BOTH +X and +Y point back into the stock from the
    # origin's corner, not away from it. (Two earlier attempts flipped Z or
    # Y to fix +X pointing into the stock, but each broke a different
    # requirement - Z pointing down, then Y pointing away from the stock -
    # because this axis pairing derives X from Z and Y, so flipping either
    # one to fix X's direction always flips something else too. Turns out
    # the un-flipped baseline already satisfies all three at once.)
    setup.parameters.itemByName("wcs_orientation_mode").expression = "'axesZY'"
    setup.parameters.itemByName("wcs_orientation_axisZ").value.value = [
        comp.zConstructionAxis
    ]
    setup.parameters.itemByName("wcs_orientation_axisY").value.value = [
        comp.xConstructionAxis
    ]
    setup.parameters.itemByName("wcs_orientation_flipZ").value.value = False
    setup.parameters.itemByName("wcs_orientation_flipY").value.value = False
    setup.parameters.itemByName("wcs_origin_boxPoint").expression = "'bottom 1'"
    baseDir = os.path.dirname(os.path.realpath(__file__))
    # machine is Swift and IQ, material is Aluminum and Polycarb
    if template_path:
        absolutePath = template_path
    else:
        candidates = []
        if machine == "Swift" and material == "AL 6061":
            candidates.append(
                os.path.join(baseDir, "../templates/AluminumSwift.f3dhsm-template")
            )
        elif machine == "Swift" and material == "Polycarb":
            candidates.append(
                os.path.join(baseDir, "../templates/PolycarbSwift.f3dhsm-template")
            )
        elif machine == "IQ" and material == "Polycarb":
            candidates.append(
                os.path.join(baseDir, "../templates/PolycarbIQ.f3dhsm-template")
            )
        elif machine == "IQ" and material == "AL 6061":
            candidates.append(
                os.path.join(baseDir, "../templates/AluminumIQ.f3dhsm-template")
            )

        # Fallback to the generic plate template included with this add-in.
        candidates.append(os.path.join(baseDir, "../templates/Plates.f3dhsm-template"))
        absolutePath = None
        for candidate in candidates:
            if os.path.exists(candidate):
                absolutePath = candidate
                break
        if absolutePath is None:
            raise FileNotFoundError("No CAM template file found.")
    TemplateFile = adsk.cam.CAMTemplate.createFromFile(absolutePath)
    template = adsk.cam.CreateFromCAMTemplateInput.create()
    template.camTemplate = TemplateFile
    setup.createFromCAMTemplate2(template)
    cam.generateAllToolpaths(skipValid=False)
