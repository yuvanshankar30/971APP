import adsk.core, adsk.fusion, adsk.cam, traceback

from .PocketOrientation import loop_is_blind_pocket, preferred_pocket_side_index


def _planar_face_normal(face):
    try:
        return face.geometry.normal
    except Exception:
        return None


def _same_axis_faces(body, face):
    """Every other planar face on ``body`` whose normal lies along the same
    physical line as ``face``'s own (parallel OR anti-parallel), each with
    its signed offset along ``face``'s own reported normal.

    That sign is used ONLY to rank which of these is physically farthest
    (see _back_face_for) - never to decide which side of the material
    anything is on. A STEP import can report a plate's two truly-opposite
    broad faces with the IDENTICAL raw normal (confirmed live: both a
    real front and back face reporting the same Fusion-space normal, not
    the anti-parallel pair basic geometry would predict), so a candidate
    face's own reported sign is not a safe way to tell its true opening
    side from its own plain back - see _has_blind_pocket_below_face for
    the topological check that doesn't depend on it.
    """
    normal = _planar_face_normal(face)
    if normal is None:
        return []
    try:
        origin = face.pointOnFace
    except Exception:
        return []
    out = []
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
        out.append((other, offset))
    return out


def _back_face_for(body, face):
    """The single same-axis face physically farthest from ``face`` - the
    material's true opposite broad face, identified purely by distance
    (sign-independent), not by trusting any face's own reported normal.
    """
    same_axis = _same_axis_faces(body, face)
    if not same_axis:
        return None
    return max(same_axis, key=lambda pair: abs(pair[1]))[0]


def _loop_wall_faces(face, loop):
    """Every cavity-wall face bordering ``loop`` (the loop's own opening on
    ``face``), found by walking each of the loop's edges to whichever OTHER
    face shares it - a single cylindrical wall for a round hole, one planar
    wall per side for a polygon cutout.

    Returns a plain list, duplicates included (the same wall face can be
    reached from more than one edge) - harmless for the caller, which only
    needs to know whether ANY wall reaches the back face. A set would be
    the natural dedup, but a BRepFace proxy is not hashable in the Fusion
    API (confirmed live: TypeError on set.add()).
    """
    walls = []
    for co_edge in loop.coEdges:
        try:
            edge_faces = co_edge.edge.faces
        except Exception:
            continue
        for f in edge_faces:
            if f != face:
                walls.append(f)
    return walls


def _cavity_reaches_face(start_walls, opening_face, target_face) -> bool:
    """Whether the cavity behind ``opening_face``'s loop - starting from
    its own wall face(s) ``start_walls`` - is adjacent to ``target_face``
    at ANY depth, not just one hop from the opening.

    True for a through-cut: walking the cavity's wall faces eventually
    reaches the material's actual far side. False for a blind pocket: the
    walk exhausts every reachable wall face without ever getting there
    (it instead terminates at the pocket's own floor).

    Breadth-first over wall-face adjacency, not just the walls directly
    touching the opening loop - confirmed live as a real, not
    hypothetical, distinction: a single-hop version of this check (does
    THIS wall directly border the far face) gave the wrong answer for a
    real part where a cavity's own STEP-imported geometry split its wall
    into more than one face before reaching the material's far side - an
    independent measurement (the raw minimum Z any wall vertex reaches)
    confirmed the cavity really did go all the way through, which the
    one-hop version had missed.
    """
    seen_ids = {id(w) for w in start_walls}
    frontier = list(start_walls)
    while frontier:
        next_frontier = []
        for wall in frontier:
            if wall == target_face:
                return True
            try:
                edges = list(wall.edges)
            except Exception:
                continue
            for edge in edges:
                try:
                    edge_faces = edge.faces
                except Exception:
                    continue
                for f in edge_faces:
                    if f == wall or f == opening_face:
                        continue
                    if f == target_face:
                        return True
                    if id(f) in seen_ids:
                        continue
                    seen_ids.add(id(f))
                    next_frontier.append(f)
        frontier = next_frontier
    return False


def _has_blind_pocket_below_face(body, face) -> bool:
    """Whether ``face`` is the opening side of at least one real blind
    pocket (a recessed feature with its own floor), determined
    topologically rather than by comparing any face's own reported normal
    - see _same_axis_faces for why that sign can't be trusted here.

    For each of ``face``'s own inner loops (a hole/pocket/slot opening),
    walk the cavity's wall face(s) and check whether any of them border
    the material's opposite broad face directly (a through-cut) or not (a
    blind pocket, terminating at its own floor instead). Confirmed live as
    the real fix, not the first attempt: an earlier version compared
    same-reported-direction offsets, which still misidentified the pocket
    side on a real part where Fusion happened to report the plate's true
    back face with the same normal as its real floor faces.
    """
    inner_loops = [loop for loop in face.loops if not loop.isOuter]
    if not inner_loops:
        return False
    back_face = _back_face_for(body, face)
    if back_face is None:
        return False
    for loop in inner_loops:
        walls = _loop_wall_faces(face, loop)
        if not walls:
            continue
        if loop_is_blind_pocket(_cavity_reaches_face(walls, face, back_face)):
            return True
    return False


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
