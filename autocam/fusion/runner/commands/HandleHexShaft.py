"""Build Fusion turning setups for a hex shaft from its own imported body.

Fusion's turning module has no native hex-stock shape - unlike
HandleSpacer.py's round bar (Fusion's own Relative Cylinder auto-stock), a
hex bar has to be built as a real solid body and referenced via stock mode
'solid' ("From solid"). Across-flats, groove position/width/floor-diameter,
and the shaft's own length are all read from the imported model's geometry;
the neck-turn diameter is never independently measured - it is fixed at
exactly the hex's own inscribed-circle diameter (HexShaftMath.neck_radius_cm),
since a continuous circular groove cannot be cut into an interrupted hex
cross section.

One shaft type only, as instructed: a plain hex bar, turned round and
grooved at each end for a snap ring, hex everywhere else. Reference:
"Hex Shaft CAM", a hand-modeled Model (finished shape) and Stock (raw 0.5in
hex bar) body pair - Stock's own spatial placement in that document doesn't
overlap Model's, so it is read only for its across-flats/length convention,
not reused as a real body; fresh hex-prism stock bodies are built here
around whichever body is actually imported for a real job.

Confirmed live (real hex shaft geometry, not an assumption): a model with a
groove at each end needs two setups, not one - the operator chucks extra-
length raw stock, faces/necks/grooves the first end, then re-chucks the
now-finished end to expose and machine the second end. The raw excess
stays attached PERMANENTLY through and after both setups (it is what the
chuck grips throughout, and what a tailstock/live center can bear against)
- CAM never faces it off and never parts the finished blank free. An
earlier version of this module added a final staged-Face-plus-Part
sequence to do exactly that, but confirmed live on a real job: even with
an explicit geometry-clearance check in place, it still reached into and
machined away a real snap-ring groove. Direct instruction after seeing
that: "remove that facing operation... dont even cut off the part of the
stock that makes it fall... IT SHOULD DO ANYTHING BUT THAT LAST FACING
OPERATION BECAUSE THAT REMOVES THE GROOVES." Every setup now ends after
its own light tip-face, roughing, finishing, and groove - see
_build_hex_end_setup's own docstring.
"""

import adsk.core
import adsk.fusion
import adsk.cam
import math
import time

from .HexShaftMath import (
    circumscribed_radius_cm,
    cluster_groove_faces,
    is_groove_floor_radius,
    neck_radius_cm,
)
_CM_PER_IN = 2.54
_PARALLEL_TOLERANCE = 0.985
# How far past the finished shaft's own length the raw stock extends on the
# back (grip) side, carried through BOTH setups (not a measured value - a
# workholding/tailstock-support allowance) and only faced+parted off as the
# last setup's own final operations - see _build_hex_end_setup. Overridden
# by the operator's own tailstock_length_in when given (handleHexShaft's
# own "make sure the user input for tailstock works" instruction); this is
# only the fallback when they don't provide one.
_DEFAULT_TAILSTOCK_LENGTH_IN = 1.5
# The real floor on tailstock_length_in - not a preference, a physical
# requirement: the chuck needs SOME real material to grip through both
# setups (grip_cm subtracts directly from the stock's own bounds - see
# handleHexShaft's own _build_hex_stock calls). Confirmed as a real,
# unvalidated gap: an operator-supplied 0 (or a negative value able to
# reach the Runner despite the UI's own client-side min="0", which nothing
# server-side re-checks) would silently build a stock prism with no grip
# allowance at all, or shorter than the finished part itself, and neither
# is caught until a human notices in Fusion.
_MIN_TAILSTOCK_LENGTH_IN = 0.25
# A small synthetic raw-stock overage built onto each setup's own working
# tip (see handleHexShaft's own _build_hex_stock calls), so that setup's
# light tip-facing pass (see _build_hex_end_setup) has real, if tiny,
# material to true up before turning starts - a real sawn bar is never
# perfectly flush with the finished model's own length. Direct instruction:
# "try to make it remove 0.005" - deliberately tiny, nothing like the old
# single deep facing plunge this replaces.
_TIP_FACE_ALLOWANCE_IN = 0.005


def _vec(v):
    return (v.x, v.y, v.z)


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a, b):
    return (a.x - b.x, a.y - b.y, a.z - b.z)


