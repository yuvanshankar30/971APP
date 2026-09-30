"""Build a Fusion turning setup for a spacer from its own imported body.

A spacer's finished shape - OD, an optional through bore, and length - IS
the imported model; there is no separate raw-stock body to import. The
reviewed template's stock mode (Relative Cylinder) auto-generates the
round-bar stock envelope around whatever body is bound as job_model, and its
own modelDiameter/modelDiameterInner/modelLength parameters auto-measure
that body once bound - this module reads those values back rather than
re-measuring geometry itself.

Reference: an operator-built Spacer Turning setup (Face -> Profile Roughing
-> Drill -> Profile Finishing -> Part), exported live via
CAM.generateTemplateXML() to templates/971-real/Spacer Turning.f3dhsm-template
and verified against the exact operations, parameters, and hole-face
selection read from that same document. See HandleTube.py for the
established pattern this follows (template-driven setup, rebind body/
geometry after import, delete operations with no matching feature).
"""

import adsk.core
import adsk.fusion
import adsk.cam
import time

from .ChuckFixture import attach_chuck_at_chuck_front, jaw_length_cm
from .SpacerMath import has_hole
from .StockMath import resolve_spacer_stock


_CM_PER_IN = 2.54
# Raw bar left ahead of the finished front face for the Face operation to
# true up, and (default) behind the part for the chuck to hold and the Part
# operation to cut through. Both are only defaults: an operator-set bar
# length or tailstock length replaces the back allowance (see StockMath).
_FRONT_ALLOWANCE_IN = 0.05
_DEFAULT_GRIP_IN = 0.25
_MIN_GRIP_IN = 0.1


def _active_cam_product(app, doc):
    """Activate Manufacture and wait for Fusion to attach CAM to ``doc``.

    Same reasoning and wait loop as HandleTube.py's _active_cam_product: a
    new Fusion design document initially has only a Design product; CAM
    attaches lazily once Manufacture is activated.
    """
    try:
        workspace = app.userInterface.workspaces.itemById("CAMEnvironment")
        if workspace:
            workspace.activate()
    except Exception:
        pass
    for _ in range(20):
        try:
            product = doc.products.itemByProductType("CAMProductType")
        except RuntimeError:
            product = None
        cam = adsk.cam.CAM.cast(product) if product else None
        if cam:
            return cam
        adsk.doEvents()
        time.sleep(0.1)
    raise RuntimeError(
        "Fusion did not create a CAM product after activating Manufacture; "
        "verify the Manufacturing extension is available."
    )


def _cylindrical_faces(body):
    return [face for face in body.faces if face.geometry.objectType == adsk.core.Cylinder.classType()]


def _bore_face(body):
    """The spacer's own through-bore cylindrical face, or None for solid stock.

    A spacer's bore is the one internal cylindrical face concentric with the
    part's own turning axis - never the outer OD turned surface (also a
    cylinder). Distinguished by radius: on a part this simple (confirmed live
    - exactly 4 faces: OD cylinder, bore cylinder, two end caps) the bore is
    always the smaller of the two coaxial cylindrical faces. A stepped OD or
    a counterbore would add more cylindrical faces than this one-hole
    contract expects; raised rather than silently picking one.
    """
    cylinders = _cylindrical_faces(body)
    if len(cylinders) == 0:
        return None
    if len(cylinders) != 2:
        raise ValueError(
            "Spacer CAM expects exactly one OD cylinder and, if any, one bore "
            "cylinder; found {} cylindrical faces - a stepped OD, counterbore, "
            "or other feature is outside today's one-hole contract".format(len(cylinders))
        )
    inner, outer = sorted(cylinders, key=lambda face: adsk.core.Cylinder.cast(face.geometry).radius)
    return inner


def _bind_job_model(setup, body):
    setup.parameters.itemByName("job_model").value.value = [body]


def _find_operation(setup, name_lower):
    for operation in setup.operations:
        if str(operation.name or "").lower().startswith(name_lower):
            return operation
    return None


def _apply_bore_face(operation, face):
    parameter = operation.parameters.itemByName("holeFaces")
    parameter.value.value = [face]


def _apply_stock(setup, resolved):
    """Set the setup's fixed-cylinder stock to the resolved bar, its front
    ``_FRONT_ALLOWANCE_IN`` ahead of the part (Fusion's "front" stock
    placement with a positive offset - confirmed live) and the rest behind,
    and put Fusion's chuck-front plane at the jaw tips over the carried grip.
    """
    parameters = setup.parameters
    parameters.itemByName("job_stockMode").value.value = "fixedcylinder"
    parameters.itemByName("job_stockDiameter").expression = "{:.6f} in".format(resolved["od_cm"] / _CM_PER_IN)
    parameters.itemByName("job_stockDiameterInner").expression = "{:.6f} in".format(resolved["id_cm"] / _CM_PER_IN)
    parameters.itemByName("job_stockLength").expression = "{:.6f} in".format(resolved["length_cm"] / _CM_PER_IN)
    parameters.itemByName("job_stockLengthMode").value.value = "front"
    parameters.itemByName("job_stockLengthOffset").expression = "{:.6f} in".format(_FRONT_ALLOWANCE_IN)
    resolved["jaw_cm"] = jaw_length_cm(resolved["grip_cm"])
    parameters.itemByName("chuckFront_mode").value.value = "stock back"
    parameters.itemByName("chuckFront_offset").expression = "{:.6f} in".format(resolved["jaw_cm"] / _CM_PER_IN)
    adsk.doEvents()


