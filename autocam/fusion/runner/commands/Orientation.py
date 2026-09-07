import adsk.core, adsk.fusion, adsk.cam, traceback

from .PocketOrientation import preferred_pocket_side_index


def _planar_face_normal(face):
    try:
        return face.geometry.normal
    except Exception:
        return None


def _has_blind_pocket_below_face(body, face, tolerance=1e-4):
    """Whether ``face`` is the opening side of at least one blind pocket.

    A real blind pocket has an intermediate planar floor between its opening
    face and the opposite broad face.  A through-hole has only the two broad
    faces.  The test uses distances projected along the candidate face normal
    rather than global Z, so it still works before the imported STEP has been
    rotated onto the plate.
    """
    inner_loops = [loop for loop in face.loops if not loop.isOuter]
    if not inner_loops:
        return False
    normal = _planar_face_normal(face)
    if normal is None:
        return False
    try:
        origin = face.pointOnFace
    except Exception:
        return False

    inward_offsets = []
    for other in body.faces:
        if other == face:
            continue
        other_normal = _planar_face_normal(other)
        if other_normal is None or abs(normal.dotProduct(other_normal)) < 0.99:
            continue
        try:
            offset = origin.vectorTo(other.pointOnFace).dotProduct(normal)
        except Exception:
            continue
        if offset < -tolerance:
            inward_offsets.append(offset)

    # The farthest parallel plane is the opposite side of the material. An
    # additional parallel plane before it is a recessed pocket floor.
    if len(inward_offsets) < 2:
        return False
    farthest = min(inward_offsets)
    return any(offset > farthest + tolerance for offset in inward_offsets)


def _pocket_side_face(body):
    candidates = []
    for face in body.faces:
        normal = _planar_face_normal(face)
        if normal is None:
            continue
        try:
            inner_loops = [loop for loop in face.loops if not loop.isOuter]
            candidates.append(
                {
                    "face": face,
                    "area": face.area,
                    "inner_loop_count": len(inner_loops),
                    "inner_edge_count": sum(loop.coEdges.count for loop in inner_loops),
                    "has_blind_pocket": _has_blind_pocket_below_face(body, face),
                }
            )
        except Exception:
            continue
    index = preferred_pocket_side_index(candidates)
    return candidates[index]["face"] if index is not None else None


def orient_plate_pocket_side_up(occurrence: adsk.fusion.Occurrence):
    app = adsk.core.Application.get()
    if occurrence.bRepBodies.count == 0:
        return
    face = _pocket_side_face(occurrence.bRepBodies.item(0))
    if face is None:
        app.log("Could not find a planar plate face to orient")
        return
    normal = _planar_face_normal(face)
    if normal is None:
        return
    app.log(
        "Orienting plate from preferred face: "
        f"area={face.area:.5f}, innerLoops={sum(not loop.isOuter for loop in face.loops)}"
    )
    n_world = normal.copy()
    n_world.transformBy(occurrence.transform2)
    n_world.normalize()
    target = adsk.core.Vector3D.create(0, 0, 1)
    angle = n_world.angleTo(target)
    if angle < 1e-8:
        app.log("No rotation needed")
        return
    axis = n_world.crossProduct(target)
    if axis.length < 1e-8:
        axis = adsk.core.Vector3D.create(1, 0, 0)
        if abs(axis.dotProduct(target)) > 0.99:
            axis = adsk.core.Vector3D.create(0, 1, 0)
    axis.normalize()
    R = adsk.core.Matrix3D.create()
    R.setToRotation(angle, axis, adsk.core.Point3D.create(0, 0, 0))
    comp = occurrence.component
    moveFeats = comp.features.moveFeatures
    objs = adsk.core.ObjectCollection.create()
    for b in comp.bRepBodies:
        objs.add(b)

    mi = moveFeats.createInput(objs, R)  # <-- required transform argument
    moveFeats.add(mi)
