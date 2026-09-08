# ShopSabre calibration: tool swapping + countersinking implementation plan

**No code in this PR.** One data asset (the real tool library, see below) and this plan. Draft, not for merge.

## Relationship to the existing brainstorm doc

`autocam/docs/shopsabre-autocam-calibration.md` already exists on `main` (merged 2026-09-06, PR-less direct commit) and did real, verified research: confirmed New Router does tool changes and UNC Router physically cannot, confirmed the post-processor is already correctly wired, found the candidate tool library live in Fusion's cloud libraries, and listed six open questions. That doc is **not superseded** - it's the foundation this one builds on. This plan exists because:

1. The user has now supplied the actual tool library file (not just its cloud-library contents read via MCP), so it can be analyzed directly and imported.
2. Several of that doc's open questions now have real answers (below).
3. The user asked specifically for an *implementation* plan - UI for selecting loaded tools, a job-queueing algorithm for efficient tool-swap ordering, and the countersink template - not another round of brainstorming.

Read that doc first if you haven't. This one doesn't re-derive what it already confirmed.

## What's newly confirmed since that doc

### 1. The New Router very likely has a true automatic tool changer, not a manual carousel

That doc's open question #1 (the single biggest unknown) now has a real, sourced answer. From ShopSabre's own product page and third-party listings for the Pro 408 specifically:

