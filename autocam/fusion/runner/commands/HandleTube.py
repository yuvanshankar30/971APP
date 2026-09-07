"""Build four independent Fusion setups for a rectangular box tube.

The router has no rotary axis. Each exterior wall is a separate, manually
indexed fixture setup and is posted as its own NC program. Do not turn this
into one setup with four face selections: the operator turns the tube between
programs and re-zeros Z for the newly exposed wall.
"""

import adsk.core
import adsk.fusion
import adsk.cam

from .ContourChains import is_reverted_for_loop_seed
from .TubeFacePrograms import TUBE_FACE_CLOCKS, tube_face_program_name, tube_face_setup_name


_PARALLEL_TOLERANCE = 0.985
_CIRCULAR_HOLE_SPLIT_CM = 0.3 * 2.54
_SLOT_ASPECT_RATIO = 2.5


def _normalized(vector):
    value = adsk.core.Vector3D.create(vector.x, vector.y, vector.z)
    value.normalize()
    return value


def _linear_edges(face):
    return [edge for edge in face.edges if edge.geometry.objectType == adsk.core.Line3D.classType()]


def _edge_vector(edge):
    line = adsk.core.Line3D.cast(edge.geometry)
    return _normalized(line.startPoint.vectorTo(line.endPoint))


def _edge_length(edge):
    line = adsk.core.Line3D.cast(edge.geometry)
    return line.startPoint.distanceTo(line.endPoint)


def _face_normal(face):
    return _normalized(face.geometry.normal)


def _long_axis(body):
    """Find the tube's longitudinal direction without assuming 1x2 stock."""
    longest = None
    for face in body.faces:
        if face.geometry.objectType != adsk.core.Plane.classType():
            continue
        for edge in _linear_edges(face):
            if longest is None or _edge_length(edge) > _edge_length(longest):
                longest = edge
    if longest is None:
        raise ValueError("Could not find a straight longitudinal edge on the box tube")
    return _edge_vector(longest)


def _wall_face_families(body, axis):
    """Return the two pairs of exterior walls, excluding inner tube faces."""
    candidates = []
    for face in body.faces:
        if face.geometry.objectType != adsk.core.Plane.classType():
            continue
        normal = _face_normal(face)
        if abs(normal.dotProduct(axis)) > 1.0 - _PARALLEL_TOLERANCE:
            continue  # end cap
        if any(abs(_edge_vector(edge).dotProduct(axis)) >= _PARALLEL_TOLERANCE for edge in _linear_edges(face)):
            candidates.append(face)

    families = []
    for face in candidates:
        normal = _face_normal(face)
        for family in families:
            if abs(normal.dotProduct(_face_normal(family[0]))) >= _PARALLEL_TOLERANCE:
                family.append(face)
                break
        else:
            families.append([face])
    if len(families) != 2:
        raise ValueError("Expected two perpendicular wall-normal families; found {}".format(len(families)))

    exterior_pairs = []
    origin = adsk.core.Point3D.create()
    for family in families:
        direction = _face_normal(family[0])
        # Inner walls live between the two exterior-wall projections. Pick
        # the extrema, which works for every rectangular cross-section.
        ordered = sorted(
            family,
            key=lambda face: origin.vectorTo(face.centroid).dotProduct(direction),
        )
        if len(ordered) < 2:
            raise ValueError("Could not find both exterior walls for one tube dimension")
        exterior_pairs.append((ordered[0], ordered[-1]))
    return exterior_pairs


def _ordered_wall_faces(body):
    axis = _long_axis(body)
    pair_a, pair_b = _wall_face_families(body, axis)
    # These are fixture order labels, not claims about a STEP model's
    # arbitrary global orientation. The operator labels the real tube 12/3/6/9
    # to match the four emitted files before machining it.
    return list(zip(TUBE_FACE_CLOCKS, (pair_a[1], pair_b[1], pair_a[0], pair_b[0])))


def _axes_for_face(face, tube_axis, horizontal):
    edges = _linear_edges(face)
    long_edges = [edge for edge in edges if abs(_edge_vector(edge).dotProduct(tube_axis)) >= _PARALLEL_TOLERANCE]
    if not long_edges:
        raise ValueError("Tube wall has no usable longitudinal reference edge")
    long_edge = max(long_edges, key=_edge_length)
    transverse_edges = [
        edge for edge in edges
        if abs(_edge_vector(edge).dotProduct(_edge_vector(long_edge))) < 1.0 - _PARALLEL_TOLERANCE
    ]
    if not transverse_edges:
        raise ValueError("Tube wall has no usable transverse reference edge")
    transverse_edge = max(transverse_edges, key=_edge_length)
    return (long_edge, transverse_edge) if horizontal else (transverse_edge, long_edge)


def _loop_specs(face):
    specs = []
    for loop in face.loops:
        if loop.isOuter:
            continue
        coedges = list(loop.coEdges)
        edges = [coedge.edge for coedge in coedges]
        if not edges:
            continue
        circular = len(edges) == 1 and isinstance(edges[0].geometry, adsk.core.Circle3D)
        diameter = edges[0].geometry.radius * 2 if circular else 0.0
        boxes = [edge.boundingBox for edge in edges]
        spans = [
            max(box.maxPoint.asArray()[axis] for box in boxes) - min(box.minPoint.asArray()[axis] for box in boxes)
            for axis in range(3)
        ]
        planar_spans = sorted((span for span in spans if span > 1e-6), reverse=True)
        aspect = planar_spans[0] / planar_spans[1] if len(planar_spans) >= 2 else 0.0
        specs.append({
            "edges": edges,
            "is_reverted": is_reverted_for_loop_seed(coedges[0].isOpposedToEdge),
            "circular": circular,
            "diameter": diameter,
            "slot": not circular and aspect >= _SLOT_ASPECT_RATIO,
        })
    return specs


