# Feature classification, geometry selection, and chain direction

`DeleteToolpaths.py` rebuilds the template's stale geometry selections from
the imported STEP model. This covers how it decides *what* geometry each
operation gets and *which direction* the resulting chain runs - both were
sources of real, live-confirmed bugs, not just style questions.

## Which operation gets which geometry

A template's contour2d/pocket2d/adaptive2d operations fall into a few
distinct roles, decided by name and strategy in `_repair_missing_selections`:

- **Outer profile** (`group_tabs=true` in the template, e.g. `2D Slot Cut`):
  every body's own outer-loop edges, taken from the **bottom** face
  (`_bottom_face`). Holds tabs.
- **Through features** (any operation with `"through"` in its name, e.g.
  `Shape Through Hole`, `Small Shape Through Hole`, `Shape Through Finishing
  Pass` - `"circular"` excluded so this never collides with the dedicated
  circular-hole operation below): every non-circular internal loop that
  genuinely cuts all the way through the material, taken from the bottom
  face. Never holds tabs.
- **Big circular through-hole** (name has both `"circular"` and `"hole"`,
  e.g. `>.3 Circular Through Hole`): circular through-loops at or above the
  diameter its own name implies, taken from the bottom face.
- **Blind circular pocket** (name has `"circular"` and `"pocket"`, not
  `"hole"`, e.g. `>.3 Circular Pocket`): circular loops confirmed blind (see
  below), at or above the diameter its own name implies.
- **General pocket** (any other pocket-strategy operation, e.g. `Shape
  Pocket`): every non-circular blind loop, plus any blind circular loop too
  small to meet a dedicated circular-pocket operation's own threshold (or if
  the template has no such dedicated operation at all).

The "through" vs "circular" name matching is load-bearing, not cosmetic - a
template operation that doesn't match any of these (e.g. a hypothetical
"Small Circular Pocket Finishing" with an unusual name) falls through to
none of the above and won't get the geometry it needs. If a real template
adds a new operation, extend the matching in `_repair_missing_selections`,
don't rename the operation to dodge it.

### A real bug this name matching already caught

An earlier version only matched `"shape through hole"` (exact) and
`"shape through finishing"` (substring) for through-features. A template's
own `Small Shape Through Hole` operation matched neither, so it fell into
the *general pocket* branch instead - which fed it a real pocket's own
floor geometry, while its own template-default depth stayed configured for
a through-cut (`bottomHeight_mode = 'from surface bottom'`, full material
depth). Confirmed live: a real hexagonal blind pocket got cut twice - once
correctly (by the actual pocket operation) and once straight through (by
this one) - and the through cut won physically. Fixed by matching any
operation with `"through"` in its name (excluding `"circular"`, which is
handled by its own dedicated branch).

## Blind pocket vs. through-cut: don't trust face normal sign

Whether an internal loop is a genuine blind pocket (has its own floor) or a
through-cut is decided **topologically**, not by comparing any face's own
reported normal direction. A STEP import can report a plate's two truly
opposite broad faces with the *identical* raw normal (confirmed live - not
the anti-parallel pair real geometry would predict), so any check built on
comparing normal signs ends up unable to tell a pocket's real opening side
from its own plain back.

`Orientation.py`'s `_cavity_walk` instead breadth-first walks a loop's own
cavity wall face(s) and checks whether the walk ever reaches the material's
actual opposite broad face (a through-cut) or exhausts every reachable wall
without doing so (a blind pocket, terminating at its own floor instead).
This is not single-hop: a real cavity's wall can be split into more than one
face by the STEP import before it reaches the far side, and a one-hop
version of this check (does a wall directly touching the opening border the
far face) gave the wrong answer on a real part - confirmed independently by
measuring the raw minimum Z any wall vertex reaches, not just by adjacency.

The same walk is shared by `orient_plate_pocket_side_up` (deciding which
broad face to rotate face-up) and `DeleteToolpaths._blind_pocket_loops_all_bodies`
(deciding which internal loops are real blind pockets) - imported directly
rather than reimplemented, so the two can never disagree about what counts
as blind.

## Blind pocket geometry: select the floor, not the opening

