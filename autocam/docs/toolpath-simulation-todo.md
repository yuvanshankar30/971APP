# 3D routing toolpath simulation — TODO

Live checklist. The *why* behind each decision lives in
[`toolpath-simulation-plan.md`](toolpath-simulation-plan.md); this file is the
running state of the work.

**Scope:** routing only. Turning is out — its stock is a solid of revolution
and a Z-up heightmap cannot represent it.

**Status:** Phases 0–1 complete. Phase 2 has move-class rendering; the
per-tool and remaining Fusion visibility controls remain open. Phase 3 is
complete. Phases 4–7 are open.

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

## Phase 4 — Material removal (the real work)

- [ ] Heightmap sized to the stock; resolution adaptive to stock size with a
      ceiling, defaulting fine enough that the smallest tool spans several cells
- [ ] Initial height from the job's material thickness / `targetDepth`, with an
      input fallback
- [ ] Lower cells within the cutter radius of each **swept segment** — sweeping,
      not point sampling, or fast moves leave uncut gaps
- [ ] Mesh from the heightmap, updated incrementally over the dirty region only
- [ ] Checkpoint every N moves so scrubbing backwards doesn't replay from zero
- [ ] Verify the final heightmap matches the intended part depth

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

## Phase 6 — Integration

- [ ] Mount beside the existing 2D preview in `autocam/+page.svelte` and
      `manufacture/+page.svelte` — a tab or toggle, never a replacement
- [ ] Non-routing jobs keep the current 2D viewer
- [ ] Responsive; usable on a shop laptop, not only a desktop

---

## Phase 7 — Performance and correctness

- [ ] Measure a real multi-tool program end to end; record the numbers here
- [ ] Typed arrays throughout; no per-frame allocation
- [ ] Confirm no leaked WebGL contexts across mount/unmount cycles
- [ ] Render and eyeball at desktop and laptop widths

---

## Explicitly not doing

| | Why |
|---|---|
| Turning / tube-stock simulation | Different stock representation; a heightmap can't model a solid of revolution |
| Holder & fixture collision | We model neither, so claiming Fusion's collision check would be false |
| Machining-time estimate | Needs acceleration modelling; a naive distance÷feed number would be confidently wrong |
| Ball-nose / V-bit profiles | Routing only generates flat end mill paths today |

---

## Open questions

- **Stock dimensions.** Phase 4 needs stock extents. Available from the job's
  params, or does the UI need to ask? Resolve before starting Phase 4.
- **Program size.** Unmeasured. Phase 7 assumes it matters; measure a real
  multi-tool program early enough that Phase 4's design can react to it.
- **Lead-in/out colouring.** `routing.js` has a lead-in/out zone but doesn't
  mark it in the output, so those moves read as ordinary cuts. Worth emitting a
  marker for full Fusion colour parity — a generator change, not a viewer one.
