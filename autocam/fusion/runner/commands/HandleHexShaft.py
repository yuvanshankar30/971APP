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
length raw stock, faces/necks/grooves the first end, then re-chucks to
expose and machine the second end. The raw excess stays attached through
both setups (it is what the chuck grips), and only the LAST setup ends with
a Part (cutoff) operation, after every groove is already cut, to sever the
finished part from that excess. An earlier version instead faced the excess
off with a staged Face-plus-Part sequence and machined away a real snap-ring
groove; the Face there is gone for good - the only cut at the far end now is
the single part-off at the finished part's own back end (see
_PART_OFF_ALLOWANCE_IN), never a facing pass.
"""

import adsk.core
import adsk.fusion
import adsk.cam
import math
import time

from .ChuckFixture import attach_chuck, extrude_into_place, jaw_length_cm
from .StockMath import check_hex_across_flats, resolve_grip_cm
from .HexShaftMath import (
    circumscribed_radius_cm,
    cluster_groove_faces,
    is_groove_floor_radius,
    is_journal_radius,
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
# Haas TL-1 cutting data. Fusion's bundled sample tools ship with a 5000 rpm
# cap, 656 SFM and 0.039 ipr feeds (fine for a large CNC lathe, not for a
# TL-1 turning a 0.5in hex bar). Feeds are the team's reviewed Spacer
# Turning template values (0.005 rough / 0.003 finish / 0.002 groove ipr); SFM
# matches autocam/inprocess/turning.js's own default for the same machine.
_TL1_MAX_SPINDLE_RPM = 2000
_SURFACE_SPEED_SFM = 150
_FEED_IPR = {
    "turning_face": 0.003,
    "turning_profile_roughing": 0.005,
    "turning_profile_finishing": 0.003,
    "turning_single_groove": 0.002,
    "turning_part": 0.002,
}
# How far past the finished part's back end the part-off cut lands, into the
# carried excess: the parted-off part is left this much long (face it
# afterward) instead of the blade sitting exactly on the part's own end,
# where a cut placed a hair short would sever into the groove end lip.
_PART_OFF_ALLOWANCE_IN = 0.01
# The turret needs real, distinct tool numbers: the post writes T<number*100 +
# offset>, and the sample library's tools are both number 0 (an invalid T0,
# and no tool change between the turning insert and the grooving insert).
_GENERAL_TOOL_NUMBER = 1
_GROOVE_TOOL_NUMBER = 2
# Approach/retract plane ahead of the finished tip. Fusion's default puts
# safe Z exactly on the WCS origin (the tip), which sits inside the raw
# stock's own tip-facing overage.
_SAFE_Z_CLEARANCE_IN = 0.1
# What each end of the shaft has: a snap-ring groove (a hex shaft) or a
# plain round journal turned to the hex's inscribed diameter (an internal
# shaft). Either way the end is faced, then neck-turned from the tip to where
# the hex begins; only the groove type then cuts a groove.
END_FEATURE_GROOVE = "groove"
END_FEATURE_JOURNAL = "journal"
# An internal shaft has no groove to size a tool from, and the last setup
# still parts off, so the grooving insert is sized as a 2mm parting blade.
_PART_OFF_BLADE_IN = 0.0787

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
    return _axial_cylinder_instances(body, origin_point, axis_unit, across_flats_cm, is_groove_floor_radius)


def _journal_instances(body, origin_point, axis_unit, across_flats_cm):
    return _axial_cylinder_instances(body, origin_point, axis_unit, across_flats_cm, is_journal_radius)


def _end_feature_instances(body, origin_point, axis_unit, across_flats_cm, end_feature):
    finder = _groove_instances if end_feature == END_FEATURE_GROOVE else _journal_instances
    return finder(body, origin_point, axis_unit, across_flats_cm)


def _axial_cylinder_instances(body, origin_point, axis_unit, across_flats_cm, keep_radius):
    candidates = []
    for face in body.faces:
        if face.geometry.objectType != adsk.core.Cylinder.classType():
            continue
        cylinder = adsk.core.Cylinder.cast(face.geometry)
        if abs(abs(_dot(_vec(cylinder.axis), axis_unit)) - 1.0) > 1.0 - _PARALLEL_TOLERANCE:
            continue
        radius_cm = cylinder.radius
        if not keep_radius(radius_cm, across_flats_cm):
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

    def draw_hex(lines):
        points = []
        for k in range(6):
            angle = math.pi / 6 + k * math.pi / 3
            points.append(adsk.core.Point3D.create(
                circumradius_cm * math.cos(angle), 0.0, circumradius_cm * math.sin(angle)
            ))
        for i in range(6):
            lines.addByTwoPoints(points[i], points[(i + 1) % 6])

    return extrude_into_place(root, draw_hex, origin_point, axis_unit, flat_normal, start_cm, end_cm)


def _attach_hex_chuck(root, setup, origin_point, axis_unit, flat_normal, across_flats_cm, stock_back_cm, grip_cm):
    """Jaws seated flat against alternate hex flats over the carried excess,
    the bar end flush with the chuck face. The chuck is added only after
    every setup's WCS has resolved (see handleHexShaft)."""
    jaw_cm = jaw_length_cm(grip_cm)
    attach_chuck(
        root, setup, origin_point, axis_unit, flat_normal,
        neck_radius_cm(across_flats_cm), stock_back_cm + jaw_cm, jaw_cm,
    )
    parameters = setup.parameters
    # Fusion's chuck-front plane is where the jaw tips end, i.e. jaw_cm
    # forward of the bar's back end (the stock's own "back").
    parameters.itemByName("chuckFront_mode").value.value = "stock back"
    parameters.itemByName("chuckFront_offset").expression = "{:.6f} in".format(jaw_cm / _CM_PER_IN)


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


