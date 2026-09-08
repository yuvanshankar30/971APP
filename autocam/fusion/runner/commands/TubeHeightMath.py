"""Pure depth math for tube face operations - no Fusion API dependency.

Kept in its own Fusion-independent module (same reasoning as
TubeFacePrograms.py: the workflow and its tests must not drift apart)
because HandleTube.py itself can only be exercised inside a real Fusion
process.
"""

# A hole or shape cutout on one wall of a hollow tube must stop once it
# breaks through that wall's own inner surface - it must never continue
# across the hollow interior into the far wall. This is the same
# breakthrough-clearance value the original hand-authored template already
# used for its own (stale, template-relative) bottomHeight_offset, kept here
# so the actual cut depth still fully clears the near wall's inner face
# rather than stopping exactly on it.
BREAKTHROUGH_CLEARANCE_IN = 0.05

# Two coplanar STEP-split pieces of the same physical wall measure a hair's
# breadth apart (confirmed live: effectively 0, well under a thousandth of
# an inch). A real distinct wall is always far thicker than that for any
# tube stock this shop cuts - 0.005cm (~0.002in) safely separates the two
# without risking merging two genuinely thin adjacent walls.
PLANE_CLUSTER_TOLERANCE_CM = 0.005


def cluster_by_projection(sorted_projection_items, tolerance):
    """Group items whose (already-sorted) projection is within ``tolerance``.

    A STEP-imported wall is not always one single BRepFace - a hole, notch,
    or other feature near the edge can split what is physically one flat
    surface into several coplanar pieces. Confirmed live: naively treating
    "the next item in sorted order" as the neighboring physical plane broke
    on exactly this case - the next entry was the SAME wall's other split
    piece, at (essentially) the same projection. Clustering by projection
    first, before ever picking adjacency, makes that immune to however many
    pieces one physical plane happens to be split into.

    ``sorted_projection_items`` is an iterable of ``(projection, item)``
    pairs already sorted ascending by projection. Returns a list of
    ``{"projection": float, "items": [item, ...]}`` clusters, each
    representing one distinct plane, in the same ascending order.
    """
    planes = []
    for projection, item in sorted_projection_items:
        if planes and abs(projection - planes[-1]["projection"]) <= tolerance:
            planes[-1]["items"].append(item)
        else:
            planes.append({"projection": projection, "items": [item]})
    return planes


def bottom_height_expression(wall_thickness_in):
    """How deep a hole/cutout on this face may cut, as a bottomHeight_offset.

    ``RelativeBoxStock`` wraps the tube's whole bounding box, hollow middle
    included - "from stock bottom" is the FAR exterior wall, not the near
    wall's own inner surface. A tube feature must stop once it clears that
    near wall, never continue across the hollow interior into the far one.

    When this wall's own thickness is known (the normal case - a real
    hollow tube), depth is expressed as an offset below stock TOP instead:
    the wall thickness plus a small breakthrough clearance, so the tool
    fully clears the inner surface without cutting into the hollow void
    beyond it. ``None`` means no paired interior face was found for this
    wall (genuinely solid stock, no hollow interior to protect against) -
    stock bottom is the correct, safe depth in that degenerate case.

    Returns (bottomHeight_mode, bottomHeight_offset) as the literal
    expression strings Fusion's parameter API expects.
    """
    if wall_thickness_in is None:
        return "'from stock bottom'", "0 in"
    if wall_thickness_in <= 0:
        raise ValueError("wall_thickness_in must be positive, got {!r}".format(wall_thickness_in))
    depth_in = wall_thickness_in + BREAKTHROUGH_CLEARANCE_IN
    return "'from stock top'", "-{:.6f} in".format(depth_in)
