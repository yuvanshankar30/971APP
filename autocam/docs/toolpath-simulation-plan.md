# 3D toolpath simulation for routing — implementation plan

A Fusion-style simulation for AutoCAM **routing** jobs: the stock on screen,
the end mill moving along the real toolpath, and material disappearing as it
cuts. Scoped to routing only — turning is explicitly out (see
[Why routing only](#why-routing-only)).

Everything below was checked against the current code rather than assumed; the
"what already exists" section is the reason this is smaller than it sounds, and
the "what will bite" section is the reason it is not small.

---

## What already exists

| Piece | Where | Reusable? |
|---|---|---|
| three.js `^0.184.0` | `package.json` | Yes — already a dependency |
| three.js scene + `OrbitControls`, dynamically imported | `src/lib/components/CadViewer.svelte` | Yes — copy the setup shape |
| STEP → `THREE.BufferGeometry` client-side via `occt-import-js` (WASM) | `CadViewer.svelte:47-88` | **Yes — this is the "show the part" half, already solved** |
| STL loading from Onshape | `CadViewer.svelte:34` | Yes |
| G-code → line segments parser | `autocam/toolpathPreview.js` | Partially — see below |
| 2D SVG toolpath preview | `autocam/components/ToolpathViewer.svelte` | Keep as-is; the 3D view is additive |
| Tool geometry per job | `generateRoutingGcode(contours, params)` — `params.toolDiameter`, or `params.toolSequence[] = { toolDiameter, toolNumber, label }` | Yes |
| Tool-change markers in output | `(TOOL CHANGE: ...)` comment lines | Yes — the parser already counts these into `toolIndex` |

Mount points for the new view: `src/routes/autocam/+page.svelte:1397` and
`src/routes/manufacture/+page.svelte:2755`, where `ToolpathViewer` is used today.

---

## What will bite

Three things that look like details and are not.

### 1. The existing parser throws away Z, and ignores arcs

`toolpathPreview.js` tracks `x/y/z` but `toPoint()` returns only `{a, b}` —
for routing that is `{x, y}`, so **Z is discarded**. A 3D view needs it.

Worse: its own header says *"no arcs (G02/G03)"*, but `routing.js` **does emit
them** — helical entry and true circular contours (`routing.js:87`, `:652`).
Today those lines simply produce no segment, so the existing 2D preview is
silently missing geometry wherever a hole or circular profile is cut. The 3D
work has to tessellate arcs, and doing so fixes the 2D preview as a
side effect.

This is why Phase 0 is a shared parser upgrade rather than something bolted
onto the 3D component.

### 2. Material removal wants a heightmap, not CSG

Three ways to show material coming off:

- **Toolpath ribbon only** — no removal. Cheap, but it isn't what was asked
  for.
- **Heightmap** — stock as a grid of Z heights; each tool move lowers the
  cells inside the cutter radius. Cheap, GPU-friendly, and *exact* for this
  case.
- **CSG boolean** — subtract the swept tool volume from a solid. Correct in
  general, far too slow in a browser for a full program.

**Heightmap is the right answer here specifically because routing is 2.5D**:
flat plate stock, a vertical spindle, a flat end mill. Every cut is "lower the
material under a circle to depth Z". A heightmap represents that with no
approximation error. This is the same approach CAMotics and most browser CNC
simulators use.

That property is exactly what turning does *not* have, which is the honest
reason to scope it out rather than "we'll get to it".

### 3. Program size drives everything

A full routing program is thousands of moves, and the simulation has to stay
interactive while scrubbing. Two consequences baked into the plan below:
segments get flattened into typed arrays once (not objects per move), and the
heightmap is updated incrementally per move with the ability to replay to an
arbitrary time index without re-running from zero every frame.

Measure a real program's move count before tuning any of this — the plan
assumes it matters, but not by how much.

---

## Why routing only

Turning needs a different representation entirely: the stock is a solid of
revolution and the tool profile sweeps a 2D silhouette, so a Z-up heightmap
does not model it. Trying to make one component do both is what would make
this large-and-messy instead of large-and-tractable. `operationType` is already
threaded through the existing viewer, so the 3D view simply declines anything
that is not routing and falls back to the current 2D preview.

---

## Fusion parity — what we are actually matching

Checked against Autodesk's own docs and Fusion CAM guides rather than memory,
so the target is the real feature and not an impression of it.

**Display toggles** — Fusion's Simulate dialog exposes independent checkboxes
for **Tool**, **Toolpath**, and **Stock** (plus model visibility). We match all
four.

**Toolpath colour by move type.** Fusion colours moves by what they are, not
by tool: Yellow = rapid, Blue = cutting, Red = ramp, Green = lead in/out, Gold
= stay-down. What AutoCAM can honestly detect from its own output:

| Fusion | Detectable here? |
|---|---|
| Rapid (yellow) | Yes — `G0` |
| Cutting (blue) | Yes — `G1/G2/G3` at depth |
| Ramp (red) | Yes — Z changing during XY motion; `routing.js` emits helical entry |
| Lead in/out (green) | Partly — `routing.js` has a lead-in/out zone near corners, but it is not marked in the output. Treated as cutting unless we add a marker. |
| Stay-down (gold) | Not applicable to what this generator emits |

Colour-by-tool stays available as a *separate* mode, since multi-tool routing
jobs are common here and Fusion's own per-operation stepping covers the same
need.

**Playback controls.** Fusion has Play, *go to next move*, *go to next
operation*, *go to end*, and a speed slider. Ours maps operation-stepping onto
the `(TOOL CHANGE: ...)` markers already in the G-code, which is the closest
real equivalent to a Fusion operation boundary.

**Collision.** Fusion turns the tool red on a collision. Full holder/fixture
collision detection is out of scope, but the heightmap gives us one honest
subset for free: flagging a move that removes material **below the finished
part surface** — i.e. a gouge — once Phase 5 has the part mesh. Anything
beyond that would be claiming more than we can check.

**Machining time.** Fusion estimates it. Ours would need acceleration
modelling to be anything but misleading, so the scrubber is distance-based and
we show distance, not a fake time. Called out here so it is a decision rather
than an omission.

## Phases

Each is independently mergeable and leaves the app working. Running state and
the tickable checklist live in
[`toolpath-simulation-todo.md`](toolpath-simulation-todo.md).

### Phase 0 — Shared parser: keep Z, tessellate arcs
`autocam/toolpathPreview.js`

- Add `parseToolpath3D(gcode)` returning full `{x, y, z}` moves with
  `rapid`, `toolIndex`, and cumulative distance.
- Tessellate `G02`/`G03` (I/J and R forms) into short segments; chord
  tolerance configurable, default fine enough that a 0.25" hole looks round.
- Handle modal motion (a bare `X.. Y..` line after `G1`) — already partly
  handled; keep it.
- Track `G20`/`G21` units and `G90`/`G91` absolute/incremental rather than
  assuming.
- **Fix the 2D preview too**: `parseGcodeToolpath` gains arc support via the
  same helper, since it is currently missing that geometry.

*Tests:* unit tests per G-code construct — arcs in both directions, R-form vs
I/J-form, full circles, modal lines, incremental mode, unit switches. This is
pure and fully testable with no 3D involved, which is why it goes first.

### Phase 1 — 3D scene scaffold
`autocam/components/ToolpathSimulator.svelte` (new)

- three.js scene, camera, `OrbitControls`, resize observer, teardown on
  destroy — mirror `CadViewer.svelte`'s dynamic-import shape so it stays out
  of the SSR bundle.
- Machine axes, a ground grid, and a bounding box from the parsed path.
- Renders nothing but empty space; proves setup and disposal.

### Phase 2 — Toolpath in 3D
- Moves classified by type (rapid / cutting / ramp) and coloured on Fusion's
  scheme, as separate `LineSegments` per class.
- Second colour mode: per-tool, using the existing `toolIndex`.
- Independent **Toolpath** / **Tool** / **Stock** / **Model** visibility
  toggles, matching Fusion's dialog.

### Phase 3 — The end mill, and moving it
- Flat end mill as a cylinder: **diameter from the job's `toolDiameter`, or
  the active tool in `toolSequence`** — never a hardcoded default. Where a job
  has no saved tool, the UI takes a diameter input and defaults from the
  job's stored params.
- Scrub bar over cumulative distance (not move index — constant-rate scrubbing
  reads far better), play/pause, speed slider.
- Fusion's four transport controls: play, **next move**, **next operation**
  (mapped to `(TOOL CHANGE:)` markers), **end of toolpath**.
- Tool position interpolated within the current move.

### Phase 4 — Material removal (the real work)
- Build a heightmap sized to the stock: XY resolution configurable, default
  chosen so a 0.125" tool spans several cells.
- Initial height = stock thickness, taken from the job's `targetDepth` /
  material thickness where available, otherwise an input.
- For each move, lower every cell within the cutter radius of the swept
  segment to that move's Z. Sweep, not point sampling, or fast moves leave
  gaps.
- Render as a mesh from the heightmap; update incrementally, only touching
  the dirty region per move.
- Scrubbing backwards replays from the nearest checkpoint rather than the
  start — checkpoint every N moves.

### Phase 5 — Show the part
- Load the job's source geometry with the **existing** `occt-import-js` STEP
  path from `CadViewer`, extracted into a shared helper so both components use
  one implementation rather than two copies.
- Display alongside/inside the simulated stock so the finished shape is
  visible against what the toolpath actually produces — this is what makes a
  gouge or a missed feature obvious.
- Semi-transparent, toggleable.

### Phase 6 — Integration
- Slot into `autocam/+page.svelte` and `manufacture/+page.svelte` beside the
  existing 2D preview, as a tab or toggle rather than a replacement.
- Non-routing jobs keep the current 2D viewer.
- Responsive; must be usable on a shop laptop, not only a desktop.

### Phase 7 — Performance and correctness pass
- Measure against a real multi-tool program; record the numbers in this doc.
- Flatten segments into typed arrays; avoid per-frame allocation.
- Dispose geometries/materials on destroy — a leaking WebGL context in a
  long-lived SPA is a real failure, and `CadViewer` already has the pattern.
- Verify the simulated final heightmap against the intended part depth.

---

## Deliberately out of scope

- Turning and tube-stock simulation (see above).
- Holder/fixture collision detection. Fusion checks tool *and holder* against
  part and fixtures; we model neither holder nor fixtures, so claiming it would
  be false. Gouge detection against the finished surface is the one subset the
  heightmap makes honest, and is listed as a Phase 5 follow-up rather than
  promised here.
- Machining-time estimation. Fusion reports it; doing so credibly needs
  acceleration modelling, and a naive distance/feed number would be confidently
  wrong on a program full of short moves. The scrubber shows distance.
- Ball-nose and V-bit profiles. Flat end mill only, matching what routing
  actually generates today.

---

## Risks

- **`occt-import-js` WASM cost.** Already paid by `CadViewer`, but loading it
  in a second place needs the shared-helper extraction in Phase 5, not a
  second copy.
- **Heightmap resolution vs memory.** A large sheet at a fine grid gets
  expensive quickly. Resolution must be adaptive to stock size, with a ceiling.
- **The parser fix changes existing 2D output.** Adding arcs will make the
  current preview show geometry it previously omitted. That is a fix, but it
  is a visible change to an existing screen and should be called out in the
  PR that does it.
