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
    # Requirements, all of which matter (confirmed the hard way - flipping
    # Z to satisfy the other two once caused a real "exceeds machine
    # maximum on Z" fault on the actual router, because it silently
    # inverted retract moves into plunges): origin at the bottom-left
    # corner, +X and +Y both pointing back into the stock from there, and
    # +Z pointing away from the stock (up) so retract moves stay retracts.
    #
    # An earlier version used 'axesZY' mode (deriving X from Z and Y),
    # which coupled fixing X's direction to breaking either Z's or Y's -
    # every combination of flips in that mode traded one requirement for
    # another. Switching to plain 'axesXY' mode with NO axis swap (X tied
    # to the model's own X, Y to its own Y) and NO flips at all satisfies
    # all three simultaneously - verified numerically against the real
    # slapdih document via the Fusion MCP bridge, box point 'bottom 1'.
    #
    # Box-point corner labels ('bottom 1', 'bottom 2', ...) do NOT map to a
    # fixed physical corner across different flip/axis states or even
    # across documents - Fusion silently relabels which string means which
    # corner. If this is touched again, verify origin position and axis
    # directions numerically against a live document rather than reasoning
    # about what the label should mean.
    setup.parameters.itemByName("wcs_orientation_mode").expression = "'axesXY'"
    setup.parameters.itemByName("wcs_orientation_axisX").value.value = [
        comp.xConstructionAxis
    ]
    setup.parameters.itemByName("wcs_orientation_axisY").value.value = [
        comp.yConstructionAxis
    ]
    setup.parameters.itemByName("wcs_orientation_flipX").value.value = False
    setup.parameters.itemByName("wcs_orientation_flipY").value.value = False
    # 'top 1' - Z=0 at the top face of the stock (the surface an operator
    # actually touches off), not the bottom - cutting depths come out
    # negative from there, the normal convention. Same XY corner as before
    # ('bottom 1'), just the other Z face.
    setup.parameters.itemByName("wcs_origin_boxPoint").expression = "'top 1'"
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