def _active_cam_product(app, doc):
    """Same reasoning and wait loop as HandleTube.py's own helper."""
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


def _find_shaft_body(root):
    """The finished hex-shaft body, imported or hand-modeled.

    A real STEP-imported job (matching HandleTube.py/HandleSpacer.py's own
    requirement) creates exactly one occurrence holding exactly one body -
    the finished shaft, with no separate raw-stock body shipped in the job
    (synthetic ones are built here instead; see _build_hex_stock). A body
    named "Model" living directly in the root component is also accepted,
    matching the reviewed reference document's own hand-modeled layout.
    """
    named = root.bRepBodies.itemByName("Model")
    if named is not None:
        return named
    if root.occurrences.count == 1:
        occurrence_bodies = root.occurrences.item(0).bRepBodies
        named = occurrence_bodies.itemByName("Model")
        if named is not None:
            return named
        if occurrence_bodies.count == 1:
            return occurrence_bodies.item(0)
    if root.bRepBodies.count == 1:
        return root.bRepBodies.item(0)
    raise ValueError(
        "Hex shaft CAM requires a body named 'Model', or exactly one imported "
        "occurrence with exactly one body"
    )


def _longest_edge(body):
    longest = None
    for edge in body.edges:
        if edge.geometry.objectType != adsk.core.Line3D.classType():
            continue
        if longest is None or edge.length > longest.length:
            longest = edge
    if longest is None:
        raise ValueError("Could not find a straight edge to derive the hex shaft's own axis")
    return longest


def _centerline_point(body, axis_unit):
    """A point known to lie exactly on the shaft's own turning axis.

    _longest_edge's own edge runs along the axis direction but sits on the
    hex's surface (one flat's edge), not its centerline - confirmed live as
    a real bug: using that edge's endpoint as the reference origin offset
    every measured axial position by the hex's own apothem. Any cylindrical
    face's mathematical axis passes through the true centerline by
    definition (confirmed live: every cylindrical face on this body,
    corner-artifact or groove floor alike, reports the identical axis), so
    its own origin point is used instead.
    """
    for face in body.faces:
        if face.geometry.objectType != adsk.core.Cylinder.classType():
            continue
        cylinder = adsk.core.Cylinder.cast(face.geometry)
        if abs(abs(_dot(_vec(cylinder.axis), axis_unit)) - 1.0) > 1.0 - _PARALLEL_TOLERANCE:
            continue
        return _vec(cylinder.origin)
    raise ValueError("Could not find a cylindrical face to anchor the hex shaft's own centerline")


def _hex_flats(body, axis_unit):
    """The 6 large planar faces whose normal is perpendicular to the shaft axis."""
    candidates = [
        face for face in body.faces
        if face.geometry.objectType == adsk.core.Plane.classType()
        and abs(_dot(_vec(face.geometry.normal), axis_unit)) < 1.0 - _PARALLEL_TOLERANCE
    ]
    if len(candidates) < 6:
        raise ValueError(
            "Hex shaft CAM expects 6 flats perpendicular to the shaft axis; found {}".format(len(candidates))
        )
    return candidates


def _across_flats_cm(body, axis_unit):
    flats = _hex_flats(body, axis_unit)
    reference = flats[0]
    ref_normal = _vec(reference.geometry.normal)
    for other in flats[1:]:
        if _dot(ref_normal, _vec(other.geometry.normal)) < -0.99:
            return abs(_dot(_sub(other.geometry.origin, reference.geometry.origin), ref_normal))
    raise ValueError("Could not find the hex's opposite flat to measure across-flats")


def _axial_bounds_cm(body, origin_point, axis_unit):
    """(min, max) projection of every vertex onto the axis through origin_point."""
    projections = [_dot(_sub_v(_vec(v.geometry), origin_point), axis_unit) for v in body.vertices]
    return min(projections), max(projections)


