"""Small, Fusion-independent helpers for contour ChainSelection direction.

The helpers live outside DeleteToolpaths so the topology rule can be unit
tested without Fusion's ``adsk`` runtime.
"""


def is_reverted_for_loop_seed(coedge_is_opposed_to_edge: bool) -> bool:
    """Return the ChainSelection reversal needed to follow a loop co-edge.

    Fusion's ChainSelection receives a BRepEdge, whose direction is global
    and can be the opposite of the BRepCoEdge's direction on the selected
    face.  BRepLoop.coEdges are ordered around that face and encode the
    correct outer-vs-inner winding.  Reversing exactly when the seed co-edge
    opposes its edge makes Fusion follow the loop's actual topology instead
    of guessing from an arbitrary shared edge direction.
    """
    return bool(coedge_is_opposed_to_edge)


def is_reverted_for_seed_edge(coedge_rows, seed_edge_temp_id):
    """Reversal for a chain seeded from one specific edge of a loop.

    ``coedge_rows`` is ``(edge_temp_id, is_opposed_to_edge)`` for each
    co-edge around the loop; ``seed_edge_temp_id`` is the edge actually
    handed to Fusion's ChainSelection.

    The rule above is about THE SEED co-edge, but a loop's ``coEdges`` and
    ``edges`` are two separate collections with no guaranteed common order,
    so the first co-edge is often not the first edge. Taking the reversal
    from the wrong one leaves the winding correct only on those loops where
    the two orders happen to agree.

    That is not a cosmetic difference in arrow direction. Fusion accepts
    either winding on a closed loop without complaint and silently traces a
    differently-sized chain for the wrong one - confirmed live on a real
    tube wall, where two identical slots came out with one correct selection
    and one tracing a larger loop around the feature.

    Falls back to the loop's first co-edge when the seed edge has no co-edge
    of its own, which is the previous behaviour rather than a hard failure.
    """
    rows = list(coedge_rows)
    for edge_temp_id, is_opposed in rows:
        if edge_temp_id == seed_edge_temp_id:
            return bool(is_opposed)
    return bool(rows[0][1]) if rows else False
