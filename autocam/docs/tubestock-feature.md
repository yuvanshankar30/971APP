# Tube stock CAM: indexed drilling for rectangular/square tube

A third pure-JS AutoCAM pipeline (`autocam/tubestock.js`, alongside `turning.js` and `routing.js`) for
drilling round holes into rectangular/square tube stock, plus the geometry extraction it depends on
(`extractTubeFeaturesFromMeshes` in `autocam/stepProfile.js`) - no Fusion 360 needed, same reasoning that
kept turning/routing Fusion-free: this operation is geometrically simple enough to hand-code directly.

Not to be confused with the existing Fusion-360-backed box-tube CAM path
(`autocam/fusion/runner/commands/HandleTube.py`) - that one does real 3-axis milling of arbitrary
features via a real CAM engine. This one targets a much narrower, well-defined operation: round holes
only, drilled straight through one wall at a time, on a router with an added rotary 4th axis.

## Scope, deliberately narrow

- **Axis-aligned rectangular/square tube only** - the STEP file's own X/Y/Z, not an arbitrary rotation
  (matches how turning's axis detection also tries X/Y/Z directly).
- **Round holes only.** A non-round feature (slot, keyway) is rejected with a clear message rather than
  averaged into a "close enough" round hole - the same rejection-over-guessing posture as the sprocket-teeth
  and bent-part checks elsewhere in this file.
- **One wall at a time.** A hole through both tube walls (a common real case - a bolt/pin passing all the
  way through) just shows up as two independent entries, one per wall, at the same length position - the
  generator drills each from its own wall's approach, not as one continuous plunge through the hollow interior.
- **No specific real machine confirmed.** Unlike `turning.js` (a real Haas TL-1) and `routing.js` (a real
  ShopSabre Pro 408), no such rotary-4th-axis router exists yet in this app's `cam_machines` data. The axis
  convention (X = tube length, A = rotary index 0/90/180/270deg, Z = plunge, Y = lateral offset across the
  current wall's width) is a reasonable, common setup - not a verified one. **Confirm the real machine's
  rotary center offset, A-axis direction, and Z=0 reference before running on material.**

## How extraction works

`extractTubeFeaturesFromMeshes(meshes)`:
1. Picks the tube's long axis (largest bounding-box span) and the two cross-section axes.
2. Finds the (up to) 4 flat side walls - real B-rep faces whose normal is perpendicular to the long axis,
   keeping only the largest-area candidate per direction (a chamfer or machining relief can also be flat
   and axis-aligned, but is never the real wall).
3. Traces each wall's own hole pattern exactly the way `extractRoutingContoursFromMeshes` traces a flat
   plate's holes - a hole is just an inner boundary loop of that wall's own face tessellation, not a
   separately-detected cylindrical surface. No new geometry-detection concept was needed here.
4. For each hole loop: position along the tube (`position`), lateral offset from the wall's own centerline
   (`lateralOffset`), and diameter (mean radius x2, rejecting anything whose radius varies more than 15%
   around its boundary as non-round).
5. Walls are assigned a rotary angle (0/90/180/270deg) from their outward normal direction and returned
   sorted; end caps (normal aligned with the long axis) are correctly excluded - they're not side walls.

## The lateralOffset bug (found by testing against a real AndyMark tube, not synthetic geometry)

The first version only tracked `position` (along the tube) per hole, not where across the wall's own width
it sat - reasonable for the synthetic test tube (one hole per position, centered) and for AndyMark's
narrower 0.5" square tube (only one hole fits across that width). Running the real `am-5180` 2"x1"
predrilled tube fixture through it immediately surfaced 3 holes reported at the *same* position on the wide
(2") face - a real side-by-side hole pattern (AndyMark's documented 1/2" grid of #10 clearance holes,
several columns wide on the wide face), not a duplicate. The generator would have driven the drill to the
exact same X/Y for all of them, redrilling one spot instead of the real holes.

Fixed by adding `lateralOffset` (signed distance from the wall's own centerline) to each hole and using it
as G-code Y instead of a hardcoded `Y0`. Verified against all 3 real AndyMark tube fixtures on hand,
including a dedicated synthetic regression test with two holes at known, distinct offsets.

## Real STEP fixtures added (`autocam/__fixtures__/`)

Downloaded directly from vendor sites (not synthetic) - AndyMark's public S3-hosted CAD downloads and REV
Robotics' `content/cad/` endpoint, both linked from their own public product pages:

| Fixture | Source | What it tests |
|---|---|---|
| `tube-05x05-square.step` | AndyMark am-5001-4700 | 4-wall predrilled 0.5" tube - baseline extraction + generation |
| `tube-2x1-wide-face.step` | AndyMark am-5180 | The file behind the `lateralOffset` fix - side-by-side holes on a wide face |
| `tube-2x1-two-walls.step` | AndyMark am-5644 | Only 2 of 4 walls drilled - confirms blank walls stay blank, not invented |
| `universal-motor-bracket.step` | REV-21-2804 | General FRC part, routing E2E (unrelated to tube stock) |
| `550-motor-plate.step` | REV-41-1607 | The real file behind an existing *synthetic-only* turning-rejection test - now confirmed on both the routing-accepts and turning-rejects paths with real geometry |
| `15mm-gearbox-motion-bracket.step` | REV-41-1315 | A second real bent/formed bracket (independent of `mounting-bracket-bent.step`) - confirms the bent-part thickness-rejection fix generalizes, not overfit to one file |

## UI wiring (`src/routes/autocam/`)

Tube stock is a third `operation_type` alongside `turning`/`routing`/`milling` (migration
`migrations/20260906_add_tubestock_operation_type.sql` widens the `cam_machines`/`cam_jobs` CHECK constraints). Reuses the
existing Machine Profile / New Job / job-detail UI end to end - operation toggle, param form
(`CamParamFields.svelte`: hole depth, safe height, feed rate, spindle speed), controller dialect
(reuses routing's LinuxCNC/WinCNC selector, since this targets the same class of machine), tool-plan
grouping by drill diameter.

**Scoped to standalone STEP upload only** - not linked to the parts/manufacturing-request system.
`parts.workflow` has no tube-stock value (`router`/`lathe` are the only two CAM-relevant ones), and adding
one would ripple through the whole manufacturing-request creation UI, Slack notifications, and admin
role checkboxes for a feature that doesn't need that integration to be genuinely useful - the same
boundary Fusion milling already draws (its own separate `/autocam/fusion` route, not this parts-linked flow).

**No 2D toolpath preview.** The existing `ToolpathViewer`/`parseGcodeToolpath` only understands 2D X/Y
(routing) or X/radius (turning) motion - it has no concept of the rotary A-axis. Rendering tube stock
G-code through it would silently overlay holes from different walls at the same 2D position (they share
X/Y coordinates; only A differs) - actively misleading, not just incomplete. The "View Toolpath" button is
disabled for tube stock jobs with an explanation; "View CAD" and "Open ncviewer.com" remain available.

## Verification

- 56 tests in `stepProfile.test.js` (extraction, including 3 real-tube-fixture tests) + 15 in
  `tubestock.test.js` (generation) - synthetic edge cases (multi-hole walls, non-round rejection, dialect
  differences, tool-change grouping) and real-fixture end-to-end runs.
- `npx vitest run` - all passing; `npm run build` - clean.
- Real end-to-end check against the actual running dev server (no Playwright available in this
  environment, so not a literal browser click-through): uploaded a real tube STEP file to Supabase
  Storage, created a real `tubestock` `cam_machines` row and `cam_jobs` row, signed in as the standing
  `DEV_TOOLS` test account, and POSTed to the real `/api/cam-generate` endpoint over HTTP - the same code
  path the UI calls, including auth/RLS. Result: job completed, 376 real holes across all 4 walls, valid
  G-code (53KB, ends in `M30`). Test rows/file cleaned up afterward.
