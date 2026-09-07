"""Objective "is every real feature actually being cut?" check.

Written because the loop this replaces was: change one selection variable,
re-run a job, and ask a human to eyeball the simulated stock for a missing
cutout. That never distinguished "the chain wasn't selected" from "the chain
was selected but resolved to the wrong geometry" from "it was selected and
cut, at the wrong depth" - and a chain count matching the loop count (8 == 8)
looked healthy in every one of those cases.

This compares two independent sources of truth instead:

  1. the part's own CAD geometry - every internal (non-outer) loop on the
     face the selections are built from, as real XY extents; and
  2. the toolpath that actually came out - every closed loop in the posted
     G-code, as real XY extents.

A CAD loop with no G-code loop near it is definitively not being machined,
whatever the operation's chain count claims. A G-code loop matching no CAD
loop means a chain resolved to geometry that isn't the feature it was built
from. Both are reported by name/position, so the answer is a list of real
coordinates rather than "it still looks wrong."

Depth is checked separately and reported per operation: a loop can be
correctly selected and still never break through, which is what a
'from contour' bottomHeight leaves behind (see DeleteToolpaths.py).
"""

import math
import re


# How close a G-code loop's centre has to be to a CAD loop's centre to count
# as "this is the toolpath for that feature", in cm. A contour toolpath rides
# a tool radius off the feature boundary, and lead-in/out arcs push its
# extents out a bit further, so this cannot be tight - but it is far smaller
# than the spacing between distinct features on any real plate, which is what
# it actually has to separate.
_CENTRE_MATCH_TOLERANCE_CM = 1.0


def internal_loop_extents(body, face_picker):
    """Every internal (non-outer) loop on the picked face, as
    {"edge_count", "circular", "min_x"/"max_x"/"min_y"/"max_y", "cx"/"cy"}
    in cm. face_picker is _top_face/_bottom_face from DeleteToolpaths, passed
    in rather than imported so this stays usable against either face without
    this module having an opinion about which one is correct.
    """
    import adsk.core

    face = face_picker(body)
    if face is None:
        return []

    loops = []
    for loop in face.loops:
        if loop.isOuter:
            continue
        edges = [co_edge.edge for co_edge in loop.coEdges]
        if not edges:
            continue
        xs, ys = [], []
        for edge in edges:
            box = edge.boundingBox
            xs += [box.minPoint.x, box.maxPoint.x]
            ys += [box.minPoint.y, box.maxPoint.y]
        circular = len(edges) == 1 and isinstance(edges[0].geometry, adsk.core.Circle3D)
        loops.append({
            "edge_count": len(edges),
            "circular": circular,
            "min_x": min(xs), "max_x": max(xs),
            "min_y": min(ys), "max_y": max(ys),
            "cx": (min(xs) + max(xs)) / 2,
            "cy": (min(ys) + max(ys)) / 2,
        })
    return loops


_COORD = re.compile(r"([XYZ])(-?\d*\.?\d+)")


def gcode_loops(text, mm_to_cm=0.1):
    """Every distinct cutting loop in a posted program, as XY extents in cm.

    A "loop" here is one run of cutting moves between rapid repositions - the
    G0 retract/reposition pairs a contour operation emits between separate
    closed chains. Only moves at or below the program's own deepest cutting Z
    are counted as cutting, so a lead-in ramp above the stock doesn't inflate
    a loop's extents or invent one of its own.
    """
    lines = [line.strip() for line in text.splitlines()]

    # Deepest Z the program ever reaches - the real cutting plane. Everything
    # shallower is approach/retract/tab.
    depths = []
    for line in lines:
        for axis, value in _COORD.findall(line):
            if axis == "Z":
                depths.append(float(value))
    if not depths:
        return []
    z_min = min(depths)
    cutting_z_ceiling = z_min + 1e-6

    loops = []
    current = None
    x = y = z = None
    for line in lines:
        if not line or line.startswith("("):
            continue
        found = dict((axis, float(value)) for axis, value in _COORD.findall(line))
        is_rapid = line.startswith("G0") or line.startswith("G00")
        x = found.get("X", x)
        y = found.get("Y", y)
        z = found.get("Z", z)
        if x is None or y is None or z is None:
            continue
        if is_rapid:
            # A rapid ends whatever loop was being cut.
            if current:
                loops.append(current)
                current = None
            continue
        if z > cutting_z_ceiling:
            continue
        if current is None:
            current = {"min_x": x, "max_x": x, "min_y": y, "max_y": y}
        current["min_x"] = min(current["min_x"], x)
        current["max_x"] = max(current["max_x"], x)
        current["min_y"] = min(current["min_y"], y)
        current["max_y"] = max(current["max_y"], y)
    if current:
        loops.append(current)

    out = []
    for loop in loops:
        scaled = dict((key, value * mm_to_cm) for key, value in loop.items())
        scaled["cx"] = (scaled["min_x"] + scaled["max_x"]) / 2
        scaled["cy"] = (scaled["min_y"] + scaled["max_y"]) / 2
        out.append(scaled)
    return out


