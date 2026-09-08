"""Build four independent Fusion setups for a rectangular box tube.

The router has no rotary axis. Each exterior wall is a separate, manually
indexed fixture setup and is posted as its own NC program. Do not turn this
into one setup with four face selections: the operator turns the tube between
programs and re-zeros Z for the newly exposed wall.
"""

import adsk.core
import adsk.fusion
import adsk.cam
import time

from .ContourChains import is_reverted_for_loop_seed
from .TubeFacePrograms import TUBE_FACE_CLOCKS, tube_face_program_name, tube_face_setup_name
from .TubeHeightMath import bottom_height_expression, cluster_by_projection, PLANE_CLUSTER_TOLERANCE_CM


_PARALLEL_TOLERANCE = 0.985
_CM_PER_IN = 2.54


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


def _face_id(face):
    """Stable identity for ``face`` in dict/set contexts - see Orientation.py's
    ``_face_id`` for why the face objects themselves (Python id() or ==)
    cannot be trusted: Fusion hands back a new wrapper object for the same
    underlying face through different accessors."""
    try:
        return face.tempId
    except Exception:
        return id(face)  # last-resort fallback, still better than nothing


def _face_normal(face):
    # ``geometry.normal`` is the underlying surface parameter normal, not
    # necessarily the topological normal of this BRep face. Imported STEP
    # faces can reverse that parameterization; using it directly can point a
    # tube setup into the wall and makes valid closed chains fail CAM's side
    # validation. Honor the face reversal so WCS +Z and loop winding describe
    # the same physical exterior side.
    normal = _normalized(face.geometry.normal)
    if face.isParamReversed:
        normal.scaleBy(-1)
    return normal


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
    """Return the two pairs of exterior walls, and each one's wall thickness.

    A hollow tube wall has its own paired interior face - the inside surface
    of that same wall, parallel to it and sitting between the two exterior
    extrema in this family. That pairing is exactly what's needed to know
    how deep a hole or cutout on the exterior face may go before it breaks
    into the hollow interior, so it's computed here (where both faces are
    already in hand) rather than re-deriving it later from just the chosen
    exterior face.
    """
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
    wall_thickness_by_face = {}
    selection_face_by_exterior = {}
    origin = adsk.core.Point3D.create()
    for family in families:
        direction = _face_normal(family[0])
        projected = sorted(
            ((origin.vectorTo(face.centroid).dotProduct(direction), face) for face in family),
            key=lambda item: item[0],
        )
        # See TubeHeightMath.cluster_by_projection - a wall can be split
        # into several coplanar BRepFace pieces, so adjacency has to be
        # resolved by plane, not by raw face, before anything downstream
        # (exterior selection, wall thickness) touches it.
        planes = cluster_by_projection(projected, PLANE_CLUSTER_TOLERANCE_CM)
        for plane in planes:
            plane["faces"] = plane.pop("items")
        if len(planes) < 2:
            raise ValueError("Could not find both exterior walls for one tube dimension")
        # The exterior wall can still be represented by several coplanar
        # pieces; the largest one is the most reliable choice for the axis/
        # WCS detection and loop selection that follow.
        exterior_near = max(planes[0]["faces"], key=lambda face: face.area)
        exterior_far = max(planes[-1]["faces"], key=lambda face: face.area)
        exterior_pairs.append((exterior_near, exterior_far))
        # Inner walls live between the two exterior-wall planes. A wall
        # thickness is only known when a third, distinct plane exists
        # inward of an exterior extremum - genuinely solid stock (only the
        # two exterior planes present) has no such pairing; that face is
        # simply absent from the map, and the caller falls back to treating
        # that dimension as solid all the way to the opposite wall.
        if len(planes) >= 3:
            inner_near = max(planes[1]["faces"], key=lambda face: face.area)
            inner_far = max(planes[-2]["faces"], key=lambda face: face.area)
            wall_thickness_by_face[_face_id(exterior_near)] = abs(planes[1]["projection"] - planes[0]["projection"]) / _CM_PER_IN
            wall_thickness_by_face[_face_id(exterior_far)] = abs(planes[-1]["projection"] - planes[-2]["projection"]) / _CM_PER_IN
            # Shape Through's chain must be on the material's bottom face.
            # The exterior wall remains the exposed setup/WCS face, but its
            # paired inner wall is where Fusion traces the actual breakout
            # contour. Selecting the exterior loop here made adaptive clear
            # from the wrong side and produced the wall-spanning zig-zags.
            selection_face_by_exterior[_face_id(exterior_near)] = inner_near
            selection_face_by_exterior[_face_id(exterior_far)] = inner_far
    return exterior_pairs, wall_thickness_by_face, selection_face_by_exterior


