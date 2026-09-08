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

## Feature vs. shape: two different things to machine

A **feature** and a **shape** are not the same cutout with different names,
and the real templates model them as separate operations:

| | Feature (slot) | Shape |
|---|---|---|
| Geometry | Long and narrow, barely wider than the cutter | Broad - a polygon or blob with real area inside |
| Machining | The tool essentially traces it; nothing to clear | Wants an adaptive/pocketing pass to clear the area |
| Operation | `Slot Cut for Features` | `Shape Through Hole` / `Shape Pocket` |

The rule is `_FEATURE_ASPECT_RATIO`: a loop whose bounding box is at least
2.5x longer than it is wide is a feature; anything rounder is a shape.

It is deliberately **shape-agnostic** - it measures elongation only, not any
particular outline - so it holds for any slot-like cutout (a straight bar,
an I, a dogbone, a pill), not one example shape.

2.5 was calibrated against a real 19-loop training part by measuring every
internal loop:

```
3.30   <- the one real slot (0.326 x 1.077in, ~2x the 0.1575in cutter)
1.80, 1.73, 1.34, 1.29, 1.17, 1.15, 1.05, 1.04, 1.02   <- broad shapes
```

The gap between 3.30 and 1.80 is wide, so the threshold sits between two
populations rather than splitting a cluster.

**An earlier aspect-ratio attempt was removed, and that was right at the
time** - real kidney/pill cutouts measuring 2.25 and 1.28 failed it, and
back then anything not classified as a slot fell through to generic
`PocketRecognitionSelection`, which found nothing, so a misclassified
feature was machined as *nothing at all*. Shapes now have working
operations of their own, so classifying a rounder cutout as a shape is a
correct outcome rather than a silent loss. That is what makes the rule
safe to reintroduce.

### Which operation slots go to

`Slot Cut for Features` is matched by name requiring **both** "slot" and
"feature". That matters because the outer release cut is *also* slot-named
(`2D Slot Cut`, `Slot Cut for Edges`) - it is identified by `group_tabs`
instead, and must never be captured by this match or the part would never
be released from the stock.

Not every template ships a feature operation. Confirmed against the two
real ones:

- `new router metal sheet` - has `Slot Cut for Features` (contour2d,
  `group_tabs=false`) **and** `Slot Cut for Edges` (contour2d,
  `group_tabs=true`, the outer release cut).
- `(DEPRECATED)971 Metal Sheet` (UNC Router) - has only `2D Slot Cut`, no
  feature operation, **deliberately**. One was added here and then removed
  again on direct instruction: feature slot cuts are for the New Router
  only. Do not re-add it to this template.

**Where a template has no feature operation, slots stay with the
through-shape operations exactly as before.** That keeps every such
template working unchanged rather than silently dropping its slots. Slots
are through-cuts either way, so they get the same depth handling.

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

The outer release operation follows the **same rule** - it is not a special
case, and no longer hard-codes a direction. It was the last selection in
the file still asserting `isReverted = True` for every part, and that was
confirmed live as wrong: on a job where every other operation's arrow was
correct, the outer `2D Slot Cut` was the only one reversed.

One formula covers outer and inner loops because the difference is already
in the geometry: Fusion winds an **outer loop counter-clockwise and an
inner loop clockwise**, so the opposite handedness an outer release cut
needs - tool outside the part, not inside the cutout - falls out of the
loop's own co-edge ordering. Reading it makes the result correct per part
rather than correct for whichever part it was last tuned against.

Direction still matters here for a specific, confirmed reason: wound the
wrong way against this operation's `left` compensation, the tool offsets
INWARD toward the part's interior features instead of outward into the
scrap. On a real part the edge-to-hole clearance was as little as 0.1495in
against a 0.1575in tool, so the offset direction is the only thing keeping
it from gouging. That requirement is unchanged - it is now satisfied by
reading the geometry instead of asserting one answer.

**There is no hard-coded chain direction anywhere in `DeleteToolpaths.py`.**
If a new selection is added, derive its direction the same way; do not
copy a literal `True`/`False` from a working operation, because the value
that happens to be right for one part's winding is wrong for another's.

The outer operation is still separate in the ways that genuinely differ:
it is the only one that carries tabs, and it selects the full outer-loop
edge list rather than a single seed edge.

