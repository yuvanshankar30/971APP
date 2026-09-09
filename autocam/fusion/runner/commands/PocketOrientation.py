"""Fusion-independent ranking for choosing a plate's machining side."""


def loop_is_blind_pocket(cavity_reaches_back_face: bool) -> bool:
    """Whether one feature opening (a hole/pocket/slot loop) is a blind
    pocket, given whether its cavity - walked in full, not just one hop
    from the opening - is adjacent to the material's opposite broad face
    at any depth.

    A through-cut's cavity eventually reaches the far side; a blind
    pocket's instead terminates at its own separate floor before ever
    getting there. This is deliberately NOT based on comparing any face's
    own reported normal direction: a STEP import can report a plate's two
    truly-opposite broad faces with the identical raw normal (confirmed
    live), which makes a normal-sign comparison unable to tell a pocket's
    real opening side from its own plain back - both can be fooled by the
    same shared, unreliable sign. Adjacency to the actual far-side face
    has no such ambiguity.
    """
    return not cavity_reaches_back_face


def pocket_side_sort_key(side):
    """Rank a planar plate side, preferring a modeled countersink chamfer
    first, then real blind-pocket openings.

    A through-hole appears on both broad faces, while a blind pocket appears
    only on the side from which it must be machined - same for a
    countersink chamfer, ranked first because getting it wrong isn't just
    wasted time (an unreachable blind pocket at least fails loudly): a
    countersink chamfer cut from the wrong side machines the flat back
    face into a hole instead, a real, physically wrong part. Area is
    intentionally the last tie-breaker: the unpocketed back is usually
    larger than the pocket side precisely because it has no material
    removed from it.
    """
    return (
        bool(side.get("has_countersink_chamfer", False)),
        bool(side.get("has_blind_pocket", False)),
        int(side.get("inner_loop_count", 0)),
        int(side.get("inner_edge_count", 0)),
        float(side.get("area", 0.0)),
    )


def preferred_pocket_side_index(sides):
    """Return the best side index, or ``None`` when there are no candidates."""
    if not sides:
        return None
    return max(range(len(sides)), key=lambda index: pocket_side_sort_key(sides[index]))


def should_generate_countersink(countersink_requested: bool, setup_face_has_chamfer: bool) -> bool:
    """A one-sided setup may countersink only its modeled, upward face."""
    return bool(countersink_requested and setup_face_has_chamfer)
