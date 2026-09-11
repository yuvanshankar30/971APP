# Fusion Box-Tube CAM

The Fusion Runner treats a rectangular box tube as four separate router
fixtures. It does not have a rotary axis and must not post one program that
tries to cut every wall without an operator turn.

Everything below describes `commands/HandleTube.py` as verified live against
the reviewed manual tube setup (`P006482_Rev_Side Drivetrain Tube Mirror`,
see [Validation](#validation)). Plate jobs never reach this code.

## Workflow

`camTube.py` imports one box-tube STEP body, uses the reviewed
`Tubestock(with Cutter Comp).f3dhsm-template`, and calls `HandleTube.py`.
The handler derives the tube's long axis from its longest straight edge,
finds both pairs of exterior planar walls from their centroid extrema, and
creates one setup for each wall. This is intentionally independent of a
nominal 1x2 or 2x1 cross-section; inner wall faces and end caps are excluded.

The setups are fixture-labelled in this order:

1. `Tube Side 12`
2. `Tube Side 3`
3. `Tube Side 6`
4. `Tube Side 9`

Each setup applies the template, then rebinds every operation to the wall it
machines. An operation with no matching geometry is deleted before generation,
so a stale selection stored in the template can never machine a different
tube wall.

## WCS and work offset

Every tube setup uses the same frame, matching the reviewed setup:

- **Orientation: X & Y axes.** Z is the machined wall's outward normal.
- **X runs along the tube**, pointing out of the origin end. **Y = Z x X**
  runs across the wall.
- **Origin: the right-hand top corner of the machined wall at the origin end**,
  so X and Y both point away from the stock - the whole tube sits at X <= 0,
  Y <= 0, Z <= 0.
- All four setups share one origin end (the same physical end of the tube), so
  the operator turns the tube about its length between programs, never end
  for end.
- **Work offset: G55** (`job_workOffset = 2`), never the plate jobs' G54.

The frame is the only outward-facing one whose origin is the right-hand
corner, so the queue dialog's horizontal/vertical choice is ignored for tube
jobs. The pure axis rule lives in `TubeWcsMath.tube_wcs_axes`. The code checks
the axes against the WCS Fusion actually computes (flipping an axis selection
if needed), and finds the origin by trying each top corner and keeping the one
furthest along +X and +Y (`TubeWcsMath.pick_origin_corner`), rather than
assuming Fusion's box-point numbering. It fails the job rather than zero on an
ambiguous corner.

## Holes

Round holes use Bore, selected from each hole's actual cylindrical wall face
rather than the tube's planar exterior face. The reviewed Bore has
`selectSameDiameter` on, which extends a selection only to holes of the
**same diameter** as a selected one. So the Bore gets one whole representative
hole **per distinct diameter** on that wall (for example 0.196" and 0.375", or
0.196" and 0.201"). That covers every hole while keeping the explicit
selection tiny; passing every hole on the tube destabilized Fusion's geometry
binding. The separate `>.3 Circular Through Hole` pocket operation is removed:
Bore owns every round through hole.

## Non-round features

Every non-round closed feature uses Shape Through roughing plus its finishing
contour; 2D Slot Cut is removed because its centerline-style behavior is wrong
for closed tube cutouts. Shape Through chains come from the wall's paired
interior (material-bottom) face, not the exterior face the WCS sits on; an
exterior-face loop made adaptive clear the whole wall. Each closed chain takes
its direction from its own BRep coedge topology and retries the inverse only
when Fusion rejects it.

## Tube cutoff

Every tube template ships a `Tube Cutoff` 2D contour, and every setup gets one:

- **Geometry:** the single edge where the machined wall meets the **far end
  cap** - the end opposite the WCS origin - as an **open** chain.
- **Direction:** follows the far end cap's own coedge, so with the template's
  left compensation the tool always runs just past the end of the part, never
  inside it.
- **Length:** pulled back **0.16"** from each end of the edge (chain start/end
  extension -0.16"), exactly as the reviewed setup does. On a 2" wall the cut
  runs Y-0.16 to -1.84; on a 1" wall, Y-0.16 to -0.84.
- **Depth:** the wall thickness plus 0.02" (the template cutoff's own
  breakthrough) - Z-0.145 on a 0.125" wall.

Because every side stops 0.16" short of both corners, **the four corners are
never cut from any side**: they hold the part to the stock like tabs. Plan to
break or saw them free after the last side.

A wall whose far-end edge is split into several STEP edges fails the job with
a clear error instead of guessing a multi-edge chain; only the single-edge case
is verified.

## Depth

Each kept feature operation is limited to the thickness of its near wall plus
a small breakthrough allowance (0.05" for holes and shapes, 0.02" for the
cutoff). The wall measurement clusters coplanar STEP-split faces before pairing
exterior and interior planes, so a hole or notch cannot make a wall appear to
have zero thickness. The tool never crosses the hollow section into the far
wall.

## Output Contract

`NewNCProgram.export` receives the four setup names explicitly and posts one
file for each setup with surviving operations:

```text
Tube<box-tube-id>Job<job-id>-side-12.ngc
Tube<box-tube-id>Job<job-id>-side-3.ngc
Tube<box-tube-id>Job<job-id>-side-6.ngc
Tube<box-tube-id>Job<job-id>-side-9.ngc
```

Every side has at least its cutoff, so in practice all four programs post. The
runner rejects a partial result when the number of posted files does not match
the number of active setups.

## Running a tube job

1. Label the physical tube 12 / 3 / 6 / 9 to match the four programs.
2. Clamp the named side up, with the tube's origin end at the fixture's zero.
3. Zero **G55** on the right-hand top corner of that wall at the origin end
   (X along the tube, Y across it, both pointing away from the stock).
4. Run the program, then turn the tube about its length to the next side and
   touch off Z again. Never flip it end for end.
5. After the last side, break the four corner tabs to free the part.

## Validation

Pure rules have unit tests: `tests/test_tube_wcs_math.py` (the WCS frame and
origin corner, against the reviewed setup's real axes),
`tests/test_tube_height_math.py` (feature and cutoff depths), and
`tests/test_tube_face_programs.py` (naming plus the handler's selection rules).

The Fusion selection API is runtime-only, so tube changes are verified live
through the Fusion MCP against the reviewed manual setup: export its tube to
STEP, import it into a scratch document, run the branch's `handleTube` on the
real template, post every setup with the router post, and compare each program
with the reference's own post hole by hole (cutoff X/Y extent, depth, work
offset). The last such run matched on all four sides:

| Runner side | Reference setup | Holes | Cutoff Y | Depth | Offset |
|---|---|---|---|---|---|
| 12 | 6 | 55 / 55 | -0.16 to -1.84 | -0.145 | G55 |
| 3 | 3 | 32 / 32 | -0.16 to -0.84 | -0.145 | G55 |
| 6 | 12 | 55 / 55 | -0.16 to -1.84 | -0.145 | G55 |
| 9 | 9 | 32 / 32 | -0.16 to -0.84 | -0.145 | G55 |

Fusion API behaviors this caught, each now pinned by a test:

- An open chain must be seeded with **one edge assigned before `isOpen`**;
  handing Fusion `[edge, edge]` or setting `isOpen` first silently closes the
  chain around the whole face.
- A fixed `isReverted` put the cutoff tool **inside** the part on two of four
  sides; the direction must follow the far end cap's coedge.
- `ChainSelection` extension lengths are **millimetres** even in an inch
  document (-4.064 mm = -0.16").

For a new template, tool, or fixture, repeat that comparison and simulate each
setup before cutting.