def _groove_instances(body, origin_point, axis_unit, across_flats_cm):
    candidates = []
    for face in body.faces:
        if face.geometry.objectType != adsk.core.Cylinder.classType():
            continue
        cylinder = adsk.core.Cylinder.cast(face.geometry)
        if abs(abs(_dot(_vec(cylinder.axis), axis_unit)) - 1.0) > 1.0 - _PARALLEL_TOLERANCE:
            continue
        radius_cm = cylinder.radius
        if not is_groove_floor_radius(radius_cm, across_flats_cm):
            continue
        low, high = _axial_bounds_cm(face, origin_point, axis_unit)
        candidates.append((low, high, {"face": face, "radius": radius_cm}))
    groups = cluster_groove_faces(candidates)
    instances = []
    for group in groups:
        radii = [item["radius"] for item in group["faces"]]
        instances.append({
            "axialLow": group["axialLow"],
            "axialHigh": group["axialHigh"],
            "radius": sum(radii) / len(radii),
            "faces": [item["face"] for item in group["faces"]],
        })
    return instances


def _wcs_frame(setup):
    """The setup's resolved WCS, as (origin_cm, x_axis, y_axis, z_axis).

    Confirmed live: Setup.workCoordinateSystem.getAsCoordinateSystem() reports
    its origin translation in millimeters for a turning setup, unlike every
    other Fusion geometry API (BRepFace/BRepVertex/BoundingBox, all always
    centimeters) - a consistent, exact 10x factor reproduced across every
    wcs_origin_turning choice and even a raw selected vertex. The axis
    vectors themselves are unaffected (already unit length in either
    interpretation). Divide the origin by 10 before comparing it to any
    measurement taken from body geometry.
    """
    adsk.doEvents()
    origin, x_axis, y_axis, z_axis = setup.workCoordinateSystem.getAsCoordinateSystem()
    origin_cm = tuple(c / 10.0 for c in _vec(origin))
    return origin_cm, _vec(x_axis), _vec(y_axis), _vec(z_axis)