A pocket-clearing operation's `ChainSelection` is built from the pocket's
own **floor face's outer loop** (`_pocket_floor_face`), not the opening loop
on the part's top surface. The floor is planar and shares its opening's own
normal direction (standing in the cavity looking down at the floor, its
outward normal points the same way "up," toward the opening, that the
opening face's own normal does) - found among the faces `_cavity_walk`
already visited while confirming the loop is blind.

This was not the first attempt: an earlier version built the chain from the
*opening* loop's own edges, with a guessed direction flip applied to try to
correct for using the wrong face's coedges. It never actually produced the
right chain direction, because the opening loop and the real floor loop are
entirely different edges with independent orientation - not a simple
top/bottom mirroring a boolean flip could correct for. Selecting the actual
floor loop and reading its own coedges directly (same formula as every other
selection in this file, no flip) is both the geometrically correct thing to
select and the fix that actually worked.

## Direction rule

Do not give every `ChainSelection` the same `isReverted` value. A
`BRepEdge` is shared by faces and has one global direction, while a
`BRepCoEdge` represents that edge in one specific face loop. Fusion documents
that co-edges are ordered head-to-tail around the face: outer loops run
counter-clockwise and inner loops clockwise, keeping material on the left.

Every internal-loop selection (through-feature, big circular hole, or blind
pocket) therefore seeds Fusion's chain builder with one edge from the loop
it's actually selecting (the through/hole loop on the bottom face, or the
pocket's own floor loop), then sets:

```python
chain.isReverted = coedge.isOpposedToEdge  # via is_reverted_for_loop_seed
chain.inputGeometry = [coedge.edge]
```

This follows the actual selected loop even when that loop's first shared edge
runs opposite the face's co-edge. This applies to circular loops exactly the
same as non-circular ones - an earlier version hardcoded `isReverted = False`
for every circular selection (the big-hole branch, the circular-pocket
branch, and generic-pocket leftover-circular handling), which was confirmed
live as the same class of bug: the chain direction arrow pointed the wrong
way on a real `>.3 Circular Through Hole` operation.

The outer release operation remains separately tuned and currently uses its
known-good full outer-loop selection and reversal. Do not combine it with an
internal-feature operation or copy its direction setting into feature
chains: its tool-side and tab behavior are different.

## Face identity: use `tempId`, never Python's `id()` or bare `==`

Fusion hands back a **new SWIG wrapper object** every time the same
underlying face is reached through a different accessor (`body.faces`,
`edge.faces`, ...). Python's own `id()` on these objects - and even a naive
`==`/`!=` comparison, depending on the accessor - can silently fail to
recognize two references to the same real face as equal.

This is not a theoretical caveat. An early version of `_cavity_walk` tracked
visited faces with `id()`. The dedup never actually matched, so the walk
revisited the same handful of faces indefinitely - Fusion's own process hung
for 60+ seconds mid-job and had to be force-restarted, not a Python-level
infinite loop that would at least show up as a traceback. `Orientation.py`'s
`_face_id` helper uses `BRepFace.tempId` instead, which *is* stable across
separate accessors for the same underlying geometry within one document
state. Any new code that needs to compare or deduplicate face objects should
use `_face_id`, not `id()` or bare equality.

## Tabs

Tab edges are selected on the outer profile the same way as any other
selection - real edges, not synthesized points - but tab *placement* has its
own rule, in `TabPlacement.py`: every distinct straight side of a part gets
at least one guaranteed tab, even a side with no real stock behind it (a
part positioned close to the plate's own edge can leave a whole side without
real backing). Stock backing only decides *which* edge to prefer within a
side (and fills any budget remaining beyond the one-per-side guarantee) - it
never drops a whole side to zero tabs. See `TabPlacement.py`'s own module
docstring and `select_tab_edges` for the full reasoning.

## Validation

After changing geometry selection, chain direction, or tab placement, queue
a real job (`autocam/scripts/queue-fusion-plate-job.mjs` against a real STEP
file - prefer one with a genuine mix of through-cuts and blind pockets,
circular and non-circular) and confirm live in Fusion:

- Every operation that should exist for this part's geometry does
  (`Shape Through Hole`/`Shape Through Finishing Pass` for through-cuts,
  `Shape Pocket`/`>.3 Circular Pocket` for real blind pockets - and *only*
  for parts that actually have them; an operation with no matching geometry
  should end up empty and get cleaned up, not linger or fall back onto the
  wrong feature).
- No operation shows a warning or an empty toolpath.
- Each internal operation's own selected geometry sits at the Z height it
  should (a through-loop at the material's true bottom, a pocket loop at its
  own real floor depth - not the same Z for both).
- The chain direction arrow is correct in Fusion's own UI - `isReverted`
  alone doesn't prove this; it just proves the code isn't hardcoding one
  value.
- Simulate before posting and verify the tool stays in the intended cutout,
  not the retained material, and that a blind pocket actually stops at its
  floor rather than cutting through.

`tests/test_contour_chains.py` protects the pure direction mapping,
`tests/test_pocket_orientation.py` protects the pure blind-vs-through
decision, and `tests/test_tab_placement.py` protects the tab-per-side
guarantee - all without requiring Fusion. A live Fusion simulation remains
required for actual CAM behavior; none of these unit tests can catch a
Fusion-side identity or recognition failure like the ones documented above.