## Posting: one program per setup, not one per operation

`NewNCProgram.py`'s `export()` posts the **whole setup** in a single
`cam.postProcess(setup, ...)` call, producing one `.ngc` per job.

It used to post each operation separately, bucketed into
Drills/Pocket/Profile and sorted by tool diameter. A single-part plate came
back as **7 files** the operator had to load and run in the right order by
hand.

Posting the setup as a unit is both simpler and safer:

- **Ordering is preserved by construction.** Fusion emits operations in
  CAM-browser order, which is already the correct machining order - and
  that ordering is not incidental: the template puts the outer
  `2D Slot Cut` **last** precisely so the part isn't released from the
  stock until every internal feature has been cut. The old code had to
  re-derive that ordering by bucketing and sorting.
- **Tool changes are Fusion's job.** One program with proper tool-change
  codes between operations, rather than one file per tool.
- **It removes a real data-loss bug.** Two operations sharing a tool could
  generate the identical program name and silently overwrite each other's
  file on disk - an entire operation's G-code lost while the job still
  reported success. With one program per setup there is no name to collide.

The program is named from the job, sanitized by `_safe_program_name` to
letters/digits/dash/underscore and capped at 60 characters, since job names
are free text that can carry spaces, slashes and colons. A second setup
(rare) gets a `-N` suffix so it cannot overwrite the first.

Verified on a real job: 1 file, 708 lines, one `M30`, one tool change, all
7 operations present in template order with `2D SLOT CUT` last.

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
selection, but tab *placement* has its own rules, in `TabPlacement.py`.
The final `tabPositions` value is a `CadPoints` collection: the runner turns
each vetted edge into a midpoint `SketchPoint` on the release face before
assigning it. Do not assign `BRepEdge` objects to `tabPositions`; Fusion can
display those references but cannot consistently resolve a location along
their chain. Three placement rules apply, in order:

1. **How many.** `_tab_count_for_perimeter` scales the count to the part's
   own perimeter (roughly one per `TARGET_TAB_SPACING_IN`), floored at
   `min_tabs` and capped at `max_tabs` using the established nearest-spacing
   rule.
2. **Which sides.** One tab per distinct straight side, **longest side
   first**, capped at that count. This is not "one per side unconditionally"
   - an earlier version was, and on a real teardrop bracket it put a tab on
   every one of its short bottom facets. Longest-first is what makes the cap
   land on the long structural sides instead.
3. **Minimum side length.** The normal threshold remains tied to `1.25` tab
   widths, preserving lead-in and lead-out room. If no edge reaches that
   threshold, the legacy fallback still supplies outer-edge candidates
   instead of silently producing an unheld release contour.
4. **Stock preference and fallback.** Backed sides are preferred when setup
   stock bounds are readable. When they are not, the runner uses the prior
   straight-edge fallback so manual tabs remain present.

### Tab points must lie on the contour being cut

**This is the one that silently breaks everything else above.** A manual tab
is not a free-floating position: Fusion places it on the selected contour,
so a tab point that is not part of that contour cannot be placed and is
dropped without a warning.

Tab edges therefore come from the same face the release contour does - the
bottom face (`_find_tab_face`, matching `DeleteToolpaths._bottom_face`) -
and `_manual_tab_points` creates hidden midpoint SketchPoints in the setup's
root component using that face proxy. The selected occurrence edges are
already in the arranged root coordinate frame; do not convert them back to
native component coordinates or proxy the points afterward.

An earlier version deliberately took them from the **top** face, on the
theory that tabs and their contour were independent edge loops. They are
not. Measured on a real job's own operation:

| | tempIds | Z |
|---|---|---|
| Manual tab edges | 478, 482, 486, 490 | 0.0in (top face) |
| Contour edges | 741-748 | -0.0625in (bottom face) |
| **Intersection** | **none** | |

and for the same body, top-face outer loop `478,480..492` had **0 of 8**
edges on the contour while bottom-face outer loop `741..748` had **8 of 8**.
The bottom face's outer loop *is* the contour, exactly.

### Stock-backing fallback