def _sub_v(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _normalize(a):
    length = math.sqrt(_dot(a, a))
    return (a[0] / length, a[1] / length, a[2] / length)


def _build_hex_stock(root, origin_point, axis_unit, flat_normal, across_flats_cm, start_cm, end_cm):
    """A real hex-prism solid body for stock mode 'solid' to reference.

    Spans exactly [start_cm, end_cm] along axis_unit from origin_point - the
    end_cm face is the exposed/tip end for whichever setup this stock is
    built for, and start_cm is the gripped end (with or without extra grip
    allowance baked in by the caller, depending on whether this is the first
    cut from raw stock or a second setup re-chucking an already-parted,
    exact-length blank).

    A true hex prism, not a round envelope: a fresh
    ConstructionPlanes.add(setByPlane(...)) fails live with "Environment is
    not supported" in a freshly created design document - confirmed
    independent of parametric vs. direct design type and of workspace
    activation order - but sketching on an *existing* plane (confirmed live:
    even one of Fusion's own default origin planes, never created by this
    code) does not hit that bug. So the hex cross section is sketched on the
    document's own xZConstructionPlane, extruded into an axis-aligned prism,
    then moved into place with an explicit coordinate-system-align transform
    so its exposed end lands exactly on the shaft's measured tip and its
    flats line up with the real body's own flat orientation (flat_normal),
    not an arbitrary rotation about the axis.
    """
    circumradius_cm = circumscribed_radius_cm(across_flats_cm)
    length_cm = end_cm - start_cm

    sketch = root.sketches.add(root.xZConstructionPlane)
    points = []
    for k in range(6):
        angle = math.pi / 6 + k * math.pi / 3
        points.append(adsk.core.Point3D.create(
            circumradius_cm * math.cos(angle), 0.0, circumradius_cm * math.sin(angle)
        ))
    lines = sketch.sketchCurves.sketchLines
    for i in range(6):
        lines.addByTwoPoints(points[i], points[(i + 1) % 6])
    profile = sketch.profiles.item(0)

    extrude_input = root.features.extrudeFeatures.createInput(
        profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation
    )
    extrude_input.setDistanceExtent(False, adsk.core.ValueInput.createByReal(length_cm))
    stock_body = root.features.extrudeFeatures.add(extrude_input).bodies.item(0)

    # The extrude's own local frame has its exposed (undistanced) end at
    # (0, 0, 0) and extends toward -Z by length_cm - confirmed live - so
    # local origin/+Z aligns to the shaft's measured tip/axis_unit directly.
    tip_point = tuple(origin_point[i] + axis_unit[i] * end_cm for i in range(3))
    target_x = _normalize(_sub_v(flat_normal, tuple(_dot(flat_normal, axis_unit) * c for c in axis_unit)))
    target_y = _cross(axis_unit, target_x)

    matrix = adsk.core.Matrix3D.create()
    matrix.setToAlignCoordinateSystems(
        adsk.core.Point3D.create(0, 0, 0),
        adsk.core.Vector3D.create(1, 0, 0),
        adsk.core.Vector3D.create(0, 1, 0),
        adsk.core.Vector3D.create(0, 0, 1),
        adsk.core.Point3D.create(*tip_point),
        adsk.core.Vector3D.create(*target_x),
        adsk.core.Vector3D.create(*target_y),
        adsk.core.Vector3D.create(*axis_unit),
    )
    move_input = root.features.moveFeatures.createInput(
        adsk.core.ObjectCollection.createWithArray([stock_body]), matrix
    )
    root.features.moveFeatures.add(move_input)
    return stock_body


def _set_minimum_retraction(op):
    """Confirmed live: turning_face defaults to 'full' retraction - every
    linking move between its own surfacing passes clears the *entire* stock
    length, not just the tool's own local working area. For a long bar this
    means every retract rapids the full length of the part and back - real,
    measured, wasted machine time, not a cosmetic simulation quirk.
    'Minimum retraction' only clears what the tool needs to clear locally.

    Each strategy names this parameter differently (confirmed live:
    turning_face uses "retractionPolicy", turning_profile_roughing uses
    "profileRoughingRetractionPolicy" and already defaults to 'minimum'),
    and single-pass strategies (finishing, groove, part) don't expose the
    choice at all - there's only ever the one retract to place. Every known
    name is tried; a missing parameter is a no-op, not an error.
    """
    for name in ("retractionPolicy", "profileRoughingRetractionPolicy"):
        param = op.parameters.itemByName(name)
        if param is not None:
            param.value.value = "minimum"


def _input_with_tool(setup, strategy, tool):
    op_input = setup.operations.createInput(strategy)
    op_input.tool = tool
    return op_input


def _tool_by_type(lib, wanted_type):
    for i in range(lib.count):
        tool = lib.item(i)
        type_param = tool.parameters.itemByName("tool_type")
        if type_param is not None and type_param.value.value == wanted_type:
            return tool
    return None


def _build_hex_end_setup(
    cam, root, body, long_edge, origin_point, axis_unit, across_flats_cm,
    stock_body, generic_tool, groove_tool, setup_name,
):
    """One Face -> Profile Roughing -> Profile Finishing -> Single Groove
    setup for whichever end axis_unit points toward (its own axial
    maximum). Nothing else, and nothing conditional on which setup this
    is - every setup this function builds ends here.

    Direct instruction, after an earlier version of this function added a
    further staged Face-plus-Part sequence to face off and sever the
    carried grip/tailstock excess as the FINAL setup's own last
    operations, and that sequence machined away a real snap-ring groove on
    a real job even with an explicit geometry-clearance check in place:
    "remove that facing operation... dont even cut off the part of the
    stock that makes it fall... IT SHOULD DO ANYTHING BUT THAT LAST FACING
    OPERATION BECAUSE THAT REMOVES THE GROOVES." The grip/tailstock excess
    (see handleHexShaft's own _build_hex_stock calls) now stays attached
    permanently, on every setup this function builds - CAM's own job ends
    once this end's neck and groove are cut; nothing here ever faces off
    or parts the finished shape free of that excess.

    The Face pass at this end's own working tip (WCS Z=0, the model's own
    real end) is a light cleanup cut only: the stock built for it (see
    handleHexShaft's own _TIP_FACE_ALLOWANCE_IN overage) carries a small
    synthetic overage there for exactly that pass to true up. Direct
    instruction: "face the ending side of the side that is not nearest to
    the tailstock" - this end's own tip, by construction, is always the
    side away from wherever the carried excess/tailstock support sits.
    """
    axial_min, axial_max = _axial_bounds_cm(body, origin_point, axis_unit)

    groove_instances = _groove_instances(body, origin_point, axis_unit, across_flats_cm)
    if not groove_instances:
        raise ValueError("Hex shaft CAM found no snap-ring groove on this end")
    # Machine whichever end's groove sits closer to the axial maximum -
    # arbitrary but consistent given axis_unit already points at this end.
    target = max(groove_instances, key=lambda g: g["axialHigh"])
    tip_axial = axial_max
    groove_distance_from_tip_cm = tip_axial - target["axialHigh"]
    groove_width_cm = target["axialHigh"] - target["axialLow"]
    neck_length_cm = tip_axial - target["axialLow"]

    tip_point = tuple(origin_point[i] + axis_unit[i] * axial_max for i in range(3))

    setup_input = cam.setups.createInput(adsk.cam.OperationTypes.TurningOperation)
    setup_input.name = setup_name
    setup = cam.setups.add(setup_input)
    parameters = setup.parameters
    parameters.itemByName("job_model").value.value = [body]
    parameters.itemByName("job_stockMode").value.value = "solid"
    parameters.itemByName("job_stockSolid").value.value = [stock_body]

    parameters.itemByName("wcs_orientation_mode").value.value = "axesZX"
    parameters.itemByName("wcs_orientation_axisZ").value.value = [long_edge]
    flip_z = parameters.itemByName("wcs_orientation_flipZ").value
    _, _got_x, _got_y, got_z = _wcs_frame(setup)
    # WCS +Z must point from the exposed tip into the chuck (matches every
    # other turning setup this codebase builds - see HandleSpacer.py's
    # chuckFront_mode='model back'). The tip is this frame's own axial
    # maximum, so +Z must point toward decreasing axial position here.
    if _dot(got_z, axis_unit) > 0:
        flip_z.value = not flip_z.value

    # Explicit ConstructionPoints.add fails live with the same "Environment
    # is not supported" error setByPlane hit above, independent of workspace
    # or design type. "Model front"/"model back" resolve against the design
    # BODY's own fixed geometry, not the synthetic stock prism - unlike an
    # earlier version of this function (which used "stock front"/"stock
    # back", confirmed live equivalent back when stock's own tip always
    # exactly coincided with the model's), this setup's stock now
    # deliberately extends past the model's own tip on purpose (the tip-
    # facing overage, and on the final setup the carried grip/tailstock
    # excess too) - "model front"/"model back" stay correct regardless of
    # how far the stock itself extends, confirmed live. Which literal label
    # ("front" vs "back") lands on this end's own tip depends on this
    # body's own axis/flip resolution, not something to hardcode - confirmed
    # live, Spacer's own body resolves "front" to its tip while this hex
    # shaft resolves "back" to its tip instead, for the identical intent.
    # Try both and keep whichever matches.
    parameters.itemByName("wcs_origin_turning").value.value = "model front"
    origin, _, _, _ = _wcs_frame(setup)
    offset = _sub_v(origin, tip_point)
    if _dot(offset, offset) > 1e-4:
        parameters.itemByName("wcs_origin_turning").value.value = "model back"
        origin, _, _, _ = _wcs_frame(setup)
        offset = _sub_v(origin, tip_point)
    if _dot(offset, offset) > 1e-4:
        raise RuntimeError(
            "Hex shaft CAM's WCS origin (model front/back) did not resolve to this end's "
            "own measured tip - got {}, expected {}".format(origin, tip_point)
        )

    # Light cleanup pass at this end's own tip (WCS Z=0) - the small
    # _TIP_FACE_ALLOWANCE_IN overage baked into this setup's own stock is
    # the only thing it removes. Explicit "from wcs"/0in rather than
    # Fusion's own "model front" auto-default for frontHeight, which
    # resolves to the model's FAR surface (this setup's own back, where the
    # grip/tailstock excess permanently lives - never faced off, see this
    # function's own docstring).
    face_op = setup.operations.add(_input_with_tool(setup, "turning_face", generic_tool))
    face_op.parameters.itemByName("frontHeight_mode").value.value = "from wcs"
    face_op.parameters.itemByName("frontHeight_offset").expression = "0 in"

    rough_op = setup.operations.add(_input_with_tool(setup, "turning_profile_roughing", generic_tool))
    finish_op = setup.operations.add(_input_with_tool(setup, "turning_profile_finishing", generic_tool))
    for op in (rough_op, finish_op):
        op.parameters.itemByName("frontHeight_mode").value.value = "from wcs"
        op.parameters.itemByName("frontHeight_offset").expression = "0 in"
        op.parameters.itemByName("backHeight_mode").value.value = "from wcs"
        op.parameters.itemByName("backHeight_offset").expression = "{:.6f} in".format(neck_length_cm / _CM_PER_IN)

    groove_op = setup.operations.add(_input_with_tool(setup, "turning_single_groove", groove_tool))
    groove_op.parameters.itemByName("grooves").value.value = [target["faces"][0].edges.item(0)]

    operations = [face_op, rough_op, finish_op, groove_op]

    for op in operations:
        _set_minimum_retraction(op)

    return {
        "setup": setup,
        "grooveDistanceFromEnd": groove_distance_from_tip_cm / _CM_PER_IN,
        "grooveWidth": groove_width_cm / _CM_PER_IN,
        "grooveDiameter": target["radius"] * 2 / _CM_PER_IN,
        "operations": [op.name for op in operations],
    }


def handleHexShaft(tailstock_length_in=None):
    """Create the turning setup(s) that face, neck, and groove a hex shaft.

    A model grooved at only one end gets a single setup. A model grooved at
    both ends (the real, reviewed case) gets two: the first setup machines
    whichever end is closer to the model's own axial maximum; the second
    re-chucks the STILL-JOINED raw bar and machines the other end. Neither
    setup ever faces off or parts off the carried grip/tailstock excess -
    see _build_hex_end_setup's own docstring on why that final step was
    removed. The excess stays attached permanently once CAM is done; a
    human separates the finished part from it afterward, off the machine.

    tailstock_length_in, when given, is the operator's own override for how
    much raw stock is carried on the back (grip/tailstock-support) side
    through every setup - see _DEFAULT_TAILSTOCK_LENGTH_IN for the fallback.

    Returns a dict with the created setup(s), the measured geometry
    (inches), and the tailstock/live-center support length actually used.
    """
    app = adsk.core.Application.get()
    doc = app.activeDocument
    if not doc:
        raise RuntimeError("No active document for hex shaft CAM")
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    if not design:
        raise RuntimeError("Hex shaft CAM requires an active Design product")
    root = design.rootComponent
    body = _find_shaft_body(root)

    long_edge = _longest_edge(body)
    line = adsk.core.Line3D.cast(long_edge.geometry)
    axis_unit = _normalize(_sub_v(_vec(line.endPoint), _vec(line.startPoint)))
    # long_edge only supplies the axis direction and a real edge reference
    # for the WCS Z-axis selection below - its own endpoint sits on the
    # hex's surface, not the centerline (see _centerline_point).
    origin_point = _centerline_point(body, axis_unit)

    across_flats_cm = _across_flats_cm(body, axis_unit)
    axial_min, axial_max = _axial_bounds_cm(body, origin_point, axis_unit)
    model_length_cm = axial_max - axial_min

    groove_instances = _groove_instances(body, origin_point, axis_unit, across_flats_cm)
    groove_count = len(groove_instances)
    if groove_count == 0:
        raise ValueError("Hex shaft CAM found no snap-ring groove on this model")
    if groove_count > 2:
        raise ValueError(
            "Hex shaft CAM expects at most one groove per end (2 total); found {}".format(groove_count)
        )
    two_ended = groove_count == 2

    if not two_ended:
        # axis_unit's own direction comes from _longest_edge's raw STEP
        # start/end point order - arbitrary, not something this model's
        # geometry guarantees points toward the grooved end. Harmless for a
        # two-ended shaft (both directions get their own setup below), but
        # _build_hex_end_setup always treats THIS axis_unit's own
        # axial_max as "the tip" and machines whichever groove sits
        # nearest it - for a one-ended shaft, if the single real groove
        # happened to sit nearer axial_min instead, neck_length_cm would
        # silently span almost the model's ENTIRE length, and Profile
        # Roughing/Finishing would turn the whole hex bar round rather
        # than a short neck, with no error anywhere. Confirmed as a real,
        # untested gap - flip axis_unit here (same reversal two_ended
        # already does unconditionally for its own second setup) whenever
        # the single groove is actually closer to axial_min.
        only_groove = groove_instances[0]
        distance_to_max = axial_max - only_groove["axialHigh"]
        distance_to_min = only_groove["axialLow"] - axial_min
        if distance_to_min < distance_to_max:
            axis_unit = tuple(-c for c in axis_unit)
            axial_min, axial_max = _axial_bounds_cm(body, origin_point, axis_unit)
            groove_instances = _groove_instances(body, origin_point, axis_unit, across_flats_cm)

    flat_normal = _vec(_hex_flats(body, axis_unit)[0].geometry.normal)
    cam = _active_cam_product(app, doc)
    lib = cam.documentToolLibrary
    if lib.count == 0:
        raise RuntimeError("No tool available in this document's tool library for a generic assignment")
    # Fusion validates tool type against operation strategy even for an
    # unconfigured/generic assignment - confirmed live, a groove operation
    # given a plain turning-general tool fails toolpath generation with
    # "Tool (turning general) is not supported for the strategy." A grooving
    # insert is the one tool-type detail that can't wait for later configuration.
    generic_tool = _tool_by_type(lib, "turning general") or lib.item(0)
    groove_tool = _tool_by_type(lib, "turning grooving") or generic_tool

    grip_cm = (
        tailstock_length_in * _CM_PER_IN if tailstock_length_in is not None
        else _DEFAULT_TAILSTOCK_LENGTH_IN * _CM_PER_IN
    )
    if grip_cm < _MIN_TAILSTOCK_LENGTH_IN * _CM_PER_IN:
        raise ValueError(
            "Hex shaft CAM's tailstock/grip length must be at least {:.3f}in for the "
            "chuck to have real material to hold through both setups - got {:.3f}in.".format(
                _MIN_TAILSTOCK_LENGTH_IN, grip_cm / _CM_PER_IN
            )
        )
    tip_allowance_cm = _TIP_FACE_ALLOWANCE_IN * _CM_PER_IN

    # Every setup carries the SAME grip_cm excess on its own back side -
    # not a per-setup allowance, and never faced off or parted by either
    # setup (see _build_hex_end_setup's own docstring). For a two-ended
    # shaft, both setups reference the identical physical material: the
    # raw bar is one continuous piece throughout, just seen from each
    # setup's own re-chucked orientation.
    first_stock = _build_hex_stock(
        root, origin_point, axis_unit, flat_normal, across_flats_cm,
        axial_min - grip_cm, axial_max + tip_allowance_cm,
    )
    first_result = _build_hex_end_setup(
        cam, root, body, long_edge, origin_point, axis_unit, across_flats_cm,
        first_stock, generic_tool, groove_tool,
        setup_name="Hex Shaft" if not two_ended else "Hex Shaft - End 1",
    )

    results = [first_result]
    if two_ended:
        axis_unit_rev = tuple(-c for c in axis_unit)
        axial_min_rev, axial_max_rev = _axial_bounds_cm(body, origin_point, axis_unit_rev)
        second_stock = _build_hex_stock(
            root, origin_point, axis_unit_rev, flat_normal, across_flats_cm,
            axial_min_rev - grip_cm, axial_max_rev + tip_allowance_cm,
        )
        second_result = _build_hex_end_setup(
            cam, root, body, long_edge, origin_point, axis_unit_rev, across_flats_cm,
            second_stock, generic_tool, groove_tool,
            setup_name="Hex Shaft - End 2",
        )
        results.append(second_result)

    return {
        "setups": [r["setup"] for r in results],
        "acrossFlats": across_flats_cm / _CM_PER_IN,
        "shaftLength": model_length_cm / _CM_PER_IN,
        "neckDiameter": neck_radius_cm(across_flats_cm) * 2 / _CM_PER_IN,
        "tailstockLength": grip_cm / _CM_PER_IN,
        "ends": [
            {
                "grooveDistanceFromEnd": r["grooveDistanceFromEnd"],
                "grooveWidth": r["grooveWidth"],
                "grooveDiameter": r["grooveDiameter"],
                "operations": r["operations"],
            }
            for r in results
        ],
    }