def handleSpacer(template_filename, tailstock_length_in=None, stock=None):
    """Create one turning setup for the imported spacer body.

    Returns a dict with the created setup, the measured spacer geometry (in
    inches, read back from Fusion's own auto-measurement), whether a bore
    was found, and the stock actually used. ``stock`` (all optional, inches:
    ``od_in``, ``id_in``, ``length_in``) and ``tailstock_length_in`` are the
    operator's queue-time choices; anything left out is derived from the
    imported spacer (see StockMath.resolve_spacer_stock). The tailstock length
    is the material carried behind the part for the chuck to hold.
    """
    app = adsk.core.Application.get()
    doc = app.activeDocument
    if not doc:
        raise RuntimeError("No active document for spacer CAM")
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    if not design:
        raise RuntimeError("Spacer CAM requires an active Design product")
    cam = _active_cam_product(app, doc)
    if design.rootComponent.occurrences.count != 1:
        raise ValueError("Spacer CAM requires exactly one imported spacer occurrence")
    occurrence = design.rootComponent.occurrences.item(0)
    if occurrence.bRepBodies.count != 1:
        raise ValueError("Spacer CAM requires exactly one solid body")
    body = occurrence.bRepBodies.item(0)

    template_file = adsk.cam.CAMTemplate.createFromFile(template_filename)
    template_input = adsk.cam.CreateFromCAMTemplateInput.create()
    template_input.camTemplate = template_file

    setup_input = cam.setups.createInput(adsk.cam.OperationTypes.TurningOperation)
    setup_input.name = "Spacer"
    setup = cam.setups.add(setup_input)
    _bind_job_model(setup, body)
    setup.createFromCAMTemplate2(template_input)
    # createFromCAMTemplate2 returns before Fusion has fully attached the
    # copied operations to this setup's CAM model tree - see HandleTube.py's
    # matching comment. A selection applied in that same API turn is
    # rejected as "Do not have valid curve selections" even though the
    # underlying geometry is valid.
    adsk.doEvents()
    time.sleep(0.1)
    # The template can carry its own setup context; reapply our occurrence
    # body so every read/selection below resolves in this setup's actual CAM
    # model tree, never the template's old one.
    _bind_job_model(setup, body)
    adsk.doEvents()

    def _measured(name):
        return setup.parameters.itemByName(name).value.value

    model_diameter_cm = _measured("modelDiameter")
    model_diameter_inner_cm = _measured("modelDiameterInner")
    model_length_cm = _measured("modelLength")
    spacer_has_hole = has_hole(model_diameter_inner_cm)

    stock_input = stock or {}

    def _cm_or_none(value):
        return None if value is None else float(value) * _CM_PER_IN

    resolved = resolve_spacer_stock(
        model_od_cm=model_diameter_cm,
        model_id_cm=model_diameter_inner_cm if spacer_has_hole else 0.0,
        model_length_cm=model_length_cm,
        front_allowance_cm=_FRONT_ALLOWANCE_IN * _CM_PER_IN,
        default_grip_cm=_DEFAULT_GRIP_IN * _CM_PER_IN,
        minimum_grip_cm=_MIN_GRIP_IN * _CM_PER_IN,
        stock_od_cm=_cm_or_none(stock_input.get("od_in")),
        stock_id_cm=_cm_or_none(stock_input.get("id_in")),
        stock_length_cm=_cm_or_none(stock_input.get("length_in")),
        tailstock_cm=_cm_or_none(tailstock_length_in),
    )
    _apply_stock(setup, resolved)

    drill = _find_operation(setup, "drill")
    if spacer_has_hole:
        bore = _bore_face(body)
        if bore is None:
            raise RuntimeError("Spacer CAM measured a bore diameter but found no matching cylindrical face")
        if drill is not None:
            if resolved["drill_needed"]:
                _apply_bore_face(drill, bore)
            else:
                # Tube stock already bored to the part's own bore.
                drill.deleteMe()
    elif drill is not None:
        # No bore on this spacer - a stale template selection can never be
        # left in an active operation with nothing to drill.
        drill.deleteMe()

    # Last, after every parameter above has resolved: adding solids to the
    # design earlier would disturb the template's own measured values.
    attach_chuck_at_chuck_front(
        design.rootComponent, setup, resolved["od_cm"] / 2.0, resolved["jaw_cm"]
    )

    return {
        "setup": setup,
        "spacerOd": model_diameter_cm / _CM_PER_IN,
        "spacerId": model_diameter_inner_cm / _CM_PER_IN if spacer_has_hole else None,
        "spacerLength": model_length_cm / _CM_PER_IN,
        "hasHole": spacer_has_hole,
        "tailstockLength": resolved["grip_cm"] / _CM_PER_IN,
        "stock": {
            "od": resolved["od_cm"] / _CM_PER_IN,
            "id": resolved["id_cm"] / _CM_PER_IN if resolved["id_cm"] else None,
            "length": resolved["length_cm"] / _CM_PER_IN,
        },
    }
