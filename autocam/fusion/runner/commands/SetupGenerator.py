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
    # derived automatically via the right-hand rule from these two, rather
    # than picked directly. Verified live against the real slapdih document
    # via the Fusion MCP bridge: with axisZ=Z, axisY=X, no flips, and box
    # point 'bottom 2', the resulting origin lands exactly on the model's
    # own (Xmin, Ymin, Zmin) bounding-box corner - a real geometric corner,
    # not a computed guess. Box point 'bottom 1' put Y at the model's Ymax
    # instead (box-point min/max is in the WCS's own local axes, which here
    # run opposite the model's Y), and flipping Y instead of changing the
    # box point flips X along with it (right-hand rule again), landing on a
    # different mixed corner - 'bottom 2' was the one that matched both
    # mins at once.
    setup.parameters.itemByName("wcs_orientation_mode").expression = "'axesZY'"
    setup.parameters.itemByName("wcs_orientation_axisZ").value.value = [
        comp.zConstructionAxis
    ]
    setup.parameters.itemByName("wcs_orientation_axisY").value.value = [
        comp.xConstructionAxis
    ]
    setup.parameters.itemByName("wcs_orientation_flipZ").value.value = False
    setup.parameters.itemByName("wcs_orientation_flipY").value.value = False
    setup.parameters.itemByName("wcs_origin_boxPoint").expression = "'bottom 2'"
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