def _ordered_wall_faces(body):
    axis = _long_axis(body)
    (pair_a, pair_b), wall_thickness_by_face, selection_face_by_exterior = _wall_face_families(body, axis)
    # These are fixture order labels, not claims about a STEP model's
    # arbitrary global orientation. The operator labels the real tube 12/3/6/9
    # to match the four emitted files before machining it.
    faces = (pair_a[1], pair_b[1], pair_a[0], pair_b[0])
    return [
        (
            clock,
            face,
            selection_face_by_exterior.get(_face_id(face), face),
            wall_thickness_by_face.get(_face_id(face)),
        )
        for clock, face in zip(TUBE_FACE_CLOCKS, faces)
    ]


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
        # Use the loop's edges, not BRepCoEdge.edge.  The loop belongs to
        # the occurrence-body selected as this setup's model, and its edge
        # collection retains that occurrence context for Fusion's CAM model
        # tree lookup.  Co-edges are still needed below for loop direction.
        edges = list(loop.edges)
        if not edges:
            continue
        circular = len(edges) == 1 and isinstance(edges[0].geometry, adsk.core.Circle3D)
        boxes = [edge.boundingBox for edge in edges]
        circular_faces = []
        if circular:
            # Bore's ``circularFaces`` parameter does not mean the planar
            # wall face that *contains* a hole. It means the cylindrical
            # BRep face forming the hole wall. Selecting the planar face was
            # a subtle but real API mismatch: it can remain accepted as a
            # generic BRepFace while producing no bore, or selecting a
            # different cylindrical feature from stale template geometry.
            for edge in edges:
                for adjacent_face in edge.faces:
                    if adjacent_face.geometry.objectType != adsk.core.Cylinder.classType():
                        continue
                    if adjacent_face not in circular_faces:
                        circular_faces.append(adjacent_face)
        specs.append({
            "edges": edges,
            "is_reverted": is_reverted_for_loop_seed(coedges[0].isOpposedToEdge),
            "circular": circular,
            "circular_faces": circular_faces,
        })
    return specs


def _apply_chains(operation, parameter_name, specs):
    parameter = operation.parameters.itemByName(parameter_name)
    if parameter is None or not hasattr(parameter.value, "getCurveSelections"):
        return False
    if not specs:
        return False

    def apply_single(spec, reverted):
        selections = parameter.value.getCurveSelections()
        selections.clear()
        selection = selections.createNewChainSelection()
        selection.isOpen = False
        selection.isReverted = reverted
        # A single edge is a deliberate chain seed. Fusion closes the
        # tangent-connected loop itself; passing every edge works for a
        # circle but makes imported irregular through-shape loops invalid
        # or ambiguously directed.
        selection.inputGeometry = [spec["edges"][0]]
        parameter.value.applyCurveSelections(selections)

    # Each loop's correct winding is resolved on its own, never assumed to
    # match any other loop's - confirmed live: two independent through-shape
    # loops on the same wall needed opposite directions, and applying every
    # loop in one batch with a single shared guess (direct, then everything
    # inverted) does not fail loudly when that guess is wrong for only SOME
    # of them. Fusion does not raise in that case; it silently resolves the
    # mismatched loop into a differently-sized, wrong chain instead of the
    # small feature actually selected, and machines whatever that wrong
    # chain traces - confirmed live as a toolpath sprawled across nearly the
    # entire wall instead of the one small loop asked for.
    #
    # Resolving one loop in isolation, with nothing else in the selection
    # collection, is what makes Fusion's own validation actually catch a
    # wrong direction and raise - the same mechanism this function already
    # relied on for a single chain, just no longer diluted by a second,
    # unrelated loop sharing the same collection.
    resolved = []
    for spec in specs:
        try:
            apply_single(spec, spec["is_reverted"])
            resolved.append(spec["is_reverted"])
            continue
        except RuntimeError as direct_error:
            pass
        try:
            apply_single(spec, not spec["is_reverted"])
            resolved.append(not spec["is_reverted"])
            adsk.core.Application.get().log(
                "Tube chain winding inverted for valid {} selection in '{}' (seed edge {})".format(
                    parameter_name, operation.name, spec["edges"][0].tempId
                )
            )
        except RuntimeError as inverted_error:
            raise RuntimeError(
                "No valid {} chain selection for tube operation {!r}, loop seed edge {}; "
                "topology and inverse windings were both rejected: {} / {}".format(
                    parameter_name, operation.name, spec["edges"][0].tempId, direct_error, inverted_error
                )
            )

    # Every loop resolved to its own correct, independently-validated
    # direction - now apply them together as the operation's real final
    # selection.
    selections = parameter.value.getCurveSelections()
    selections.clear()
    for spec, reverted in zip(specs, resolved):
        selection = selections.createNewChainSelection()
        selection.isOpen = False
        selection.isReverted = reverted
        selection.inputGeometry = [spec["edges"][0]]
    parameter.value.applyCurveSelections(selections)
    return True


