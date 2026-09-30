"""A simplified Haas TL-1 chuck (round body plus three jaws) built as solids
and bound to a turning setup as its fixture, shared by HandleHexShaft.py and
HandleSpacer.py.

No vendor STEP is bundled or available to fetch (Haas's model downloads sit
behind their site, and Fusion's machine library has only Haas mills), so this
is an envelope for collision/clearance display, not a dimensionally
certified TL-1 chuck - see the _CHUCK_*/_JAW_* constants (approximate 8in
manual 3-jaw; measure the real chuck and jaws and adjust).

The chuck is built in its own component, never as root bodies: with chuck
solids in the same component as the stock and model, Fusion folded them into
the stock's radial extent in the kernel job (the jaws' 46mm or the body's
127mm instead of the bar's 7.3mm), so roughing cut air for minutes -
confirmed live, and it happened whether or not they were bound as the
fixture.
"""

import adsk.core
import adsk.fusion
import math

_CM_PER_IN = 2.54
_CHUCK_RADIUS_IN = 4.0
_CHUCK_BODY_LENGTH_IN = 3.0
# A polygon, not a sketch circle: a circle extruded and placed through
# extrude_into_place's transform came out tilted off the shaft axis
# (confirmed live); lines do not.
_CHUCK_SIDES = 48
_JAW_LENGTH_IN = 1.0
_JAW_WIDTH_IN = 1.0
_JAW_RADIAL_THICKNESS_IN = 1.5
_MODEL_CLEARANCE_IN = 0.1


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _normalize(a):
    length = math.sqrt(_dot(a, a))
    return (a[0] / length, a[1] / length, a[2] / length)


def jaw_length_cm(available_cm):
    """Jaw grip length along the bar, kept _MODEL_CLEARANCE_IN clear of the
    finished model when only available_cm of excess is carried behind it."""
    return min(_JAW_LENGTH_IN * _CM_PER_IN, available_cm - _MODEL_CLEARANCE_IN * _CM_PER_IN)


def extrude_into_place(root, draw, origin_point, axis_unit, x_reference, start_cm, end_cm):
    """Sketch a cross section (via draw(sketchLines), in the axis's own local
    frame: local +X is x_reference projected perpendicular to the axis),
    extrude it to span [start_cm, end_cm] along axis_unit from origin_point,
    and return the placed body.

    A fresh ConstructionPlanes.add(setByPlane(...)) fails live with
    "Environment is not supported" in a freshly created design document -
    confirmed independent of parametric vs. direct design type and of
    workspace activation order - but sketching on an *existing* plane
    (confirmed live: even one of Fusion's own default origin planes) does not
    hit that bug. So the cross section is sketched on the component's own
    xZConstructionPlane, extruded into an axis-aligned prism, then moved into
    place with an explicit coordinate-system-align transform.
    """
    length_cm = end_cm - start_cm

    sketch = root.sketches.add(root.xZConstructionPlane)
    draw(sketch.sketchCurves.sketchLines)
    profile = sketch.profiles.item(0)

    extrude_input = root.features.extrudeFeatures.createInput(
        profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation
    )
    extrude_input.setDistanceExtent(False, adsk.core.ValueInput.createByReal(length_cm))
    body = root.features.extrudeFeatures.add(extrude_input).bodies.item(0)

    # The extrude's own local frame has its exposed (undistanced) end at
    # (0, 0, 0) and extends toward -Z by length_cm - confirmed live - so
    # local origin/+Z aligns to end_cm along axis_unit directly.
    end_point = tuple(origin_point[i] + axis_unit[i] * end_cm for i in range(3))
    target_x = _normalize(_sub(x_reference, tuple(_dot(x_reference, axis_unit) * c for c in axis_unit)))
    target_y = _cross(axis_unit, target_x)

    matrix = adsk.core.Matrix3D.create()
    matrix.setToAlignCoordinateSystems(
        adsk.core.Point3D.create(0, 0, 0),
        adsk.core.Vector3D.create(1, 0, 0),
        adsk.core.Vector3D.create(0, 1, 0),
        adsk.core.Vector3D.create(0, 0, 1),
        adsk.core.Point3D.create(*end_point),
        adsk.core.Vector3D.create(*target_x),
        adsk.core.Vector3D.create(*target_y),
        adsk.core.Vector3D.create(*axis_unit),
    )
    move_input = root.features.moveFeatures.createInput(
        adsk.core.ObjectCollection.createWithArray([body]), matrix
    )
    root.features.moveFeatures.add(move_input)
    return body