def match_loops(cad_loops, cut_loops, origin_x=0.0, origin_y=0.0, tolerance_cm=_CENTRE_MATCH_TOLERANCE_CM):
    """Pairs CAD loops with the toolpath loops that cut them.

    origin_x/origin_y shift the G-code frame onto the CAD frame - posted
    coordinates are relative to the setup's own WCS, the CAD extents are in
    model space, and the two differ by wherever the part was nested on the
    plate. Pass the offset between them (see report()'s own inference).

    Returns (matched, uncut_cad_loops, unexplained_cut_loops).
    """
    remaining = list(range(len(cut_loops)))
    matched = []
    uncut = []
    for cad in cad_loops:
        best_index = None
        best_distance = None
        for index in remaining:
            cut = cut_loops[index]
            distance = math.hypot(
                (cut["cx"] + origin_x) - cad["cx"],
                (cut["cy"] + origin_y) - cad["cy"],
            )
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best_index = index
        if best_index is not None and best_distance <= tolerance_cm:
            remaining.remove(best_index)
            matched.append({"cad": cad, "cut": cut_loops[best_index], "distance_cm": best_distance})
        else:
            uncut.append({"cad": cad, "nearest_distance_cm": best_distance})
    return matched, uncut, [cut_loops[i] for i in remaining]


def infer_origin(cad_loops, cut_loops, tolerance_cm=_CENTRE_MATCH_TOLERANCE_CM):
    """Best (dx, dy) putting the G-code frame onto the CAD frame.

    Every loop in a program shares one WCS offset, so a single global shift is
    the whole correction. Averaging the two sets' centres looks like the
    obvious way to find it and is wrong exactly when it matters: if some
    features go uncut, the two centres are centres of different point sets, so
    the average lands between them and pulls every loop out of alignment -
    turning "one feature is missing" into "nothing matches at all", the one
    answer this module exists to avoid producing.

    Instead every (cad, cut) pairing is treated as a vote for the offset it
    implies, and the offset agreeing with the most other pairings wins. A
    partially-covered part still recovers the true shift from whichever
    features ARE cut, leaving the uncut ones genuinely - and visibly -
    unmatched.
    """
    if not cad_loops or not cut_loops:
        return 0.0, 0.0

    best_offset = (0.0, 0.0)
    best_votes = -1
    for cad in cad_loops:
        for cut in cut_loops:
            dx = cad["cx"] - cut["cx"]
            dy = cad["cy"] - cut["cy"]
            votes = 0
            for other_cad in cad_loops:
                for other_cut in cut_loops:
                    if (
                        math.hypot(
                            (other_cut["cx"] + dx) - other_cad["cx"],
                            (other_cut["cy"] + dy) - other_cad["cy"],
                        )
                        <= tolerance_cm
                    ):
                        votes += 1
                        break
            if votes > best_votes:
                best_votes = votes
                best_offset = (dx, dy)
    return best_offset


def breakthrough_check(program_text, material_bottom_z_cm, material_top_z_cm, mm_to_cm=0.1):
    """Does this program's deepest cut actually pass through the material?

    The generalizable form of a real bug this caught by hand: an operation
    can hold every correct geometry selection, report a valid toolpath and no
    warning, and still never break through, because its bottomHeight was
    referenced to the selected contour's own Z instead of the stock bottom.
    Nothing about the selection is wrong in that case, so no
    selection-oriented check finds it - only comparing the posted depth
    against the real material does.

    Returns (passes, deepest_cut_z_cm, required_z_cm). required_z_cm is the
    material's own bottom: a through-cut has to reach at least there, and in
    practice goes slightly past it.
    """
    depths = []
    for line in program_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("("):
            continue
        for axis, value in _COORD.findall(stripped):
            if axis == "Z":
                depths.append(float(value) * mm_to_cm)
    if not depths:
        return False, None, material_bottom_z_cm
    deepest = min(depths)
    # Posted Z is relative to the setup WCS (stock top = 0), so the material
    # bottom sits one thickness below zero regardless of where the body lives
    # in model space.
    thickness = abs(material_top_z_cm - material_bottom_z_cm)
    required = -thickness
    return deepest <= required + 1e-9, deepest, required