- The PRO Series' "Well Equipped" base configuration **includes** a 6-position auto tool changer standard (5-6HP, ISO30 holders, ER32 collets) - not an aftermarket add-on on this line.
- Listings for this exact model (Pro 408) advertise ATC as a listed feature; some show 10-12 tool positions with HSD ATC packages at 24,000 RPM.
- The control is ShopSabre's WinCNC Advanced Controller - matches `cam_machines.controller = 'wincnc'`, already confirmed correct.
- ShopSabre also advertises "State-of-the-Art Tool Measure Technology" on this series - almost certainly automatic per-tool Z length measurement, which (per `toolchange-gcode-plan.md`'s own hazard analysis) is the fact that determines whether a re-touch-off is needed at all. If true here, **no manual re-touch-off, no `M00` pause** - the controller sets its own Z offset per tool.

None of this is a substitute for confirming the exact configuration of *this specific shop's unit* (position count varies 6-12 depending on what was ordered; tool measure could be uninstalled or uncalibrated). But it's real, sourced evidence pointing firmly at "true ATC, likely with auto tool-length-measurement," not the "manual swap" fallback branch.

Sources:
- [Professional CNC Router | PRO Series by ShopSabre CNC](https://www.shopsabre.com/cnc-routers/pro-series/)
- [5'x8' ShopSabre Pro 408 CNC Router, 2020 - ATC, Vacuum Table - Revelation Machinery](https://revelationmachinery.com/product/5x8-shopsabre-pro-408-cnc-router-2020-atc-vacuum-table-becker-vacuum-pump-grizzly-dust-collector-tooling-included/)
- [4' x 8' ShopSabre PRO 408 CNC Router, 2020 - Very Low Hours, Tool Changer - Revelation Machinery](https://revelationmachinery.com/product/4-x-8-shopsabre-pro-408-cnc-router-2020-very-low-hours-tool-changer-2/)

### 2. `_apply_tool_to_elem` already propagates `manual-tool-change` and tool `number` correctly - the older doc's claim here is now out of date

Checked directly against the current code (`autocam/fusion/runner/workflows/templateTools.py:583-593`):

```python
post = tool.get("post-process", {})
...
nc_node.set("manual-tool-change", _as_int01_str(post.get("manual-tool-change")))
nc_node.set("number", str(post.get("number", 1)))
```

Whatever a matched tool's own `post-process.manual-tool-change` / `post-process.number` say (straight from the `.tools` library JSON) is already written into the patched template's `<nc>` element, which is what the post-processor's `writeToolCall()` reads (`tool.manualToolChange`, `tool.number`) to decide `M0`-and-pause vs. a real tool-changer call, and which `T` number to call. **This machinery does not need to be built** - it needs a real multi-tool library wired up to exercise it, which is what this plan does next.

### 3. `useToolCall` ("Use tool changer") already defaults to `true` in `shopsabre.cps` and is never touched by any Python in this pipeline

Confirmed by direct read of `autocam/postprocessors/shopsabre.cps:76-83` and a repo-wide grep for `useToolCall`/`setProperty` in the Python pipeline (zero hits outside the `.cps` files themselves). The post's own default already allows a multi-tool program without raising the `"Having different tools in a single program is not allowed without a tool changer"` error (`shopsabre.cps:382-384`). Nothing needs to change here for a true-ATC machine. If confirmation (open question, below) comes back "actually manual carousel," this is the one property that would need to flip - and per-tool `manualToolChange` already handles the pause/comment either way, independent of this property.

## The real tool library - full analysis

**Imported into the repo this PR**: `autocam/fusion/runner/tools/Normal router tools (use this).tools` (from the user's Desktop, same file the earlier doc found live in Fusion's cloud libraries under the same name - "the leading candidate" is now the actual file). Same zip-of-`tools.json` format as the existing checked-in `971-outside-plate.tools`; parsed directly, not guessed.

| # | Description (verbatim, typos included) | Type | Diameter | Tool # | Manual change | RPM | Feed (in/min) | Coolant |
|---|---|---|---|---|---|---|---|---|
| 1 | `for tool changer` | flat end mill | 0.25in | **6** | false | 22,920 | 60 | mist |
| 2 | `4mm sized for toolchager` | flat end mill | 0.1575in (4mm) | **6** | false | 21,827 | 60 | mist |
| 3 | `6mm for toolchanger` | flat end mill | 0.2362in (6mm) | 2 | false | 14,553 | 100 | mist |
| 4 | `971 Main Bit` | flat end mill | 0.1575in | 1 | false | 22,000 | 80 | mist |
| 5 | `for toolchager` | drill | 0.201in | 3 | false | 5,000 | (plunge only) | mist |
| 6 | `82˚ couter sink for toolchanger` | counter sink, 82° tip | 0.372in | 5 | false | 1,000 | 40 | flood |
| 7 | `82˚ couter sink for toolchanger` | counter sink, 82° tip | 0.5in | 5 | false | 2,000 | 40 | flood |

Every single tool has `manual-tool-change: false` - seven independent data points all agreeing, which is itself further evidence for true-ATC (a manually-maintained library for a manual-swap machine would have no reason to set this false seven times over; it's the tool changer's own default).

### Data-quality issues in the library itself - flag, don't silently fix

Preserved verbatim in the imported file (it's the shop's real, live Fusion data - not something to edit out from under them), but these need resolving with whoever maintains the physical tool table before this is trustworthy for real jobs:

- **Tool #6 is claimed by two different tools** (#1: 0.25in endmill "for tool changer", #2: 0.1575in/4mm "sized for toolchager"). One of these does not actually live in slot 6, or the library needs a real number assigned to whichever is currently unassigned.
- **Tool #5 is claimed by two different countersinks** (0.372in and 0.5in, both 82°). **Live evidence resolves this one**: the user's own Fusion session right now shows `[T5] Drill1 (2) [Rapid...]` → `#5 - Ø0.372" 82° counter...` with an already-posted ~1KB NC file. **The 0.372in countersink is the real, currently-loaded T5** - the 0.5in entry is either stale, a spare not currently loaded, or needs its own distinct number before it's usable. Use the 0.372in one as canonical; don't wire up the 0.5in one until the physical tool table gives it a real slot.
- **Tool #4 is never used** - 1, 2, 3, 5, 6 are all claimed (with the #5/#6 collisions above), nothing claims 4. Either a tool is missing from this library, or 4 is genuinely empty on the machine right now - can't tell which from the file alone.
- **The "971 Main Bit" entry here (0.1575in, tool #1) is a *different* tool record from the one already in `cam_tools`** (`971 Main Bit 0.1575 in Flat End Mill`, `fusion_tool_library_file: '971-outside-plate.tools'`, currently loaded on New Router with `tool_number: NULL`). Same real bit, same diameter, but two independent library entries with different GUIDs. When New Router's `cam_tools` rows get rebuilt against this library (below), decide whether the existing row is repointed to this library/GUID or a fresh row is created and the old one retired - don't end up with two "971 Main Bit" rows both claiming to be the loaded #1.
- Typos are the shop's own naming convention at this point (`toolchager`, `couter sink`) - consistent with the already-known `<.3 Circluar Through Hole` template typo elsewhere in this pipeline. Not fixed here; if the team wants these cleaned up it should happen in Fusion's own tool library (the source of truth), not patched around in this repo.

## Current data model - what's already there vs. what's missing

Checked directly against the live schema (not assumed):

**Already exists and is directly usable:**
- `cam_machine_tools` (`machine_id`, `tool_id`) - this **is** "which tools are loaded in this router" at the data layer. Currently 1 row each for New Router and UNC Router (the single existing bit each). This is exactly the mechanism the UI ask below extends, not a new concept.
- `cam_tools.tool_number` - already a column, already unused (`NULL` on both current rows). This is where the library's real `post.number` per tool needs to land.
- `cam_tools.fusion_tool_library_file` - already how a tool's real Fusion library entry is located (`load_local_tool_library_json`, `localCamAssets.py`).

**Missing / needs adding:**
- No way to represent a countersink's tip angle (`SIG: 82` in the library JSON) in `cam_tools` today - not load-bearing for template patching (the countersink template's own XML already carries this), but useful for the UI to show "82° countersink" instead of just a diameter, and for validating a job actually has one loaded before offering the operation.
- No `manual_tool_change` column on `cam_tools` - not strictly needed either (the *library entry itself* already carries this, read fresh at patch time), but worth adding as a cached/display field so the UI can show "this tool changes automatically" per row without round-tripping through the zip file.
- `cam_jobs.tool_id` is a single UUID - correct for today's one-tool-per-job model, and **does not need to change**. A multi-tool job's *set* of tools is derived at generation time from whichever operations the template ends up running (see "efficient tool-swap ordering" below) - it was never meant to enumerate every tool a job uses, the same way it doesn't today for a single-tool job that happens to use one drill + one endmill operation from the current template.

## UI plan: selecting which tools are loaded in the router

**Where**: the existing Machines/Stock Categories management surface already lists `cam_machine_tools` per machine (this is what populates `toolsForMachine()` / the per-category tool `<select>` in `PartsTab.svelte` and `BoxTubesTab.svelte` today). Extend that same admin view rather than building a new one - it already has the machine → tools relationship; today it just has one row to manage per machine.

**What changes**:
1. A "Loaded tools" panel per machine, sourced from the machine's assigned `fusion_tool_library_file` (once New Router has one) - lists every tool the *library* defines (all 7, from the table above), each with a toggle for "physically loaded right now." Checked ones write/delete rows in `cam_machine_tools`, exactly as adding the single existing tool does today - no new mechanism, just more rows and a real library to read them from instead of one hardcoded entry.
2. Surface the tool-quality issues above directly in this panel, not just in this doc: the #5/#6 collisions should render as a visible warning ("two tools both claim slot 5 - confirm before loading both") rather than a silent double-toggle, so whoever maintains the physical table catches it the first time they open this screen.
3. At queue time (`PartsTab.svelte`/`BoxTubesTab.svelte`'s existing router+tool picker), the tool `<select>` already only offers `toolsForMachine(machineId)` - i.e., already scoped to loaded tools. No change needed there once (1) is populated; it already does the right thing given real data.
4. New: once a machine has more than one loaded tool, offer an **operation preview** before queueing - "this job will use: 971 Main Bit (roughing/finishing), 82° countersink (T5)" - read from a dry-run of the tool-matching logic (`_find_matching_tool` against the template's own operations) rather than requiring the operator to guess which tools a job needs before it's already running. This is new UI, backed by an also-new (small) API surface: given a plate/category + machine, return the resolved tool list without actually queueing anything.

## Single-tool mode: New Router opt-out of tool swapping

Direct instruction: New Router must also support running a job the same way UNC Router does today - one endmill, no tool changes at all - as an explicit choice, not only the multi-tool path above.

- **Queue-time toggle**, alongside the router+tool picker in `PartsTab.svelte`/`BoxTubesTab.svelte`: "Single tool (no tool changes)" vs. the default multi-tool behavior once New Router has more than one tool loaded. Off by default only in the sense that multi-tool is the more capable path; either is a legitimate, first-class choice, not a fallback.
- **When on**, the tool picker offers exactly what it offers for UNC Router today - a single tool selection - **restricted to `tool_type = endmill`**. This is a hard validation, not a UI hint: a job cannot be queued in single-tool mode with a drill or countersink selected, since a job that skips every hole/countersink operation entirely (nothing else that strategy could cut with) is not a real single-endmill job, it's a broken one. Reject at the same queue-time validation point `queueValidationError` (`PartsTab.svelte`) already gates router/tool selection on.
- **Mechanically**, this is not new template-patching logic - it's the *existing* one-tool path (`_find_matching_tool`/`largest_endmill` given a library of exactly one usable tool) applied to New Router instead of only UNC Router, with the countersink-wiring step (above) and the per-operation-category preference (roughing/finishing split) both skipped outright: every operation gets the one selected endmill, same as today's UNC Router behavior, byte-for-byte the same code path. No drill/bore/countersink operation is inserted or matched in this mode - a hole that would otherwise get a dedicated small-hole bore or countersink instead gets whatever the current single-tool fallback already does for those operations on UNC Router today (the existing `largest_endmill`-as-bore-fallback path documented in `templateTools.py:999-1038`).
- This is *also* the natural fallback when the open questions above haven't been answered yet, or the physical tool table is mid-correction (the #5/#6 collisions) - single-tool mode needs none of that resolved, since it never reads past the one selected tool.

## Job-queueing algorithm: "most efficient" tool-swap ordering

This is less new algorithm work than it sounds, once the actual mechanics are laid out - **the sequencing itself is not this pipeline's job at all**. Fusion's own `cam.generateAllToolpaths()` already groups a setup's operations by tool and only emits a tool-change block when `isToolChangeNeeded()` is true between consecutive operations (`shopsabre.cps:368`, standard Autodesk post behavior) - it does not re-derive an optimal order on its own, it follows the setup's own operation order. Since every plate/tube template here has a **fixed, hand-authored operation sequence** (bore → big hole → shape roughing → shape finishing → pocket → slot cut, per `SetupGenerator`/the templates themselves), and every operation of a given strategy already shares one tool assignment (see `_apply_tool_to_elem` above), **operations already run in an order that visits each tool once, in one contiguous block, with zero redundant swaps** - matching the "efficient" ask directly, without new sequencing code.

What "efficient tool swapping" actually needs from this pipeline, concretely:

1. **Correct tool assignment per operation category** - this session's `largest_endmill`/`_find_largest_endmill` preference already picks the single biggest endmill for every `contour2d`/`adaptive2d`/`pocket2d` operation. That's right for roughing (clears bulk material fastest) but not for a finishing pass on a tight internal corner, which wants the *smallest* endmill that still fits - and drill/countersink operations need their own dedicated tool type entirely, never an endmill. This is the real, still-open work (the older doc's item #6): a per-operation-category preference - roughing → biggest fitting endmill, finishing → smallest fitting endmill, drill/countersink/bore → the one tool of that exact type - instead of today's single blanket "biggest wins" rule applied everywhere. With this library (a 4mm, 6mm, and 0.25in endmill all present), this is no longer a hypothetical: there are genuinely different-sized tools to choose between per operation.
2. **The countersink operation itself has to exist in the pipeline** - see below. Right now it doesn't; "efficient tool swapping" has nothing to schedule for countersinking until this exists.
3. **Failing loudly if a job needs a tool that isn't actually loaded** - `_find_matching_tool` already returns `None` on no match; what happens today when nothing matches is a silent fallback to `largest_endmill` (correct for roughing/finishing, wrong for a countersink - there's no sane "fallback tool" for a countersink). Needs an explicit check: a countersink-type operation with no matching countersink tool in the job's loaded set should fail the job with a clear message ("queue this on New Router once a countersink is loaded"), not silently substitute a bit that will produce a flat hole instead of a countersunk one.

## Countersink operation integration plan

The template already exists and is already real, calibrated data - it does not need to be authored, only wired in:

- `autocam/fusion/runner/templates/971-real/router countersink.f3dhsm-template` - two operations: `<.3 Circluar Through Hole (3)` (bore, the standard small-hole op) + `Drill1 (3)` (strategy `drill`, the real 82°/0.372in countersink tool, `tool_number=5`, `manual-tool-change=false`).
- `autocam/fusion/runner/templates/971-real/countersink.f3dhsm-template` - the same `Drill1` operation alone, no bore op alongside it. Reads like a "Save as Template" export of just the one operation - the more direct source for a `_load_countersink_template()`-style clone, mirroring exactly how `_load_bore_template()` (`templateTools.py:51-63`) already works for the bore strategy: load a real exported single-operation template, clone it, substitute the real tool via `_apply_tool_to_elem`, insert into the job's own template.

Proposed mechanism, following the existing bore-fallback pattern in `patch_cam_template_with_tool_libraries` almost exactly:

1. If the job's loaded tool set has a `counter sink`-type tool (matched the same way `_is_drill_tool`/`_select_tools` already filter by type), load `countersink.f3dhsm-template`'s `Drill1` operation, clone it, apply the real matched tool via `_apply_tool_to_elem` (already handles diameter/RPM/feed/tool-number/manual-change correctly - no new logic needed there).
2. Insert the cloned operation into the patched template **after** the existing hole/pocket operations and **before** the final release cut (`2D Slot Cut`/`Slot Cut for Edges`) - countersinking a hole that hasn't been drilled yet, or after the part has already been cut free of stock, are both wrong; it needs to run once the base holes exist and before the part can move.
3. Gate this on `useToolCall` effectively being available - i.e., only offer/apply a countersink operation when the target machine's tool set has more than one distinct tool type loaded (today, functionally, New Router only). This is the "New-Router-only operation type" gating the older doc's item #8 already called for - now concrete: check `cam_machine_tools` for the target machine has a countersink-type tool, not just "is this New Router" by name, so the check stays correct if UNC Router is ever upgraded or another machine is added.
4. `DeleteToolpaths.py`'s existing cleanup (isToolpathValid checks, empty-toolpath deletion) applies to this new operation with zero changes - it already generically prunes any operation the part's real geometry doesn't apply to (e.g., a part with no counterbore-diameter holes at all).

## Post-processor findings, precisely

Read `shopsabre.cps` directly (not the bundled runner copy - confirmed byte-identical, `diff -q` reports no difference):

- `useToolCall` (labeled "Use tool changer" in the post's own UI) - boolean property, **defaults `true`**, gates the hard error on mixed tools in one program (`shopsabre.cps:382-384`). Never touched by any Python in this pipeline; stays at its file default.
- `writeToolCall(tool, insertToolCall)` (`shopsabre.cps:1583-1617`) - the actual tool-change code generator. Branches on `tool.manualToolChange`: `true` emits `M0` (`COMMAND_STOP` - a real, non-skippable pause, correctly using `M00` not the skippable `M01`, matching `toolchange-gcode-plan.md`'s own stated hazard preference) plus a `MANUAL TOOL CHANGE TO T#` comment; `false` emits `COMMAND_LOAD_TOOL` (a real `M6 Tn`-class automatic tool call). This is stock, unmodified Autodesk post-library code (the `writeToolCall.cpi`/`startSpindle.cpi` include markers confirm it) - genuinely reusable, not something this project wrote or needs to rewrite.
- `startSpindle()` (`shopsabre.cps:1620-1632`) - restarts the spindle only when actually needed (new tool, forced speed change, direction change) - already correct, no per-tool spindle-restart logic needed on our end.
- No G-code emission in this file distinguishes "true ATC" from "manual carousel with a comment" beyond the `manualToolChange` flag per tool - meaning **this decision is entirely data-driven from the tool library**, not something that needs a machine-level `hasToolChanger`-style flag threaded through the Python pipeline. Get the library's `manual-tool-change` values right per tool (open question below) and the post already does the right thing.

## Phased implementation plan

1. **Confirm the open questions below** with whoever runs the physical machine - this gates real testing, not the code structure.
2. **Resolve the tool-number collisions** in the imported library (tool #5, #6) against the real physical tool table - a corrected library (or a documented "load only these 5 of 7, here's why" decision) before step 3.
3. **Populate `cam_tools`/`cam_machine_tools` for New Router** from the corrected library - same row shape as UNC Router's existing single tool, now several rows, `tool_number` populated from each entry's real `post.number`.
4. **Single-tool parity check** (direct instruction carried over from the older doc, still the right first gate): queue one ordinary single-endmill plate job on New Router with the *expanded* library now installed, confirm nothing regresses versus today's one-tool behavior. This doubles as the first real exercise of single-tool mode (above) on New Router specifically - build that toggle here, before any multi-tool work, since it's the lowest-risk path onto New Router and needs none of the open questions resolved.
5. **Add the per-operation-category tool preference** (roughing/finishing/drill split) to `templateTools.py` - the real algorithmic work this plan identified, now testable against a genuinely multi-tool library for the first time.
6. **Wire up the countersink template** per the mechanism above, gated to machines with a loaded countersink tool.
7. **Add the "loaded tools" UI panel**, the single-tool-mode toggle, and the pre-queue operation/tool preview.
8. **Real physical test cut** on the New Router - verify actual tool-change behavior (auto vs. any pause), confirm the tool-length-measure question, and recalibrate `toolChangeTime` (currently `15` seconds, calibrated against the *manual* pattern in `practice.ngc` per the older doc - almost certainly wrong for a true ATC) against a real, physically-timed swap.

## Open questions - still need a real answer, listed precisely so they're easy to confirm

1. **Exact ATC position count on this specific unit** - 6, 10, or 12, per the spec variation found above. Determines how many distinct tools can be loaded simultaneously without a physical re-rack.
2. **Is automatic tool-length measurement actually installed and calibrated on this unit?** ShopSabre advertises "Tool Measure Technology" on this series; if present and working, no manual re-touch-off is ever needed regardless of `manualToolChange` state. If absent, every tool change - even from a true ATC - still needs the operator to physically re-touch-off Z, and `toolchange-gcode-plan.md`'s manual-re-touch-off G-code block applies even though the swap itself is automatic.
3. **Do the library's tool numbers (1, 2, 3, 5, 6) match real, current physical ATC slot assignments right now?** Given the #5/#6 collisions found above, at least one number is wrong or stale.
4. **Which endmill is actually in slot 6 today** - the 0.25in "for tool changer" bit, or the 4mm "sized for toolchager" bit? (Same question as #3, called out specifically since it blocks step 3 of the phased plan above.)
5. **Is the 0.5in countersink real/loaded, or should it be dropped from the working library entirely** until it has its own confirmed slot?

## Non-goals for this plan

- Does not touch the legacy `routing.js` / `toolchange-gcode-plan.md` path.
- Does not change UNC Router's behavior in any way - single-tool, exactly as today.
- Does not implement any code in this PR - data asset (the tool library file) plus this plan only, per direct instruction.
- Does not resolve the open questions above by guessing - they need a real answer from whoever runs the machine before step 3 of the phased plan can start for real.