def _apply_chains(operation, parameter_name, specs):
    parameter = operation.parameters.itemByName(parameter_name)
    if parameter is None or not hasattr(parameter.value, "getCurveSelections"):
        return False
    selections = parameter.value.getCurveSelections()
    selections.clear()
    for spec in specs:
        selection = selections.createNewChainSelection()
        selection.isOpen = False
        selection.isReverted = spec["is_reverted"]
        selection.inputGeometry = spec["edges"]
    parameter.applyCurveSelections(selections)
    return bool(specs)


def _apply_circular_faces(operation, face):
    parameter = operation.parameters.itemByName("circularFaces")
    if parameter is None:
        return False
    try:
        parameter.value.value = [face]
        return True
    except Exception:
        return False


def _configure_face_operations(setup, face):
    """Rebind every kept template operation to loops on this wall only."""
    loops = _loop_specs(face)
    small_circles = [loop for loop in loops if loop["circular"] and loop["diameter"] < _CIRCULAR_HOLE_SPLIT_CM]
    large_circles = [loop for loop in loops if loop["circular"] and loop["diameter"] >= _CIRCULAR_HOLE_SPLIT_CM]
    slots = [loop for loop in loops if loop["slot"]]
    shapes = [loop for loop in loops if not loop["circular"] and not loop["slot"]]
    have_shape_roughing = False

    for operation in list(setup.operations):
        name = str(operation.name or "").lower()
        keep = False
        if "tube cutoff" in name:
            # Finished-length/cutoff data is not in the Fusion box-tube
            # payload yet. Never inherit the template author's old cutoff.
            # The reviewed template keeps this operation ready for the
            # future payload; it is not replaced with a plate contour.
            keep = False
        elif operation.strategy == "bore" or "drill" in name:
            keep = bool(small_circles) and _apply_circular_faces(operation, face)
        elif "circular" in name and "hole" in name:
            keep = _apply_chains(operation, "pockets", large_circles)
        elif "shape" in name and "through" in name and operation.strategy in ("adaptive2d", "pocket2d"):
            # The current template has regular and Small roughing siblings.
            # Do not cut every profile twice: use the first applicable one.
            keep = bool(shapes) and not have_shape_roughing and _apply_chains(operation, "pockets", shapes)
            have_shape_roughing = have_shape_roughing or keep
        elif "shape" in name and operation.strategy == "contour2d":
            keep = _apply_chains(operation, "contours", shapes)
        elif "slot" in name and operation.strategy == "contour2d":
            keep = _apply_chains(operation, "contours", slots)
        if not keep:
            operation.deleteMe()


def _make_setup(cam, body, face, clock, tube_axis, horizontal, template):
    setup_input = cam.setups.createInput(0)
    setup_input.name = tube_face_setup_name(clock)
    setup = cam.setups.add(setup_input)
    setup.stockMode = adsk.cam.SetupStockModes.RelativeBoxStock
    setup.parameters.itemByName("job_stockOffsetMode").expression = "'all'"
    setup.parameters.itemByName("job_stockOffsetSides").expression = "0 mm"
    setup.parameters.itemByName("job_stockOffsetTop").expression = "0 mm"
    setup.parameters.itemByName("job_model").value.value = [body]

    axis_x, axis_y = _axes_for_face(face, tube_axis, horizontal)
    derived_normal = _edge_vector(axis_x).crossProduct(_edge_vector(axis_y))
    setup.parameters.itemByName("wcs_orientation_mode").value.value = "axesXY"
    setup.parameters.itemByName("wcs_orientation_axisX").value.value = [axis_x]
    setup.parameters.itemByName("wcs_orientation_axisY").value.value = [axis_y]
    setup.parameters.itemByName("wcs_orientation_flipX").value.value = derived_normal.dotProduct(_face_normal(face)) < 0
    setup.parameters.itemByName("wcs_orientation_flipY").value.value = False
    setup.parameters.itemByName("wcs_origin_boxPoint").value.value = "top 1"
    setup.createFromCAMTemplate2(template)
    _configure_face_operations(setup, face)


def handleTube(template_filename, orientation=None, program_base_name="tube"):
    """Create four indexed setups and return their matching output stems."""
    app = adsk.core.Application.get()
    doc = app.activeDocument
    if not doc:
        raise RuntimeError("No active document for box-tube CAM")
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    cam = adsk.cam.CAM.cast(doc.products.itemByProductType("CAMProductType"))
    if not design or not cam:
        raise RuntimeError("Box-tube CAM requires active Design and CAM products")
    if design.rootComponent.occurrences.count != 1:
        raise ValueError("Box-tube CAM requires exactly one imported tube occurrence")
    occurrence = design.rootComponent.occurrences.item(0)
    if occurrence.bRepBodies.count != 1:
        raise ValueError("Box-tube CAM requires exactly one solid body")
    body = occurrence.bRepBodies.item(0)

    template_file = adsk.cam.CAMTemplate.createFromFile(template_filename)
    template = adsk.cam.CreateFromCAMTemplateInput.create()
    template.camTemplate = template_file
    tube_axis = _long_axis(body)
    horizontal = str(orientation or "").strip().lower() == "horizontal"
    names = []
    for clock, face in _ordered_wall_faces(body):
        _make_setup(cam, body, face, clock, tube_axis, horizontal, template)
        names.append(tube_face_program_name(program_base_name, clock))
    app.log("Box-tube CAM created four indexed setups: {}".format(", ".join(names)))
    return names
