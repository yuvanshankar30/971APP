# Fusion Box-Tube CAM

The Fusion Runner treats a rectangular box tube as four separate router
fixtures. It does not have a rotary axis and must not post one program that
tries to cut every wall without an operator turn.

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

The template selections are replaced on each wall. Round holes use Bore,
selected from each hole's actual cylindrical wall face rather than the tube's
planar exterior face. Every non-round closed feature uses Shape Through
roughing plus its finishing contour; 2D Slot Cut is removed because its
centerline-style behavior is wrong for closed tube cutouts. An operation with
no matching geometry is deleted before generation, so a stale selection stored
in the template can never machine a different tube wall.

Each kept operation is limited to the thickness of its near wall plus the
template's small breakthrough allowance. The wall measurement clusters
coplanar STEP-split faces before pairing exterior and interior planes, so a
hole or notch cannot make a wall appear to have zero thickness. The tool never
crosses the hollow section into the far wall.

The reviewed template also contains a `Tube Cutoff` operation. It stays
deliberately disabled until the Fusion box-tube job payload carries an explicit
finished length and fixture side; until then a template-source cutoff is unsafe
and is never inherited.

## Output Contract

`NewNCProgram.export` receives the four setup names explicitly and posts one
file for each setup with surviving operations:

```text
Tube<box-tube-id>Job<job-id>-side-12.ngc
Tube<box-tube-id>Job<job-id>-side-3.ngc
Tube<box-tube-id>Job<job-id>-side-6.ngc
Tube<box-tube-id>Job<job-id>-side-9.ngc
```

All four setups remain in the Fusion document even when a side has no feature;
that side simply has no NC artifact. The runner rejects a partial result when
the number of posted files does not match the number of active setups. Before
running, label the physical tube to match the posted fixture programs, clamp
the named side up, and touch off Z again after every turn.

## Validation

The pure naming contract is covered by
`tests/test_tube_face_programs.py`. The geometry and Fusion selection API are
runtime-only, so a real Fusion validation remains required for each new
template/tool/fixture combination: confirm all four setups use the intended
wall, simulate each active one independently, confirm a feature stops just
inside its near wall, and verify every posted artifact has the matching side
name.
