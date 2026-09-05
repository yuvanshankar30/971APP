# Getting real toolpaths out of Fusion CAM

This doc is for whoever actually knows the machine — not a software question, a CAM one. The software side (queueing jobs, claiming them, getting the right part geometry into Fusion) is done and tested. What's still missing is real, machine-specific information that only someone who's actually run this router/mill can provide. Answer the questions below (in this doc, a comment, wherever's easiest) and hand it back — that's what unblocks the rest of the code.

## Why this can't be figured out from the software side

The Runner (`autocam/fusion/runner/`) works by taking a saved Fusion CAM "template" — basically a recording of a real setup someone built once by hand (stock, work coordinate system, which tools cut which features, feeds and speeds) — and re-applying it to new part geometry automatically. It doesn't invent a machining strategy from scratch. Right now, the template files in `autocam/fusion/runner/templates/` are the ones that shipped with the open-source project this was forked from (Team Valor 6800's AutoCAM) — built around *their* machines, not ours. Applying them to our parts would produce wrong or nonsensical toolpaths.

Three real things are needed, none of which are a config file or a code change:

## 1. A real tool library

Fusion has a "Tool Library" manager (Manage → Tool Library, or similar depending on your Fusion version) where you set up every tool you actually have — end mills, drills, whatever's in the crib for this machine — with real geometry, holder info, and feeds/speeds per material. If one doesn't already exist for this machine's tools, it needs to be built once inside Fusion.

Once it exists: **File → Export** (or right-click the library → Export) saves it as a `.json` file. That file is what the code needs — send it over once it's built.

Questions to answer:
- What tools does the crib for this machine actually have (end mills — sizes/flute counts, drills, anything else)?
- Do you already have a Fusion tool library set up for this machine, or does one need to be built from scratch?
- Feeds/speeds: do you have known-good values per material already (from experience, a spec sheet, wherever), or does that need figuring out too?

## 2. A post-processor

This is the file that translates Fusion's generic toolpath into the actual G-code dialect your machine's controller understands. Spartans Hub already tracks a `controller` value per machine (currently `linuxcnc` or `wincnc` in the database) — Fusion ships with stock posts for a lot of common controllers.

Questions to answer:
- Does a stock Fusion post-processor for this machine's controller already work (has it been used before, even manually)?
- If not, is there a custom `.cps` file already in use for this machine somewhere, or does one need to be sourced/written?

## 3. The actual template — this is the real work

This is the part that can't be shortcut: someone needs to sit down in Fusion, import a real sample part (a plate, and separately a box tube), and manually CAM it the way you'd actually want it machined — real stock setup, real work coordinate system, real operation choices (adaptive clearing, contour, pocket, drilling, whatever the part calls for), with the real tools from step 1 assigned. Once that's built and verified (simulate it, actually check the toolpath makes sense), **Manage → Save as Template** exports it as a `.f3dhsm-template` file.

This needs doing twice — once for a representative plate job, once for a representative box-tube job — since those are the two job types the Runner handles.

Questions to answer:
- Is there already a "gold standard" manual CAM setup for plates/box-tubes on this machine to start from, or does this get built from nothing?
- Any machine-specific quirks the template needs to account for (fixturing, known problem operations, anything that's bitten people before)?

## Where these files actually go

Not decided yet — flagging rather than assuming. Two obvious options:
- Committed into the repo under `autocam/fusion/runner/templates/` and a new `tools/` folder, the same way Valor's originals shipped (simple, works with the current file-path-based code, but puts real tool/machine data in git history).
- Some kind of real upload path through the web app instead (more work, keeps this stuff out of git, matches how STEP files already work).

This gets decided once the actual files exist and we know their size/sensitivity — not worth designing storage for data that doesn't exist yet.

## Local runner assets

The Runner now reads the selected checked-in `.tools` archive via
`cam_tools.fusion_tool_library_file` and resolves `cam_machines.post_processor`
to the committed `971_emc.cps` or `shopsabre.cps` file. The remaining work is
to choose the appropriate real template for each material/tool/machine; that
decision should be made from validated shop CAM setups rather than filenames.