def tool_by_type(lib, wanted_type, description_hint=None):
    """First tool of wanted_type, preferring one whose description contains
    description_hint. The bundled sample library lists 'CNMT Left Hand' ahead
    of 'CNMT Right Hand'; a left-hand insert turning toward the chuck is
    mirrored against the cut (odd Z tip reference, a sloped neck path and a
    gouge highlight in Fusion's simulation), so the general tool is looked up
    with the hint "Right Hand".
    """
    fallback = None
    for i in range(lib.count):
        tool = lib.item(i)
        type_param = tool.parameters.itemByName("tool_type")
        if type_param is None or type_param.value.value != wanted_type:
            continue
        if description_hint is None:
            return tool
        description = tool.parameters.itemByName("tool_description")
        if description is not None and description_hint in description.value.value:
            return tool
        if fallback is None:
            fallback = tool
    return fallback


def _library_tool_with(lib, source, expressions):
    """A copy of `source` with the given parameter expressions applied, added
    to the document library and returned as that library's own entry.

    Confirmed live: editing a library tool object in place does not carry
    into an operation created from it (the operation kept tool number 0); an
    operation only picks up the values of an entry that was added to the
    library with them already set.
    """
    tool = adsk.cam.Tool.createFromJson(source.toJson())
    for name, expression in expressions.items():
        tool.parameters.itemByName(name).expression = expression
    if not lib.add(tool):
        raise RuntimeError("Fusion refused to add the configured turning tool to the document library")
    return lib.item(lib.count - 1)


def _configure_tools(lib, generic_tool, groove_tool, groove_width_cm):
    """Give each tool a real turret number and size the groove insert to the
    model's own groove.

    The sample OD Grooving insert is 0.125in wide; the snap-ring groove is
    ~0.039in. A single-groove operation cuts at least the insert's own
    width, so leaving the default would machine a groove ~3x too wide
    (through the end lip) instead of the modeled one.
    """
    width_expression = "{:.4f} in".format(groove_width_cm / _CM_PER_IN)
    configured_general = _library_tool_with(lib, generic_tool, {"tool_number": str(_GENERAL_TOOL_NUMBER)})
    configured_groove = _library_tool_with(lib, groove_tool, {
        "tool_number": str(_GROOVE_TOOL_NUMBER),
        "tool_insertWidth": width_expression,
        "tool_grooveWidth": width_expression,
    })
    return configured_general, configured_groove


