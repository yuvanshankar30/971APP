"""Fusion-independent ranking for choosing a plate's machining side."""


def pocket_side_sort_key(side):
    """Rank a planar plate side, preferring real blind-pocket openings.

    A through-hole appears on both broad faces, while a blind pocket appears
    only on the side from which it must be machined.  Area is intentionally
    the last tie-breaker: the unpocketed back is usually larger than the
    pocket side precisely because it has no material removed from it.
    """
    return (
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