def cutting_points(program_text, mm_to_cm=0.1):
    """Every XY point the tool actually visits at the program's own deepest
    cutting Z, in cm. Approach/retract/tab moves above that plane are left
    out - they don't remove material, so they can't thin a wall.
    """
    lines = [line.strip() for line in program_text.splitlines()]
    depths = [
        float(value)
        for line in lines
        for axis, value in _COORD.findall(line)
        if axis == "Z"
    ]
    if not depths:
        return []
    ceiling = min(depths) + 1e-6

    points, x, y, z = [], None, None, None
    for line in lines:
        if not line or line.startswith("("):
            continue
        found = dict((axis, float(value)) for axis, value in _COORD.findall(line))
        is_rapid = line.startswith("G0")
        x = found.get("X", x)
        y = found.get("Y", y)
        z = found.get("Z", z)
        if x is None or y is None or z is None or is_rapid:
            continue
        if z <= ceiling:
            points.append((x * mm_to_cm, y * mm_to_cm))
    return points


def thin_wall_check(program_a, program_b, tool_diameter_cm, minimum_wall_cm):
    """Smallest piece of material left standing between two programs' cuts.

    The failure this exists to catch has nothing to do with selections and is
    invisible to every selection-oriented check: two operations can each cut
    exactly the right geometry and still leave a wall too thin to survive,
    purely because the part places those features close together and the tool
    is as wide as it is. Rendered, the two cuts appear to merge into one - the
    same thing a wrongly-selected chain looks like - so distinguishing them by
    eye is not possible, only by measuring.

    Returns (passes, wall_cm, closest_centre_distance_cm). wall_cm is what
    actually remains: the gap between the two toolpath centrelines, less the
    tool's own full width, since each path removes a radius from either side.
    """
    points_a = cutting_points(program_a)
    points_b = cutting_points(program_b)
    if not points_a or not points_b:
        return True, None, None

    closest = None
    for ax, ay in points_a:
        for bx, by in points_b:
            distance = math.hypot(ax - bx, ay - by)
            if closest is None or distance < closest:
                closest = distance
    wall = closest - tool_diameter_cm
    return wall >= minimum_wall_cm, wall, closest


def report(cad_loops, cut_loops, in_per_cm=1 / 2.54):
    """Human-readable coverage summary - the thing to read instead of a
    screenshot. Reports in inches, since that's what the shop measures in.
    """
    origin_x, origin_y = infer_origin(cad_loops, cut_loops)
    matched, uncut, unexplained = match_loops(cad_loops, cut_loops, origin_x, origin_y)

    lines = [
        f"CAD internal loops: {len(cad_loops)}",
        f"Toolpath loops:     {len(cut_loops)}",
        f"Matched:            {len(matched)}",
        f"NOT CUT:            {len(uncut)}",
        f"Unexplained cuts:   {len(unexplained)}",
    ]
    for entry in uncut:
        cad = entry["cad"]
        nearest = entry["nearest_distance_cm"]
        lines.append(
            "  NOT CUT: {}-edge {} loop at ({:.3f}, {:.3f})in, size {:.3f}x{:.3f}in"
            " - nearest toolpath {:.3f}in away".format(
                cad["edge_count"],
                "circular" if cad["circular"] else "profile",
                cad["cx"] * in_per_cm,
                cad["cy"] * in_per_cm,
                (cad["max_x"] - cad["min_x"]) * in_per_cm,
                (cad["max_y"] - cad["min_y"]) * in_per_cm,
                (nearest or 0) * in_per_cm,
            )
        )
    for cut in unexplained:
        lines.append(
            "  UNEXPLAINED toolpath loop at ({:.3f}, {:.3f})in, size {:.3f}x{:.3f}in".format(
                (cut["cx"] + origin_x) * in_per_cm,
                (cut["cy"] + origin_y) * in_per_cm,
                (cut["max_x"] - cut["min_x"]) * in_per_cm,
                (cut["max_y"] - cut["min_y"]) * in_per_cm,
            )
        )
    return "\n".join(lines), {"matched": matched, "uncut": uncut, "unexplained": unexplained}
