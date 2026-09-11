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

from .SpacerMath import default_tailstock_length_cm, has_hole


_CM_PER_IN = 2.54


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


def handleSpacer(template_filename, tailstock_length_in=None):
    """Create one turning setup for the imported spacer body.

    Returns a dict with the created setup, the measured spacer geometry (in
    inches, read back from Fusion's own auto-measurement), whether a bore
    was found, and the tailstock/live-center support length actually used
    (the caller's override, or the auto-detected default).
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

    drill = _find_operation(setup, "drill")
    if spacer_has_hole:
        bore = _bore_face(body)
        if bore is None:
            raise RuntimeError("Spacer CAM measured a bore diameter but found no matching cylindrical face")
        if drill is not None:
            _apply_bore_face(drill, bore)
    elif drill is not None:
        # No bore on this spacer - a stale template selection can never be
        # left in an active operation with nothing to drill.
        drill.deleteMe()

    tailstock_length_cm = (
        tailstock_length_in * _CM_PER_IN if tailstock_length_in is not None
        else default_tailstock_length_cm(model_length_cm)
    )

    return {
        "setup": setup,
        "spacerOd": model_diameter_cm / _CM_PER_IN,
        "spacerId": model_diameter_inner_cm / _CM_PER_IN if spacer_has_hole else None,
        "spacerLength": model_length_cm / _CM_PER_IN,
        "hasHole": spacer_has_hole,
        "tailstockLength": tailstock_length_cm / _CM_PER_IN,
    }
