# 3D routing toolpath simulation — TODO

Live checklist. The *why* behind each decision lives in
[`toolpath-simulation-plan.md`](toolpath-simulation-plan.md); this file is the
running state of the work.

**Scope:** the shared path renderer and playback controls support routing and
turning. Routing's material-removal is a heightmap (2.5D - exact for a flat
end mill on flat stock); turning's is a 1D radius-per-axial-position profile
revolved into a solid (exact for a solid of revolution) - see each function's
own doc comment in `toolpathPreview.js`.

**Status (2026-08-31):** Phases 0, 1, 3, 4, and 6 complete, for both routing
and turning. Phase 2 has move-class rendering and the Toolpath/Tool/Stock
visibility toggles; per-tool colour mode and a "Model" toggle (that one needs
Phase 5) remain open. Phase 5 (load and show the source STEP geometry
alongside the simulated stock, plus gouge detection) has not been started -
the real remaining gap. Phase 7 hasn't had a dedicated, recorded measurement
pass, though the implementation already uses typed arrays throughout and
disposes geometries/materials/the renderer on destroy.

---

## Phase 0 — Parser: keep Z, tessellate arcs ✅

- [x] `parseToolpath3D()` returning `{x,y,z}` moves
- [x] Move classification — `rapid` / `cut` / `ramp` (Fusion's scheme)
- [x] Cumulative distance per move, for distance-based scrubbing
- [x] Tool-change indices, for Fusion's *next operation* control
- [x] Tessellate G02/G03 — I/J form, R form, sagitta-derived segment count
- [x] **Full-circle arcs** (start == end) — what routing emits for every hole
- [x] Helical Z interpolation through arcs
- [x] Modal motion, G90/G91
- [x] `toolpathBounds3D()` for camera framing
- [x] 31 tests, including against `routing.js`'s real generated output
- [x] **Fixes a live bug:** the 2D preview was silently omitting every arc

> ⚠️ This visibly changes an existing screen — the 2D preview now shows arc
> geometry it previously left out.

**Deferred from this phase:** G17/G18/G19 plane selection. Routing only ever
cuts in XY and `routing.js` doesn't emit G18/G19, so supporting them now would
be untestable speculation. Revisit only if a generator starts emitting them.

---

## Phase 1 — 3D scene scaffold

New: `autocam/components/ToolpathSimulator.svelte`

- [x] three.js scene, camera, `OrbitControls` — dynamic imports, mirroring
      `CadViewer.svelte` so it stays out of the SSR bundle
- [x] Resize observer; dispose geometries/materials/renderer on destroy
- [x] Machine axes indicator and ground grid
- [x] Frame the camera from `toolpathBounds3D()`
- [x] Routing-only 3D view is available beside the 2D preview in AutoCAM
      is layered on

---

## Phase 2 — Toolpath in 3D

- [x] `LineSegments` per move class, coloured on Fusion's scheme
      (rapid / cut / ramp)
- [ ] Second colour mode: per-tool, via the existing `toolIndex`
- [ ] Independent **Toolpath** / **Tool** / **Stock** / **Model** visibility
      toggles, matching Fusion's Simulate dialog
- [x] Build geometry once into typed arrays, not per-frame

---

## Phase 3 — The end mill, and moving it

- [x] Flat end mill as a cylinder — **diameter from the job's `toolDiameter`,
      or the active entry in `toolSequence`.** Never a hardcoded default; falls
      back to a user input when a job has no saved tool
- [x] Scrub bar over **cumulative distance**, not move index
- [x] Fusion's four transport controls: play, next move, **next operation**
      (mapped to `(TOOL CHANGE:)` markers), end of toolpath
- [x] Speed selector
- [x] Tool position interpolated within the current move

---

## Phase 4 — Material removal (the real work) ✅

Routing (heightmap) and turning (radius profile) both done - see
`buildRoutingHeightmap()` / `buildTurningStockProfile()` +
`turningProfileToLathePoints()` in `toolpathPreview.js`, wired into
`ToolpathSimulator.svelte`'s `updateStock()`.

- [x] Routing: heightmap sized to the stock (toolpath XY bounds + margin);
      resolution adaptive (smallest active tool spans ~6 cells), capped at
      160 cells/axis
- [x] Routing: top Z from the program's own Z=0 convention; floor Z a bit
      below the deepest programmed cut (no real stock-thickness param exists
      today, so this is "safely into the spoilboard," not a measurement)
- [x] Routing: lowers cells within the cutter radius of each **swept
      segment**, not point sampling
- [x] Turning: exact 1D radius-per-axial profile (outer + inner/bore),
      revolved into a `THREE.LatheGeometry` - not an approximation, a solid
      of revolution's whole state at any instant *is* that profile
- [x] Turning: bore cuts detected as centerline moves, matching exactly how
      `appendDrillingOperation` emits every drilling G01
- [x] Both: rebuilt fresh from the full executed-move list on every playback
      position change, not incrementally checkpointed - simpler, and
      measured fast enough in practice (see Phase 7 note) that the planned
      incremental/checkpoint optimization wasn't needed
- [x] Verified against real generated G-code in both `toolpathPreview.test.js`
      suites, and manually in-browser against real jobs run through
      `/api/cam-generate`

**Known gap, not covered by this phase:** hex turning stock's *uncut*
regions render as a circle at the across-corners radius, not the true
hexagonal cross-section (a hex prism isn't representable in a single
radius-per-z profile) - converges to the exact turned shape the moment any
material is removed there. Documented in `buildTurningStockProfile`'s own
comment.

---

## Phase 5 — Show the part

- [ ] **Extract** `CadViewer.svelte`'s `occt-import-js` STEP loader into a
      shared helper — one implementation, not a second copy
- [ ] Load the job's source geometry and display it against the simulated stock
- [ ] Semi-transparent, toggleable
- [ ] *Follow-up once this lands:* gouge detection — flag any move that removes
      material below the finished surface. The one honest subset of Fusion's
      collision check available to us

---

## Phase 6 — Integration ✅

- [x] Mounted beside the existing 2D preview (`2D Preview` / `3D Toolpath`
      tabs) in `autocam/+page.svelte`
- [x] Both routing and turning jobs get the 3D view now (tube-stock jobs
      keep the 2D-only viewer - see "Explicitly not doing")
- [x] Responsive layout (`.simulator-controls` wraps, mobile breakpoints in
      `ToolpathSimulator.svelte`'s own `<style>`)

---

## Phase 7 — Performance and correctness

- [ ] Measure a real multi-tool program end to end; record the numbers here
- [ ] Typed arrays throughout; no per-frame allocation
- [ ] Confirm no leaked WebGL contexts across mount/unmount cycles
- [ ] Render and eyeball at desktop and laptop widths

---

## Turning simulator ✅

- [x] Reuse the routing simulator's modal, tabs, move colours, visibility
      controls, scrubber, playback speed, move stepping, operation stepping,
      and camera reset
- [x] Convert Haas diameter-mode X to radius and machine Z to the spindle axis
- [x] Recompute playback distance after projection instead of using doubled
      diameter-mode radial distances
- [x] Render the real machined solid from the job's saved `stockDiameter`/
      `stockShape` - not just a static cylinder, see Phase 4
- [x] Rotate the workpiece during playback and translate a proportional turning
      insert through the X/Z path (the insert itself does not spin on a lathe)
- [x] Preserve finish-insert tool-change stepping
- [x] Automatic-tool-changer (Haas TL-1 turret) tool changes, skipping the
      manual M00 pause when `automaticToolChanger` is set
- [x] Hex stock shape (across-flats sizing, across-corners clearance)
- [x] Centerline drilling, rendered as a real bore once cut

## Explicitly not doing

| | Why |
|---|---|
| Tube-stock simulation | Different rotary-axis machine model and tool orientation |
| Holder & fixture collision | We model neither, so claiming Fusion's collision check would be false |
| Machining-time estimate | Needs acceleration modelling; a naive distance÷feed number would be confidently wrong |
| Ball-nose / V-bit profiles | Routing only generates flat end mill paths today |

---

## Open questions

- ~~**Stock dimensions.**~~ Resolved: routing has no real stock-size param
  today, so the heightmap uses the toolpath's own XY bounds + a margin
  instead of asking the UI for one - see Phase 4's "known gap" note. Revisit
  if a real stock-dimensions param gets added later.
- **Program size.** Not formally measured/recorded (Phase 7 still open on
  that specifically), but verified interactively against real generated
  jobs (a routing pocket job, a turning shaft job) with no perceptible lag
  scrubbing or during playback - full rebuild per position, no incremental
  checkpointing, turned out to be fast enough in practice.
- **Lead-in/out colouring.** `routing.js` has a lead-in/out zone but doesn't
  mark it in the output, so those moves read as ordinary cuts. Worth emitting a
  marker for full Fusion colour parity — a generator change, not a viewer one.
- **Phase 5 (show the part) is the one real remaining gap.** Everything else
  through Phase 4 and Phase 6 is done for both operations.
