import adsk.core, adsk.fusion, adsk.cam, traceback

from .PocketOrientation import loop_is_blind_pocket, preferred_pocket_side_index


def _planar_face_normal(face):
    try:
        return face.geometry.normal
    except Exception:
        return None


def _face_id(face):
    """A stable identity for ``face``, usable in ``==``/set/dict contexts
    where Python's own id() or the face objects' own ``==`` cannot be
    trusted.

    Confirmed live as a real, severe bug, not a style nit: Fusion hands
    back a NEW SWIG wrapper object every time the same underlying face is
    reached through a different accessor (body.faces, edge.faces, ...),
    so identity/equality checks on the face objects themselves silently
    never matched the same real face twice. A BFS walk keyed this way
    revisited the same handful of faces indefinitely - Fusion's own
    process hung and had to be force-restarted mid-job, its main thread
    stuck for 60+ seconds inside repeated BRepFace.edges calls. tempId is
    stable across separate accessors for the same underlying geometry
    within one document state, which id()/object identity is not.
    """
    try:
        return face.tempId
    except Exception:
        return id(face)  # last-resort fallback, still better than nothing


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
    face_id = _face_id(face)
    out = []
    for other in body.faces:
        if _face_id(other) == face_id:
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
    face_id = _face_id(face)
    walls = []
    for co_edge in loop.coEdges:
        try:
            edge_faces = co_edge.edge.faces
        except Exception:
            continue
        for f in edge_faces:
            if _face_id(f) != face_id:
                walls.append(f)
    return walls


def _cavity_walk(start_walls, opening_face, target_face):
    """Breadth-first walk of the cavity behind ``opening_face``'s loop,
    starting from its own wall face(s) ``start_walls``.

    Returns ``(reaches_target, visited_faces)``: whether the walk reached
    ``target_face`` at any depth (not just one hop from the opening), and
    every OTHER face actually visited along the way (excluding
    ``opening_face`` itself) - the caller uses this second part to find a
    blind pocket's own floor face when the walk does NOT reach the target,
    rather than just knowing THAT it's blind.

    Not single-hop: confirmed live as a real, not hypothetical, distinction
    - a single-hop version of this check (does a wall directly touching
    the opening border the far face) gave the wrong answer for a real part
    where a cavity's own STEP-imported geometry split its wall into more
    than one face before reaching the material's far side - an independent
    measurement (the raw minimum Z any wall vertex reaches) confirmed the
    cavity really did go all the way through, which the one-hop version
    had missed.

    Visited-face tracking uses _face_id (BRepFace.tempId), NOT Python's own
    id() or ``==``/``in`` on the face objects themselves - see _face_id's
    own docstring for why: an id()-keyed version of this exact walk hung
    Fusion's own process for 60+ seconds inside repeated BRepFace.edges
    calls, revisiting the same handful of faces indefinitely because the
    dedup never actually matched.
    """
    target_id = _face_id(target_face)
    opening_id = _face_id(opening_face)
    seen_ids = {_face_id(w) for w in start_walls}
    visited = list(start_walls)
    frontier = list(start_walls)
    reaches_target = False
    while frontier:
        next_frontier = []
        for wall in frontier:
            if _face_id(wall) == target_id:
                reaches_target = True
                continue
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
                    f_id = _face_id(f)
                    if f_id == _face_id(wall) or f_id == opening_id:
                        continue
                    if f_id == target_id:
                        reaches_target = True
                        continue
                    if f_id in seen_ids:
                        continue
                    seen_ids.add(f_id)
                    visited.append(f)
                    next_frontier.append(f)
        frontier = next_frontier
    return reaches_target, visited


def _cavity_reaches_face(start_walls, opening_face, target_face) -> bool:
    """Whether the cavity behind ``opening_face``'s loop reaches
    ``target_face`` at any depth - see _cavity_walk for the full walk this
    wraps. True for a through-cut, False for a blind pocket (which
    terminates at its own floor instead).
    """
    reaches, _visited = _cavity_walk(start_walls, opening_face, target_face)
    return reaches


def _pocket_floor_face(opening_face, visited_faces):
    """The actual floor face of a blind pocket, among the faces visited
    walking its cavity (see _cavity_walk) - the real geometry a pocket-
    clearing operation should reference, not the opening loop on the
    part's top surface.

    A pocket floor is planar and shares its opening's own normal
    direction: standing inside the cavity looking down at the floor, the
    floor's outward normal points the same way "up," toward the opening,
    that the opening face's own normal does - unlike the cavity's vertical
    wall faces (not planar-comparable to the opening at all) or the
    material's far broad face (opposite direction, and never reached for
    a genuinely blind cavity in the first place). Returns None if no such
    face is found - the caller falls back to the opening's own loop rather
    than fail outright.
    """
    opening_normal = _planar_face_normal(opening_face)
    if opening_normal is None:
        return None
    for face in visited_faces:
        normal = _planar_face_normal(face)
        if normal is None:
            continue
        if normal.dotProduct(opening_normal) > 0.99:
            return face
    return None


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
