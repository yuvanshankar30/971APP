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
