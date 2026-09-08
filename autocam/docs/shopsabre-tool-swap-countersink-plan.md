# ShopSabre calibration: tool swapping + countersinking implementation plan

**Draft PR, not for merge as a feature yet.** Implementation of everything that doesn't require physical ShopSabre hardware confirmation is now in scope on this branch (see "Non-goals for this plan" below for the exact split). Multi-tool/countersink enablement and the first-article cut stay gated on the physical open questions.

## Current reliability state (Fusion hang/crash fixes already shipped, separately from this plan)

Fusion Runner reliability work landed this session as its own series of merged PRs (#517-#525), independent of the ShopSabre feature work below. Anyone picking up this plan should treat these as the current baseline, not as open problems to re-solve:

- **Startup hang**: root-caused to `_sync_data_folders` firing immediately at add-in launch and colliding with Fusion's own boot sequence; fixed by deferring that sync.
- **Folder-walk cloud-call bursts**: an unpaced burst of ~150-170 cloud calls during a folder walk correlated with a real Fusion crash; walk calls are now paced.
- **Folder-tree truncation**: "Offseason Projects" was being dropped from deep folder trees; fixed via a priority-reordering walk (`_PRIORITY_FOLDER_NAMES`).
- **Per-job temp-file leak**: an unbounded per-job leak (233 template files + 113 STEP files, 62MB observed) was the root cause of a hang "after ~200 document closes"; now cleaned up per job.
- **Tab-placement over/under-provisioning** and **duplicate roughing-pass computation**: both fixed (`PER_SIDE_EXTRA_TAB_SPACING_IN`, `_tab_desired_count`).
- **Per-machine job locking**: a job queued by one operator's computer can no longer be claimed/completed by a different physical computer (`authorized_runner_id`).
- **Operator tab-count override**: bounded (4-20) optional override added to the Parts queue modal, defaulting to existing behavior when unset.

This does not mean Fusion is guaranteed hang-free now - it means these specific, previously-diagnosed causes are fixed. Whoever picks up the crash/hang audit below should verify against the *current* code (these fixes are already merged to `main`) rather than re-diagnosing symptoms these PRs already addressed, and should still watch for hangs/crashes surfaced fresh in this ShopSabre work itself (new template loads, new tool-library reads, new UI flows) since those are new code paths these fixes don't cover.

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

## Full implementation design

This section turns the plan above into the work units needed to ship the
feature safely. The design goal is deliberately narrow: make the ShopSabre
usable with its real loaded tools and countersink capability while preserving
UNC Router's current single-tool behavior.

### User-facing workflow

There are three user stories to support:

1. **CAM manager configures the machine**
   - Open Fusion AutoCAM machine management.
   - Select the New Router / ShopSabre machine.
   - See the checked-in tool library, physical slot numbers, tool types,
     diameters, countersink angle, and automatic/manual-change state.
   - Mark the tools that are physically loaded in the ATC right now.
   - See blocking warnings for slot collisions and missing required tool
     metadata before enabling multi-tool operation.

2. **Operator queues a normal plate/tube job**
   - Choose New Router as the machine.
   - Choose either multi-tool mode or single-tool mode.
   - In multi-tool mode, see a preview of the resolved operation/tool plan
     before queueing.
   - In single-tool mode, pick exactly one loaded endmill and get today's
     UNC-Router-style behavior, with no countersink insertion.

3. **Operator queues a countersink-capable job**
   - The app only offers countersink behavior when the selected machine has a
     loaded countersink tool and the job is not in single-tool mode.
   - The preview clearly shows the countersink tool, slot number, and where it
     appears in the operation order.
   - If the job geometry does not need countersinking, the operation is pruned
     as part of normal toolpath cleanup rather than causing a false failure.

### Data model and migration plan

Add one idempotent migration, tentatively
`migrations/YYYYMMDD_shopsabre_loaded_tools.sql`.

The migration should:

1. Add cached display/validation columns to `cam_tools`:
   - `tool_number integer`
   - `manual_tool_change boolean`
   - `tip_angle numeric`
   - `tool_library_guid text`
   - `source_tool_library_file text`

   `tool_number` may already exist in current branches, so use
   `ADD COLUMN IF NOT EXISTS`. Keep `fusion_tool_library_file` as the existing
   Runner-facing library reference; `source_tool_library_file` is only for
   displaying/importing where a row came from if the team wants that separate
   from the active Runner file.

2. Add validation that catches impossible loaded-tool states:
   - A partial unique index on `(machine_id, tool_number)` through
     `cam_machine_tools` is not directly expressible because the number lives
     on `cam_tools`. Use a trigger on `cam_machine_tools` instead:
     when inserting/updating a loaded tool with non-null `tool_number`, reject
     another loaded tool on the same machine with the same `tool_number`.
   - Allow `tool_number IS NULL` for legacy rows, but the ShopSabre multi-tool
     setup should not be considered valid until every loaded tool has a real
     number.

3. Seed or update the New Router tool rows from
   `Normal router tools (use this).tools` only after the physical slot answers
   are confirmed.
   - Prefer stable, human-readable names such as
     `ShopSabre T5 0.372 in 82 deg Countersink`.
   - Repoint or retire the duplicate existing `971 Main Bit` row deliberately;
     do not leave two active loaded rows for the same physical tool.
   - Insert `cam_machine_tools` rows only for confirmed loaded tools.

4. Avoid changing UNC Router seed data.
   - Its current one loaded endmill remains the entire available tool set.
   - No existing job rows need rewriting.

5. Keep RLS consistent with the rest of Fusion CAM.
   - Catalog/tool writes should remain manager-only, matching
     `canManageCamProfiles` at the UI layer and the existing database policy
     direction.
   - Ordinary approved users can read enough metadata to queue valid jobs but
     cannot mutate loaded tools.

### API and data-layer changes

Keep the public browser-facing data layer in `src/lib/fusionCam.js`, but avoid
putting Fusion tool-library parsing in client code. The checked-in `.tools`
archives are implementation assets for the Runner and server; the browser
should receive normalized metadata only.

Add or extend one authenticated server endpoint for CAM-manager operations:

1. **List machine tool-library inventory**
   - Input: `machineId`
   - Output: normalized library tools, currently loaded tool IDs, duplicate
     slot warnings, missing-number warnings, countersink/drill/endmill
     summaries, and whether multi-tool mode is ready.
   - Source: `cam_tools`, `cam_machine_tools`, and a server-side parser for
     the checked-in `.tools` file when a row references one.

2. **Set loaded tools**
   - Input: `machineId`, ordered list of `toolId`s or imported library tool
     descriptors to materialize as `cam_tools` rows.
   - Permission: manager-only.
   - Behavior: validate slot collisions and required metadata in one request,
     then update `cam_machine_tools`.

3. **Preview resolved tool plan**
   - Input: `fusionJobKind`, `machineId`, `toolId`, `plateId`/`boxTubeId`,
     `singleToolMode`, selected part/grouping information.
   - Output: operation categories, selected tool for each category, tool slot,
     tool type, whether a countersink op would be inserted, blocking errors,
     and warnings.
   - This can initially be a conservative server-side approximation that uses
     the same normalized tool metadata and template names. Long term, it
     should share the Runner's matching code or invoke a lightweight Runner
     dry-run so the preview cannot drift from the actual generated job.

Extend `queueFusionJob()` and its callers to include:

- `params.singleToolMode: boolean`
- `params.requestCountersink: boolean | null` if the UI offers an explicit
  operation request; otherwise derive this from machine/tool capability.
- `params.resolvedToolPlanPreview` as non-authoritative audit metadata if
  useful for the queue card. The Runner remains authoritative at claim time.

Queue-time validation should reject:

- single-tool mode with a non-endmill selected tool
- multi-tool/countersink mode with no loaded countersink
- New Router multi-tool mode while slot collisions exist
- machine/tool combinations not represented in `cam_machine_tools`
- missing `fusion_tool_library_file` or unresolved local tool asset

### UI implementation plan

The UI belongs inside the existing Fusion AutoCAM surfaces, not a new top-level
route.

1. **Machine/tool management**
   - Extend the existing machine/profile management area used by Fusion CAM
     operators.
   - Add a dense "Loaded tools" table with columns:
     Loaded, Slot, Name, Type, Diameter, Tip angle, Change mode, Library, Status.
   - Use toggles for loaded/unloaded state and warning badges for collisions
     or missing metadata.
   - Keep the visual style utilitarian and compact; this is shop-floor
     configuration, not a marketing page.

2. **Parts queue dialog**
   - Add a segmented control:
     `Multi-tool` / `Single tool`.
   - Default to `Single tool` until New Router's loaded-tool state has no
     blocking warnings. After that, default can move to `Multi-tool` for New
     Router only.
   - In single-tool mode, filter the existing tool select to loaded endmills.
   - In multi-tool mode, keep the primary selected tool as the main endmill or
     roughing preference anchor, but show the derived additional tools.

3. **Box tubes queue dialog**
   - Mirror the same single/multi-tool control only if tube templates actually
     benefit from the ShopSabre loaded tools.
   - If countersink is plate-only in the first implementation, state that in
     validation and do not expose a misleading tube countersink option.

4. **Operation preview**
   - Show a small pre-queue panel:
     `Roughing -> T6 0.25 in endmill`, `Finishing -> T1 4mm endmill`,
     `Countersink -> T5 0.372 in 82 deg countersink`.
   - Include blocking errors inline and disable queueing when the preview says
     the job cannot be resolved.
   - Preserve current quick-selection workflows; the preview should support
     them rather than forcing a separate page.

5. **Job queue card**
   - Add single-tool/multi-tool mode and resolved tool-plan summary to the job
     detail panel when present.
   - Show a warning if the Runner's completion metadata reports a different
     tool set than the preview snapshot.

### Runner implementation plan

The Runner should remain the source of truth for the final tool assignment.
The browser preview is a confidence tool, not permission to cut.

1. **Tool library parsing**
   - Keep using `load_local_tool_library_json()` and
     `patch_cam_template_with_tool_libraries()`.
   - Add helpers in `templateTools.py` to classify tools:
     endmill, drill, countersink, unknown.
   - For countersinks, read type plus included angle when available.

2. **Single-tool mode**
   - If `payload.params.singleToolMode` is true, constrain the candidate tool
     library to the selected `cam_jobs.tool_id` tool only.
   - Validate that the selected tool is an endmill before patching.
   - Do not insert countersink operations.
   - Preserve current UNC Router behavior and use this mode as the first New
     Router parity test.

3. **Per-operation tool preferences**
   - Replace blanket "largest endmill wins" with category-specific selection:
     roughing/adaptive/pocket clearing -> largest fitting endmill
     finishing/tight contours/slots -> smallest fitting endmill that can cut
     the geometry
     bore/drill -> matching drill or current bore fallback when allowed
     countersink -> matching countersink only; no endmill fallback
   - Make the fallback rules explicit in code and tests. A fallback that is
     acceptable for UNC Router single-tool mode may be unacceptable for
     ShopSabre multi-tool mode.

4. **Countersink template insertion**
   - Add `_COUNTERSINK_TEMPLATE_PATH` next to `_BORE_TEMPLATE_PATH`.
   - Add `_load_countersink_template()` that returns the single exported
     countersink operation.
   - Clone and insert it after hole-making operations and before release cuts.
   - Apply the matched real countersink tool with `_apply_tool_to_elem()`.
   - If no countersink tool is loaded and the job requested/needs one, raise a
     clear error instead of falling back.

5. **Operation ordering**
   - Do not invent a new global optimizer in this phase.
   - Preserve the reviewed template order unless a real Fusion test proves
     redundant tool swaps.
   - If operation reordering is later needed, do it in template assets first,
     then code only if the same ordering must be generated dynamically.

6. **Completion metadata**
   - Include used tool numbers/types/names in job `stats` or `warnings` when
     reporting completion.
   - Keep NC artifacts exact-byte outputs as they are today.

7. **Machining time**
   - Make `toolChangeTime` machine-specific instead of one hard-coded
     assumption.
   - Until the ShopSabre is physically timed, surface the estimate as
     provisional for New Router multi-tool jobs.

### Template and asset plan

1. Keep `Normal router tools (use this).tools` checked in as the imported
   source artifact for review.
2. Do not hand-edit the binary `.tools` archive to fix slot collisions. The
   corrected source should come from Fusion or from an explicit, documented
   migration/seed decision.
3. Treat `new router metal sheet (shopsabre only!!).f3dhsm-template` as
   untrusted until confirmed as a real export from the actual ShopSabre setup.
4. Use `countersink.f3dhsm-template` for operation cloning unless live Fusion
   testing proves the combined `router countersink.f3dhsm-template` is safer.
5. Update `autocam/fusion/runner/templates/971-real/README.md` when a template
   moves from "available asset" to "selected by production code."

### Safety and validation gates

Before any generated ShopSabre multi-tool program is considered safe to run:

1. The physical ATC position count is confirmed.
2. Automatic tool-length measurement is confirmed or the manual-touch-off path
   is explicitly designed.
3. Every loaded tool has one unique slot number.
4. The selected countersink is confirmed physically loaded.
5. The ShopSabre template is confirmed exported from the correct machine setup.
6. A single-tool New Router job posts valid `.tap` output.
7. A dry-run multi-tool job posts expected `T`/`M6` blocks without cutting.
8. A real supervised first-article cut succeeds.

## Suggested issue breakdown

This is large enough to split before implementation:

1. **Import and validate ShopSabre tool metadata**
   - Migration, seed/update script, loaded-tool trigger, and tests.

2. **Add Fusion CAM loaded-tools management UI**
   - Machine loaded-tool table, warnings, manager-only mutation path.

3. **Add queue-time single-tool mode**
   - Parts queue dialog, params, validation, and Runner support landed in
     the current draft implementation. Box-tube UI parity remains pending;
     the payload contract already carries the flag for that flow.

4. **Add resolved operation/tool preview**
   - Server preview endpoint, UI panel, queue-card metadata.

5. **Add per-operation tool selection in Runner**
   - Roughing/finishing/drill/countersink classification and tests.

6. **Wire countersink operation template**
   - Template loading/insertion, loaded countersink gating, failure messages.

7. **Calibrate ShopSabre machine timing and physical cut gates**
   - Machine-specific tool-change time, dry-run, first-article record, docs.

## Template source detail (folds into "Template and asset plan" above)

Both real countersink templates already exist and are already real, calibrated data - neither needs to be authored, only wired in:

- `autocam/fusion/runner/templates/971-real/router countersink.f3dhsm-template` - two operations: `<.3 Circluar Through Hole (3)` (bore, the standard small-hole op) + `Drill1 (3)` (strategy `drill`, the real 82°/0.372in countersink tool, `tool_number=5`, `manual-tool-change=false`).
- `autocam/fusion/runner/templates/971-real/countersink.f3dhsm-template` - the same `Drill1` operation alone, no bore op alongside it. Reads like a "Save as Template" export of just the one operation - the more direct source for `_load_countersink_template()`, mirroring exactly how `_load_bore_template()` (`templateTools.py:51-63`) already works for the bore strategy.
- The existing `largest_endmill`-as-bore-fallback path is at `templateTools.py:999-1038` - the reference point for how single-tool mode's bore/drill fallback already behaves and should keep behaving.
- `isToolChangeNeeded()` (standard Autodesk post behavior, exercised at `shopsabre.cps:368`) is why the "Operation ordering" item above needs no new sequencing code: every template here already has one fixed, hand-authored operation order with one tool per strategy, so tool changes already happen in one contiguous block per tool with zero redundant swaps - confirm this holds during live Fusion tests rather than re-deriving it in code.

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

## Test plan

### Database tests

- Migration can run repeatedly without errors.
- Existing UNC Router rows are unchanged.
- New Router loaded-tool rows can be inserted for distinct non-null tool
  numbers.
- Loading two tools with the same non-null slot on the same machine is rejected.
- Loading two tools with the same slot on different machines is allowed.
- Legacy/null `tool_number` rows remain readable and do not break existing
  pages.
- Ordinary approved users cannot mutate loaded-tool configuration; CAM managers
  can.

### JavaScript/Svelte tests

- `fetchMachines`/tool-fetch helpers include `tool_type`, `tool_number`,
  `manual_tool_change`, `tip_angle`, and library file metadata without breaking
  existing callers.
- `toolsForMachine()` keeps filtering by `cam_machine_tools`.
- Parts queue validation rejects:
  - no machine
  - no loaded tool
  - single-tool mode with a drill/countersink
  - multi-tool countersink request without a loaded countersink
  - unresolved duplicate-slot warnings
- Box-tube queue validation keeps today's behavior when multi-tool mode is not
  supported for tubes.
- Preview UI renders blocking errors, warnings, and resolved operation/tool rows
  without shifting or overflowing at mobile widths.

### Runner Python tests outside Fusion

Use pure-Python tests for template/library behavior where possible:

- Parse `Normal router tools (use this).tools` and classify all seven tools.
- Detect the known #5 and #6 collisions.
- Select largest fitting endmill for roughing categories.
- Select smallest fitting endmill for finishing categories.
- Select countersink only for countersink operations.
- Refuse countersink fallback to endmill.
- Single-tool mode constrains the candidate library to one selected endmill.
- `_load_countersink_template()` returns the expected `drill` strategy element.
- Inserting the countersink operation places it before release cuts.
- `_apply_tool_to_elem()` preserves tool number and manual-change fields.

Run:

```bash
python3 -m compileall -q autocam/fusion/runner
npx vitest run
npx svelte-check --output human
```

### Live Fusion tests

These require Fusion because `adsk` APIs cannot run in normal Python:

1. New Router single-tool plate, no countersink.
2. New Router multi-tool plate using at least two endmills.
3. New Router countersink plate using T5.
4. New Router job with the countersink unloaded: must fail before posting
   unsafe output.
5. UNC Router plate after all changes: must remain single-tool and produce the
   same expected style of output.
6. Dry-run post inspection: verify `.tap`, expected `T` numbers, expected `M6`
   behavior, no unexpected `M00` if the machine is confirmed true ATC.
7. Supervised first-article cut with operator signoff.

### Manual UI checks

- Loaded-tools panel with the imported library.
- Duplicate-slot warning state.
- Single-tool queue flow.
- Multi-tool queue flow.
- Countersink-capable queue flow.
- Job queue summary after claim/completion.
- Mobile layout for queue dialogs and loaded-tools panel.

## Rollout plan

1. Keep this PR in draft until the physical ShopSabre answers are collected -
   code for issues 1-6 (data model, API, UI, Runner tool selection, countersink
   wiring, tests) lands on this PR/branch now; only actual multi-tool/countersink
   enablement and the first-article cut (issue 7) wait on the physical answers.
2. Land the implementation in smaller commits on this branch following the
   issue breakdown above (split into separate PRs later only if this one grows
   unreviewably large).
3. Deploy database migration before UI code that expects new columns.
4. Ship loaded-tool management disabled or read-only until the slot collisions
   are resolved.
5. Enable New Router single-tool mode first.
6. Run at least one successful single-tool New Router job and compare posted
   output with the current workflow.
7. Enable multi-tool preview without queueing multi-tool jobs yet, if useful.
8. Enable multi-tool queueing only after dry-run post inspection succeeds.
9. Enable countersink only after the T5 countersink is physically confirmed and
   the operation has passed live Fusion dry-run.
10. Record the first-article result and update this doc plus
    `autocam/docs/shopsabre-autocam-calibration.md` with the final physical
    facts.

## Acceptance criteria

The feature is done when:

- New Router has a reviewed, collision-free loaded-tool configuration in the
  app.
- A CAM manager can update loaded tools without editing the database by hand.
- A normal operator can choose single-tool or multi-tool mode from the queue
  dialog.
- Single-tool mode only permits loaded endmills and does not insert
  countersink operations.
- Multi-tool mode resolves operation categories to loaded tools and refuses
  missing required tools.
- Countersinking is only available on machines with a loaded countersink tool.
- Runner completion records the tool set actually used.
- UNC Router behavior remains unchanged.
- Tests cover migration behavior, queue validation, template patching, and
  tool selection.
- A real ShopSabre first-article cut has been completed and documented.

## Risks and mitigations

- **Wrong physical slot number**: can call the wrong tool. Mitigate with
  duplicate-slot validation, physical confirmation, dry-run post inspection,
  and first-article signoff.
- **Tool-length measurement assumption wrong**: can cut at unsafe Z after a
  swap. Mitigate by confirming the ShopSabre tool-measure setup before enabling
  unattended tool changes.
- **Template not actually ShopSabre-calibrated**: can use wrong feeds, heights,
  WCS, or operation assumptions. Mitigate by treating the template as untrusted
  until confirmed from the real machine setup.
- **Preview drifts from Runner behavior**: can mislead the operator. Mitigate by
  keeping Runner authoritative and eventually sharing the same matching code or
  dry-run endpoint.
- **Multi-tool changes accidentally affect UNC Router**: can break the stable
  one-tool workflow. Mitigate with explicit single-tool tests and no UNC Router
  data migration changes.
- **Countersink geometry detection is too broad**: can countersink holes that
  should remain plain. Mitigate with conservative insertion, Fusion cleanup,
  and live test parts with known countersunk/plain holes.

## Open questions - still need a real answer, listed precisely so they're easy to confirm

1. **Exact ATC position count on this specific unit** - 6, 10, or 12, per the spec variation found above. Determines how many distinct tools can be loaded simultaneously without a physical re-rack.
2. **Is automatic tool-length measurement actually installed and calibrated on this unit?** ShopSabre advertises "Tool Measure Technology" on this series; if present and working, no manual re-touch-off is ever needed regardless of `manualToolChange` state. If absent, every tool change - even from a true ATC - still needs the operator to physically re-touch-off Z, and `toolchange-gcode-plan.md`'s manual-re-touch-off G-code block applies even though the swap itself is automatic.
3. **Do the library's tool numbers (1, 2, 3, 5, 6) match real, current physical ATC slot assignments right now?** Given the #5/#6 collisions found above, at least one number is wrong or stale.
4. **Which endmill is actually in slot 6 today** - the 0.25in "for tool changer" bit, or the 4mm "sized for toolchager" bit? (Same question as #3, called out specifically since it blocks step 3 of the phased plan above.)
5. **Is the 0.5in countersink real/loaded, or should it be dropped from the working library entirely** until it has its own confirmed slot?

## Non-goals for this plan

- Does not touch the legacy `routing.js` / `toolchange-gcode-plan.md` path.
- Does not change UNC Router's behavior in any way - single-tool, exactly as today.
- Implementation on this PR is authorized for everything that doesn't require physical ShopSabre confirmation: data model/migration, API and data-layer changes, UI (loaded-tool panel, single-tool toggle, operation/tool preview), Runner per-operation tool selection and countersink template wiring, and all automated tests (issues 1-6 of the breakdown above). This PR stays in draft, and multi-tool/countersink code paths stay disabled or gated behind loaded-tool checks, until the physical answers below are collected - actual multi-tool enablement and any first-article cut (issue 7, step 8 of the phased plan) remain gated on that hardware confirmation, not on more code.
- Does not resolve the open questions above by guessing - they need a real answer from whoever runs the machine before step 3 of the phased plan (multi-tool enablement) can start for real; single-tool mode and the data/UI/Runner scaffolding above need none of them.