def build_chuck(root, origin_point, axis_unit, x_reference, seat_radius_cm, jaw_front_cm, jaw_cm):
    """The chuck as a list of fixture bodies: three jaws seated on a bar of
    seat_radius_cm at 120 degree spacing (local +X first), spanning
    [jaw_front_cm - jaw_cm, jaw_front_cm] along the axis, and the round body
    directly behind them.
    """
    occurrence = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    component = occurrence.component
    component.name = "Chuck"

    half_width_cm = _JAW_WIDTH_IN * _CM_PER_IN / 2.0
    jaw_top_cm = seat_radius_cm + _JAW_RADIAL_THICKNESS_IN * _CM_PER_IN
    jaw_back_cm = jaw_front_cm - jaw_cm

    def draw_body(lines):
        radius_cm = _CHUCK_RADIUS_IN * _CM_PER_IN
        points = [
            adsk.core.Point3D.create(
                radius_cm * math.cos(2.0 * math.pi * k / _CHUCK_SIDES), 0.0,
                radius_cm * math.sin(2.0 * math.pi * k / _CHUCK_SIDES),
            )
            for k in range(_CHUCK_SIDES)
        ]
        for i in range(_CHUCK_SIDES):
            lines.addByTwoPoints(points[i], points[(i + 1) % _CHUCK_SIDES])

    extrude_into_place(
        component, draw_body, origin_point, axis_unit, x_reference,
        jaw_back_cm - _CHUCK_BODY_LENGTH_IN * _CM_PER_IN, jaw_back_cm,
    )

    for k in range(3):
        angle = k * 2.0 * math.pi / 3.0
        radial = (math.cos(angle), math.sin(angle))
        tangent = (-radial[1], radial[0])

        def draw_jaw(lines, radial=radial, tangent=tangent):
            corners = [
                (seat_radius_cm, -half_width_cm), (jaw_top_cm, -half_width_cm),
                (jaw_top_cm, half_width_cm), (seat_radius_cm, half_width_cm),
            ]
            points = [
                adsk.core.Point3D.create(
                    r * radial[0] + t * tangent[0], 0.0, r * radial[1] + t * tangent[1]
                )
                for r, t in corners
            ]
            for i in range(4):
                lines.addByTwoPoints(points[i], points[(i + 1) % 4])

        extrude_into_place(component, draw_jaw, origin_point, axis_unit, x_reference, jaw_back_cm, jaw_front_cm)

    return [occurrence.bRepBodies.item(i) for i in range(occurrence.bRepBodies.count)]


def attach_chuck(root, setup, origin_point, axis_unit, x_reference, seat_radius_cm, jaw_front_cm, jaw_cm):
    setup.parameters.itemByName("job_fixture").value.value = build_chuck(
        root, origin_point, axis_unit, x_reference, seat_radius_cm, jaw_front_cm, jaw_cm
    )


def attach_chuck_at_chuck_front(root, setup, seat_radius_cm, jaw_cm):
    """Attach a chuck whose jaw tips sit on the setup's own chuck-front plane
    (Fusion's chuckFront_value, along the WCS Z axis), for
    setups whose stock and grip Fusion already defines (the Spacer template).

    Units (confirmed live): a turning setup's WCS origin reads in
    millimeters (see HandleHexShaft._wcs_frame), but chuckFront_value's own
    .value is already centimeters, like every other geometry value.
    """
    adsk.doEvents()
    origin, x_axis, _y_axis, z_axis = setup.workCoordinateSystem.getAsCoordinateSystem()
    origin_cm = (origin.x / 10.0, origin.y / 10.0, origin.z / 10.0)
    jaw_front_cm = setup.parameters.itemByName("chuckFront_value").value.value
    attach_chuck(
        root, setup, origin_cm, (z_axis.x, z_axis.y, z_axis.z), (x_axis.x, x_axis.y, x_axis.z),
        seat_radius_cm, jaw_front_cm, jaw_cm,
    )
