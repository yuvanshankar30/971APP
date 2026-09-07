# Contour Chain Direction

`DeleteToolpaths.py` rebuilds the template's stale geometry selections from
the imported STEP model. The final outer release cut and the internal Feature
Slot Cut deliberately use separate selection logic: the outer cut receives
only each body's outer loop and may hold tabs; the feature cut receives every
non-circular internal through-cut loop and never receives tabs.

## Direction rule

Do not give every `ChainSelection` the same `isReverted` value. A
`BRepEdge` is shared by faces and has one global direction, while a
`BRepCoEdge` represents that edge in one specific face loop. Fusion documents
that co-edges are ordered head-to-tail around the face: outer loops run
counter-clockwise and inner loops clockwise, keeping material on the left.

Feature-loop selection therefore seeds Fusion's chain builder with one edge,
then sets:

```python
chain.isReverted = coedge.isOpposedToEdge
chain.inputGeometry = [coedge.edge]
```

This follows the actual selected loop even when that loop's first shared edge
runs opposite the face's co-edge. It is important for every future plate or
grouped CAM job, not only Anton Plate. Passing a full unordered edge list to
the feature operation is intentionally avoided: Fusion's chain builder has
been more reliable completing a closed feature from one seed edge.

The outer release operation remains separately tuned and currently uses its
known-good full outer-loop selection and reversal. Do not combine it with the
feature operation or copy its direction setting into feature chains: its
tool-side and tab behavior are different.

## Validation

After changing contour selection or compensation, queue a single-part and a
grouped plate job. In Fusion, open **Feature Slot Cut** and confirm every
internal loop is present with a consistent direction, while **2D Slot Cut**
contains only the outer release contour. Simulate before posting and verify
the tool stays in the intended cutout, not the retained material.

`tests/test_contour_chains.py` protects the pure direction mapping without
requiring Fusion. A live Fusion simulation remains required for CAM behavior.