def _apply_circular_faces(operation, faces):
    parameter = operation.parameters.itemByName("circularFaces")
    if parameter is None or not faces:
        return False
    try:
        parameter.value.value = faces
        return True
    except Exception:
        return False


def _set_expression(operation, parameter_name, expression):
    parameter = operation.parameters.itemByName(parameter_name)
    if parameter is not None:
        parameter.expression = expression


def _set_face_stock_heights(operation, wall_thickness_in):
    """Use the current setup's face-local stock, never template coordinates."""
    _set_expression(operation, "topHeight_mode", "'from stock top'")
    _set_expression(operation, "topHeight_offset", "0 in")
    # Each indexed setup aligns +Z with its exterior wall normal, so this is
    # specifically the stock below the face being machined, not a global-Z
    # bottom from a different tube side or a stale template point. See
    # TubeHeightMath.bottom_height_expression for why this can no longer be
    # a blanket 'from stock bottom' - that's the FAR wall on a hollow tube.
    bottom_mode, bottom_offset = bottom_height_expression(wall_thickness_in)
    _set_expression(operation, "bottomHeight_mode", bottom_mode)
    _set_expression(operation, "bottomHeight_offset", bottom_offset)


def _configure_face_operations(setup, selection_face, wall_thickness_in):
    """Rebind operations to the active wall's material-bottom loops only."""
    loops = _loop_specs(selection_face)
    # Every non-circular tube loop is a closed through feature. Even a long,
    # narrow cutout needs the Shape Through clearing strategy; 2D Slot Cut
    # follows a centerline-style path and machines those closed profiles
    # incorrectly on tube walls.
    shapes = [loop for loop in loops if not loop["circular"]]
    have_shape_roughing = False
    circular_faces = [face for loop in loops if loop["circular"] for face in loop["circular_faces"]]

    # Delete the deliberately unsupported cutoff before applying any feature
    # selection. If a later shape/slot binding fails, Fusion retains the
    # partial setup for inspection; it must not misleadingly show the stale
    # template cutoff as an active errored operation in that partial state.
    operations = []
    for operation in list(setup.operations):
        if "tube cutoff" in str(operation.name or "").lower():
            operation.deleteMe()
        else:
            operations.append(operation)

    for operation in operations:
        name = str(operation.name or "").lower()
        keep = False
        if operation.strategy == "bore" or "drill" in name:
            # Bore's circularFaces accepts the actual cylindrical hole walls,
            # unlike 2D Pocket's curve parameter. The reviewed Bore template
            # uses the same flat end mill as the large-hole pocket sibling,
            # so broaden its diameter range and let the correct API own all
            # circular through holes on this indexed face.
            _set_expression(operation, "holeDiameterMinimum", "0 in")
            _set_expression(operation, "holeDiameterMaximum", "100 in")
            keep = bool(circular_faces) and _apply_circular_faces(operation, circular_faces)
        elif "circular" in name and "hole" in name:
            # 2D Pocket rejects the circular through-hole chains on an
            # imported tube wall. Its geometry is handled by the Bore above,
            # which selects cylindrical walls directly and produces the
            # correct face-scoped result.
            keep = False
        elif "shape" in name and "through" in name and operation.strategy in ("adaptive2d", "pocket2d"):
            # The current template has regular and Small roughing siblings.
            # Do not cut every profile twice: use the first applicable one.
            keep = bool(shapes) and not have_shape_roughing and _apply_chains(operation, "pockets", shapes)
            have_shape_roughing = have_shape_roughing or keep
        elif "shape" in name and operation.strategy == "contour2d":
            keep = _apply_chains(operation, "contours", shapes)
        elif "slot" in name and operation.strategy == "contour2d":
            keep = False
        if keep:
            _set_face_stock_heights(operation, wall_thickness_in)
        else:
            operation.deleteMe()