def _apply_cutting_data(op, strategy):
    for name, expression in (
        ("tool_surfaceSpeed", "{} in/min".format(_SURFACE_SPEED_SFM * 12)),
        ("tool_maximumSpindleSpeed", "{} rpm".format(_TL1_MAX_SPINDLE_RPM)),
        ("tool_feedCuttingRel", "{} in".format(_FEED_IPR[strategy])),
        ("tool_feedEntryRel", "{} in".format(_FEED_IPR[strategy])),
        ("tool_feedExitRel", "{} in".format(_FEED_IPR[strategy])),
    ):
        op.parameters.itemByName(name).expression = expression


def _set_safe_z(op):
    op.parameters.itemByName("overrideSafeZ").value.value = True
    op.parameters.itemByName("safeZ_mode").value.value = "from wcs"
    op.parameters.itemByName("safeZ_offset").expression = "{} in".format(_SAFE_Z_CLEARANCE_IN)


_END_FEATURE_NAMES = {END_FEATURE_GROOVE: "snap-ring groove", END_FEATURE_JOURNAL: "turned round end"}
_SETUP_LABELS = {END_FEATURE_GROOVE: "Hex Shaft", END_FEATURE_JOURNAL: "Internal Shaft"}


def _build_hex_end_setup(
    cam, root, body, long_edge, origin_point, axis_unit, across_flats_cm,
    stock_body, generic_tool, groove_tool, setup_name, part_off=False,
    end_feature=END_FEATURE_GROOVE,
):
    """One Face -> Profile Roughing -> Profile Finishing -> Single Groove
    setup for whichever end axis_unit points toward (its own axial
    maximum), followed by a Part (cutoff) operation only when part_off is
    set - the last setup, so every groove is already cut when the finished
    part is severed from the carried grip/tailstock excess.

    Never a Face on the excess: an earlier version faced it off with a
    staged Face-plus-Part sequence and machined away a real snap-ring
    groove ("IT SHOULD DO ANYTHING BUT THAT LAST FACING OPERATION BECAUSE
    THAT REMOVES THE GROOVES"). The part-off here is one cut at the
    finished part's own back end, offset _PART_OFF_ALLOWANCE_IN into the
    excess.

    The Face pass at this end's own working tip (WCS Z=0, the model's own
    real end) is a light cleanup cut only: the stock built for it (see
    handleHexShaft's own _TIP_FACE_ALLOWANCE_IN overage) carries a small
    synthetic overage there for exactly that pass to true up. Direct
    instruction: "face the ending side of the side that is not nearest to
    the tailstock" - this end's own tip, by construction, is always the
    side away from wherever the carried excess/tailstock support sits.
    """
    axial_min, axial_max = _axial_bounds_cm(body, origin_point, axis_unit)

    end_instances = _end_feature_instances(body, origin_point, axis_unit, across_flats_cm, end_feature)
    if not end_instances:
        raise ValueError("Shaft CAM found no {} on this end".format(_END_FEATURE_NAMES[end_feature]))
    # Machine whichever end's groove/journal sits closer to the axial maximum
    # - arbitrary but consistent given axis_unit already points at this end.
    target = max(end_instances, key=lambda g: g["axialHigh"])
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
    # Lathe convention (Fusion's own default turning WCS, the Haas post, and
    # autocam/inprocess/turning.js): +Z points from the part OUT of the
    # exposed tip, away from the chuck, so the part lies at negative Z and
    # "front" is the highest-Z end. This frame's tip is its own axial
    # maximum, so +Z must point toward increasing axial position. An
    # earlier version pointed +Z into the chuck: the origin then only landed
    # on the tip as "model back" (which is why it had to guess front vs
    # back), Fusion placed the chuck at the tip being machined, and the
    # posted Z coordinates were mirrored relative to the machine's own axis.
    if _dot(got_z, axis_unit) < 0:
        flip_z.value = not flip_z.value

    # Explicit ConstructionPoints.add fails live with the same "Environment
    # is not supported" error setByPlane hit above, independent of workspace
    # or design type. "Model front" resolves against the design BODY's own
    # fixed geometry, not the synthetic stock prism, so it stays on the
    # finished tip regardless of how far the stock extends past it (the
    # tip-facing overage, and the carried grip/tailstock excess).
    parameters.itemByName("wcs_origin_turning").value.value = "model front"
    origin, _, _, final_z = _wcs_frame(setup)
    offset = _sub_v(origin, tip_point)
    if _dot(offset, offset) > 1e-4 or _dot(final_z, axis_unit) < 0.99:
        raise RuntimeError(
            "Hex shaft CAM's WCS did not resolve to this end's own measured tip with +Z "
            "pointing out of it - got origin {} Z {}, expected origin {} Z {}".format(
                origin, final_z, tip_point, axis_unit
            )
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
        # The part lies at negative Z (see the WCS comment above).
        op.parameters.itemByName("backHeight_offset").expression = "{:.6f} in".format(-neck_length_cm / _CM_PER_IN)
        if end_feature == END_FEATURE_GROOVE:
            # The single-groove operation below owns the groove; without this
            # the general turning insert tries to follow the ~0.04in groove
            # profile too and Fusion warns of a lead-out gouge against the stock.
            op.parameters.itemByName("useGrooveSuppression").value.value = True
            op.parameters.itemByName("grooveSuppressionSelection").value.value = target["faces"]

    operations = [face_op, rough_op, finish_op]
    strategies = ["turning_face", "turning_profile_roughing", "turning_profile_finishing"]
    if end_feature == END_FEATURE_GROOVE:
        groove_op = setup.operations.add(_input_with_tool(setup, "turning_single_groove", groove_tool))
        groove_op.parameters.itemByName("grooves").value.value = [target["faces"][0].edges.item(0)]
        operations.append(groove_op)
        strategies.append("turning_single_groove")

    if part_off:
        # Confirmed live: turning_part rejects a plain "turning general" tool,
        # so it takes the grooving insert. Fusion's own default puts the cut
        # at "model back" - the far end of the finished part, so this severs
        # the carried grip excess there, after every groove is already cut.
        part_op = setup.operations.add(_input_with_tool(setup, "turning_part", groove_tool))
        part_op.parameters.itemByName("backHeight_offset").expression = "{} in".format(-_PART_OFF_ALLOWANCE_IN)
        operations.append(part_op)
        strategies.append("turning_part")

    for op, strategy in zip(operations, strategies):
        _set_minimum_retraction(op)
        _apply_cutting_data(op, strategy)
        _set_safe_z(op)

    if end_feature == END_FEATURE_JOURNAL:
        return {
            "setup": setup,
            "journalLength": neck_length_cm / _CM_PER_IN,
            "journalDiameter": target["radius"] * 2 / _CM_PER_IN,
            "operations": [op.name for op in operations],
        }
    return {
        "setup": setup,
        "grooveDistanceFromEnd": groove_distance_from_tip_cm / _CM_PER_IN,
        "grooveWidth": groove_width_cm / _CM_PER_IN,
        "grooveDiameter": target["radius"] * 2 / _CM_PER_IN,
        "operations": [op.name for op in operations],
    }


def build_shaft_setups(tailstock_length_in, stock, end_feature):
    """Create the turning setup(s) that face, neck, and (for a groove-type
    shaft) groove a hex shaft. The shared core of handleHexShaft and
    HandleInternalShaft.handleInternalShaft.

    A model grooved at only one end gets a single setup. A model grooved at
    both ends (the real, reviewed case) gets two: the first setup machines
    whichever end is closer to the model's own axial maximum; the second
    re-chucks the STILL-JOINED raw bar and machines the other end. Only the
    last setup ends with a Part operation that severs the finished part from
    the carried grip/tailstock excess, after every groove is cut.

    tailstock_length_in, when given, is the operator's own override for how
    much raw stock is carried on the back (grip/tailstock-support) side
    through every setup - see _DEFAULT_TAILSTOCK_LENGTH_IN for the fallback.
    ``stock`` (optional, inches: ``length_in`` bar length, ``across_flats_in``)
    is the operator's queue-time bar: a set bar length defines that carried
    excess instead, and a set across-flats must match the part.

    end_feature picks what each end has: END_FEATURE_GROOVE (a snap-ring
    groove) or END_FEATURE_JOURNAL (a round end turned to the hex's inscribed
    diameter, no groove - see HandleInternalShaft.py).

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

    end_instances = _end_feature_instances(body, origin_point, axis_unit, across_flats_cm, end_feature)
    end_count = len(end_instances)
    if end_count == 0:
        raise ValueError("Shaft CAM found no {} on this model".format(_END_FEATURE_NAMES[end_feature]))
    if end_count > 2:
        raise ValueError(
            "Shaft CAM expects at most one {} per end (2 total); found {}".format(
                _END_FEATURE_NAMES[end_feature], end_count
            )
        )
    two_ended = end_count == 2

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
        only_end = end_instances[0]
        distance_to_max = axial_max - only_end["axialHigh"]
        distance_to_min = only_end["axialLow"] - axial_min
        if distance_to_min < distance_to_max:
            axis_unit = tuple(-c for c in axis_unit)
            axial_min, axial_max = _axial_bounds_cm(body, origin_point, axis_unit)
            end_instances = _end_feature_instances(body, origin_point, axis_unit, across_flats_cm, end_feature)

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
    generic_tool = tool_by_type(lib, "turning general", "Right Hand") or lib.item(0)
    groove_tool = tool_by_type(lib, "turning grooving") or generic_tool
    if end_feature == END_FEATURE_GROOVE:
        insert_width_cm = min(g["axialHigh"] - g["axialLow"] for g in end_instances)
    else:
        insert_width_cm = _PART_OFF_BLADE_IN * _CM_PER_IN
    generic_tool, groove_tool = _configure_tools(lib, generic_tool, groove_tool, insert_width_cm)

    stock_input = stock or {}

    def _cm_or_none(value):
        return None if value is None else float(value) * _CM_PER_IN

    check_hex_across_flats(across_flats_cm, _cm_or_none(stock_input.get("across_flats_in")))
    # The bar's own length or the tailstock length sets how much raw material
    # is carried behind the part through both setups (see StockMath.resolve_grip_cm).
    grip_cm = resolve_grip_cm(
        model_length_cm,
        _TIP_FACE_ALLOWANCE_IN * _CM_PER_IN,
        _cm_or_none(stock_input.get("length_in")),
        _cm_or_none(tailstock_length_in),
        _DEFAULT_TAILSTOCK_LENGTH_IN * _CM_PER_IN,
        _MIN_TAILSTOCK_LENGTH_IN * _CM_PER_IN,
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
        setup_name=_SETUP_LABELS[end_feature] if not two_ended else _SETUP_LABELS[end_feature] + " - End 1",
        part_off=not two_ended, end_feature=end_feature,
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
            setup_name=_SETUP_LABELS[end_feature] + " - End 2", part_off=True, end_feature=end_feature,
        )
        results.append(second_result)

    # Chucks are added only after every setup's WCS has resolved: with chuck
    # bodies already in the document, Fusion re-resolved the next setup's WCS
    # Z axis to a wrong, non-axial direction (confirmed live).
    _attach_hex_chuck(
        root, first_result["setup"], origin_point, axis_unit, flat_normal, across_flats_cm,
        axial_min - grip_cm, grip_cm,
    )
    if two_ended:
        _attach_hex_chuck(
            root, second_result["setup"], origin_point, axis_unit_rev, flat_normal, across_flats_cm,
            axial_min_rev - grip_cm, grip_cm,
        )

    return {
        "setups": [r["setup"] for r in results],
        "acrossFlats": across_flats_cm / _CM_PER_IN,
        "shaftLength": model_length_cm / _CM_PER_IN,
        "neckDiameter": neck_radius_cm(across_flats_cm) * 2 / _CM_PER_IN,
        "tailstockLength": grip_cm / _CM_PER_IN,
        # Per-end measurements: the groove fields for a hex shaft, the journal
        # fields for an internal shaft, plus the operations created.
        "ends": [{key: value for key, value in r.items() if key != "setup"} for r in results],
    }


def handleHexShaft(tailstock_length_in=None, stock=None):
    """A hex shaft with a snap-ring groove at each end. See build_shaft_setups."""
    return build_shaft_setups(tailstock_length_in, stock, END_FEATURE_GROOVE)