The runner prefers an edge with surrounding stock when Fusion exposes usable
stock bounds. The compatibility behavior intentionally falls back to the
previous straight-edge selection when those bounds are unavailable or do not
yield a candidate, because a release contour with no manual tabs is worse
than preserving the known working tab configuration. A line only gains an
extra tab when it genuinely has spare length at the established spacing; it
can stop
short of the requested count on a small part with no more room, which is
correct: a crowded tab is worse than one fewer.

`(edge, fraction)` is therefore the real return type of `select_tab_edges`
and the real input type of `_manual_tab_points` - not bare edges. `fraction`
is 0.5 for the ordinary single-tab-per-side case (so this is a strict
superset of the old behavior, not a rewrite of it) and something else only
when more than one tab shares an edge.

### Manual-only mode must use parameter values, not expressions

Fusion's `tabPositioning` and `tabsPerContour` are discrete CAM values.
Setting their `expression` strings can appear to work while retaining the
template's distance placement, which was the cause of a real training-part
result with tabs only on the top/right edges. Configure manual-only tabs in
this order:

1. `group_tabs.value.value = True`
2. `tabPositioning.value.value = 'tabCount'`
3. `tabsPerContour.value.value = 0`
4. `tabPositions.value.value = [SketchPoint, ...]`

`'points'` is not a valid `tabPositioning` value. The explicit
`SketchPoint`s select locations; `tabCount` plus zero automatic tabs ensures
that those locations, rather than the template's fallback distance tabs,
are what the release contour machines.

### Tab height must fit the stock

`tabHeight` is the material deliberately left at each tab. A fixed `0.15in`
height is valid on common quarter-inch plate but impossible on `0.063in`
sheet. The runner therefore uses one height for every tab in a job: the
requested `0.15in` maximum, capped at 70% of the thinnest nested body.

The same job-wide sizing rule applies to width. The default is `0.6in`, but
the runner caps it to 45% of the narrowest nested part's planar span (with a
`0.2in` cutter-stability floor). Selection then uses that calculated width to
require a real tab plus lead-in/lead-out before choosing a straight side.
Every tab on the setup therefore has the same valid geometry instead of
forcing the default dimensions onto a part that cannot contain them.

Two invariants worth preserving if this is touched:

- **A side with real stock somewhere along it is never disqualified over
  where exactly a candidate segment sits within it.** Backing still decides
  *which segment* of a genuinely-backed side carries the tab. It is only a
  side with **zero** backing anywhere - not merely a less-than-ideal
  segment - that gets excluded (see above).
- **A part is never left with zero tabs.** If no side clears the length
  threshold, `select_tab_edges` falls back to the part's longest sides
  anyway - a tight tab beats a part coming loose mid-cut. Redistribution and
  the last-resort segment fallback both apply the same length threshold, so
  neither can quietly put a tab back on a short facet or a curved edge.

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
- The chain direction arrow is correct in Fusion's own UI **on every
  operation, including `2D Slot Cut`** - `isReverted` alone doesn't prove
  this; it just proves the code isn't hardcoding one value. The outer cut
  was historically the one that got missed here.
- **The job produced exactly one `.ngc`.** More than one means the setup is
  being posted per-operation again.
- Simulate before posting and verify the tool stays in the intended cutout,
  not the retained material, and that a blind pocket actually stops at its
  floor rather than cutting through.

### A known trap when testing

Editing a file under `autocam/fusion/runner/` and copying it into the live
add-in folder does **not** affect the running Fusion process - Python does
not re-read a module once imported. A job queued after such a copy still
runs the old code, and the result looks like the fix failed.

This has cost real debugging time more than once. **Fully quit and relaunch
Fusion** before trusting a test run. A quick way to tell which code
actually ran: the old per-operation posting names files `S1575Profile1.ngc`
and so on, while the current code names the single program after the job.

### Unit tests

`tests/test_contour_chains.py` protects the pure direction mapping,
`tests/test_pocket_orientation.py` the blind-vs-through decision,
`tests/test_tab_placement.py` the tab-per-side guarantee, and
`tests/test_nc_program_naming.py` the program-name sanitizing - all without
requiring Fusion. A live Fusion run remains required for actual CAM
behavior; none of these can catch a Fusion-side identity, recognition, or
posting failure like the ones documented above.