def _bind_setup_to_face(setup, body, face, tube_axis, horizontal):
    """Bind the real tube body and face-local WCS after template changes."""
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


def _cap_other_way_feedrate(setup):
    """Keep adaptive return feed no faster than the material-scaled cut feed."""
    capped = []
    for operation in setup.operations:
        if operation.strategy != "adaptive2d":
            continue
        other = operation.parameters.itemByName("otherWayFeedrate")
        cutting = operation.parameters.itemByName("tool_feedCutting")
        if other is None or cutting is None:
            continue
        try:
            if other.value.value > cutting.value.value:
                other.value.value = cutting.value.value
                capped.append(operation.name)
        except Exception:
            continue
    return capped


def _make_setup(cam, body, face, selection_face, clock, tube_axis, horizontal, template, wall_thickness_in):
    setup_input = cam.setups.createInput(0)
    setup_input.name = tube_face_setup_name(clock)
    setup = cam.setups.add(setup_input)
    _bind_setup_to_face(setup, body, face, tube_axis, horizontal)
    setup.createFromCAMTemplate2(template)
    # createFromCAMTemplate2 returns before Fusion has fully attached the
    # copied operations to this setup's CAM model tree.  A selection applied
    # in that same API turn is rejected as "Do not have valid curve
    # selections", even though the BRep edges are valid. Let Fusion finish
    # resolving the imported template before rebinding it to this wall.
    adsk.doEvents()
    time.sleep(0.1)
    # A template can carry its own setup context. Reapply our occurrence body
    # and face-local WCS after the import so every selection below resolves in
    # this setup's actual CAM model tree, never in the template's old model.
    _bind_setup_to_face(setup, body, face, tube_axis, horizontal)
    adsk.doEvents()
    _configure_face_operations(setup, selection_face, wall_thickness_in)
    capped = _cap_other_way_feedrate(setup)
    if capped:
        adsk.core.Application.get().log(
            "Tube CAM: capped otherWayFeedrate on {}".format(capped)
        )
    return setup


def _active_cam_product(app, doc):
    """Activate Manufacture and wait for Fusion to attach CAM to ``doc``.

    A new Fusion design document initially has only a Design product. CAM is
    attached lazily when Manufacture is activated, so looking it up directly
    after STEP import fails with "failed to find product". Plate CAM already
    establishes this workspace prerequisite in SetupGenerator; tube CAM must
    do it here too because it creates its own four setups.
    """
    try:
        workspace = app.userInterface.workspaces.itemById("CAMEnvironment")
        if workspace:
            workspace.activate()
    except Exception:
        # The lookup below supplies the actionable error if Manufacture cannot
        # be activated on this Fusion installation.
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


def handleTube(template_filename, orientation=None, program_base_name="tube"):
    """Create four indexed setups and return their matching output stems."""
    app = adsk.core.Application.get()
    doc = app.activeDocument
    if not doc:
        raise RuntimeError("No active document for box-tube CAM")
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    if not design:
        raise RuntimeError("Box-tube CAM requires an active Design product")
    cam = _active_cam_product(app, doc)
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
    for clock, face, selection_face, wall_thickness_in in _ordered_wall_faces(body):
        _make_setup(cam, body, face, selection_face, clock, tube_axis, horizontal, template, wall_thickness_in)
        names.append(tube_face_program_name(program_base_name, clock))
    # Defensive invariant, not just a byproduct of the loop above: a tube is
    # always exactly four indexed setups, never fewer. Catches a future
    # refactor of _ordered_wall_faces/TUBE_FACE_CLOCKS breaking that
    # guarantee before it ever reaches export/post.
    if len(names) != 4 or cam.setups.count != 4:
        raise RuntimeError(
            "Box-tube CAM must always produce exactly four setups; got {} program name(s) and {} setup(s)".format(
                len(names), cam.setups.count
            )
        )
    app.log("Box-tube CAM created four indexed setups: {}".format(", ".join(names)))
    return names
