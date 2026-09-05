# Setting up and using Spartans Hub's Fusion CAM

Practical, step-by-step walkthrough for setting up the Fusion CAM Runner on your own machine, using the `/autocam/fusion` web UI to actually queue work, and understanding what happens between "click Queue CAM Job" and "download G-code." Written from actually doing this, including the real gotchas that aren't obvious from the code or the main README.

## The big picture

Two things have to be running for any of this to work:

1. **Spartans Hub itself** (`/autocam/fusion`) — where you catalog parts/plates/box tubes and queue jobs. This is just the web app, already deployed.
2. **The Runner** — a Fusion 360 add-in that runs on a machine with Fusion 360 installed, polls Spartans Hub for queued jobs, and does the actual CAM work inside Fusion. This is what you're installing below. Without a Runner running somewhere, jobs sit in the `queued` state forever — nothing else in the system generates G-code.

They talk over plain HTTP (`/api/fusion-runner`), authenticated with a shared-secret bearer token (`FUSION_RUNNER_TOKEN` on the server, `API_KEY` in the Runner's `.env`).

## Part 1: Installing the Runner

### 1. Copy the add-in in — and rename the folder

```bash
cp -R autocam/fusion/runner "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM"
```

**The destination folder must be named `SpartanRoboticsAutoCAM`, not `runner`.** Fusion requires the AddIns folder name, the main `.py` file name, and the `.manifest` file name to all match exactly — the files inside are `SpartanRoboticsAutoCAM.py`/`SpartanRoboticsAutoCAM.manifest`, so the folder has to match too, or Fusion won't even list it as an add-in. This is the single most common thing to get stuck on. (No spaces in the name, even though the add-in itself is "Spartan Robotics AutoCAM" — Fusion loads this folder as a Python package, and package names can't contain spaces.)

(Windows path: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\SpartanRoboticsAutoCAM`)

**Updating an existing install?** Re-run the same `cp -R`/`rsync` over the existing folder rather than deleting it first — it'll overwrite the code but leave your `.env` and `.overridepath` alone as long as you don't pass a flag that deletes extra files (plain `cp -R` never deletes; if you use `rsync -a`, don't add `--delete`).

### 2. Install `requests` for Fusion's bundled Python

Fusion's own Python has no third-party packages:

```bash
pip install --target=~/fusion-runner-deps requests
echo ~/fusion-runner-deps > "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM/.overridepath"
```

**Known risk, not yet root-caused:** this installs packages built for whatever Python your system's `pip` defaults to, which may not exactly match Fusion's bundled interpreter's ABI. If the add-in fails to load with an error mentioning `charset_normalizer`, that's the likely cause — ask for help rather than assuming your setup is broken.

### 3. Configure it

```bash
cd "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM"
cp .env.example .env
```

Edit `.env`:
```
API_KEY="ask whoever manages the deployment for the current value"
BASE_URL="https://spartanshub.spartanrobotics.org"
RUNNER_ID="something identifying your machine, e.g. your-name-laptop"
RUNNER_MACHINE_ID=""
```

Leave `RUNNER_MACHINE_ID` blank unless you're connecting this to real shop hardware that already has a machine profile in Spartans Hub (Manage Profiles on the main `/autocam` page) — blank is correct and expected for testing.

**About `API_KEY`:** this must exactly match the deployed `FUSION_RUNNER_TOKEN`. Ask the project administrator for the value; do not generate a second token or put one in source control. After editing `.env`, stop and run the add-in again so it reloads the value.

### 4. Enable it in Fusion

1. Open Fusion 360, make sure you're in the **Design** workspace (workspace switcher, top-left).
2. **Utilities** tab → **Add-Ins** → **Scripts and Add-Ins**. (Fusion renamed "Tools" to "Utilities" in a 2022 update — if you're following an old tutorial that says "Tools tab," this is the same place.)
3. **Add-Ins** tab inside that dialog (not "My Scripts") → find **SpartanRoboticsAutoCAM** → select it → **Run**.
4. It'll be listed as **SpartanRoboticsAutoCAM** (one word, no spaces) — matches the internal file names from step 1.
5. If you edited `.env` while the add-in was already running, **Stop** and **Run** it again — it only reads `.env` on load.

### 5. Confirm it's actually running

Open the **Text Command** window — **Option+Cmd+C** on Mac, or View menu → Show/Hide Text Commands. With logging on by default, you should see it polling every few seconds.

## Part 2: Using the web UI

Everything below happens at `/autocam/fusion` (not the main `/autocam` page — that's the older pure-JS turning/routing/tubestock pipeline; Fusion CAM is deliberately its own section for now). It has four tabs.

### Parts tab

A **Part** is a named quantity of stock waiting to be nested onto a plate — e.g. "12x Gearbox Side Plate, 1/8" aluminum." Add one with a name, a Material/Thickness category, a quantity, and optionally a STEP file and a link to a real manufacturing request (so it traces back to what it's actually for). **A Part is never queued directly** — it exists to eventually get nested onto a Plate.

The Material/Thickness dropdown is populated from `fusion_part_categories` (add categories via **Manage Profiles** on the main `/autocam` page) — if it's empty, add a category there first.

### Plates tab

A **Plate** is a real sheet: name, Material/Thickness category, width × length × true depth (inches). This is what actually gets queued and CAM'd.

Nest each Part onto a matching Plate from the Plate card's **Nest a part** control, then choose a router and its installed tool before queuing. A Plate without nested parts is not a useful test job: the Runner now rejects the missing STEP geometry rather than generating an empty CAM document.

To queue a Plate: pick a router from its row's dropdown, click **Queue CAM Job**.

### Box Tubes tab

A **Box Tube** is a tube with its own STEP file, queued 1:1 (no nesting/assignment step needed) — the most complete, actually-usable path today. Add one with a name, quantity, STEP file, and optionally a link to a manufacturing request. Pick a router, click **Queue CAM Job**.

### Job Queue tab

Shows every Fusion CAM job (`cam_jobs` rows with `operation_type = 'milling'`) and its status: `queued` → `claimed` → `processing` → `completed`/`failed`. Auto-refreshes every 10 seconds while anything is active. A failed job shows its error inline. A completed job gets a **Download G-code** button. You can **Cancel** a job at any point before it completes.

### First plate test

For a safe pipeline test with one flat STEP file, create a Part with quantity
`1` and attach the file, then create a Plate with the **same** material and
thickness category. Make the plate larger than the part (for example, a 12 x
12 in plate with a true depth matching the physical stock), nest `1` copy of
the Part onto the Plate, and queue it with **UNC Router** and **UNC Router
0.1575 in Flat End Mill**. Watch Job Queue and Fusion's Text Command window;
download the resulting G-code for inspection only. The bundled templates are
still not validated shop templates, so do not run this first output on a
physical router.

## Part 3: How G-code actually gets generated

Understanding this matters because it explains what "queued" really means and why a completed job's G-code might still not be trustworthy for a real machine yet.

```
Web UI "Queue CAM Job"
  → INSERT into cam_jobs (operation_type='milling', status='queued', params.fusionJobKind, plateId/boxTubeId, machine_id, tool_id, material_id)

Runner's polling thread (every few seconds)
  → POST /api/fusion-runner?action=claim — claims a queued row via compare-and-swap on status (two Runners can never grab the same job)
  → server resolves the full payload: plate/box-tube dimensions, assigned parts (for a plate), STEP file storage paths, machine + tool info
  → dispatches on params.fusionJobKind:
        plate:cam     → workflows/camPlate.py
        box_tube      → workflows/camTube.py
        plate:arrange → workflows/importPlate.py  (nesting only, no G-code)
```

Inside `camPlate.py`/`camTube.py` (the actual CAM generation, both follow the same shape):

1. **New Fusion document created**, previous design state cleared.
2. **STEP files downloaded and imported** (`commands/MultiImport.py`) — one import per assigned part (for a plate) or the tube's own STEP (for a box tube).
3. **Parts auto-arranged** onto the plate (`commands/AutoArrange.py`) and **oriented largest-face-up** (`commands/Orientation.py`).
4. **A Fusion CAM template is loaded** — currently hardcoded to `../templates/Plates.f3dhsm-template` (plates) or `../templates/boxtubes.f3dhsm-template` (box tubes). **These are still Team Valor 6800's original placeholder templates**, not this team's real ones — see "What's not real yet" below.
5. **The template is patched with the job's local tool library** (`workflows/templateTools.py`'s `patch_cam_template_with_tool_libraries`) — the claim includes the selected `cam_tools.fusion_tool_library_file`, and `workflows/localCamAssets.py` extracts that checked-in `.tools` archive's `tools.json` before the template is rewritten. A missing or invalid filename fails the job clearly; it never falls back to Fusion's raw default tool.
6. **CAM setups are generated** from the patched template (`commands/SetupGenerator.py`), and Fusion computes real toolpaths.
7. **G-code is exported** (`commands/NewNCProgram.py`) using the claimed machine's `cam_machines.post_processor`, resolved locally by `workflows/localCamAssets.py` (`971_emc.cps` for UNC Router/LinuxCNC; `shopsabre.cps` for New Router/WinCNC).
8. **The exported `.ngc` file(s) are read back, concatenated** (a plate template can legitimately produce more than one file — one per setup/WCS — joined here with a `(=== filename ===)` comment boundary), and **POSTed back** to `/api/fusion-runner?action=complete` as a single `cam_jobs.gcode` text column.
9. The web UI's Job Queue tab picks up the `completed` status and lets you download that text as `.ngc`.

Any failure anywhere in this chain calls `/api/fusion-runner?action=fail` with the Python traceback, which is what shows up as the job's error text in the Job Queue tab.

### What's not real yet

- **Templates**: `Plates.f3dhsm-template`/`boxtubes.f3dhsm-template` are still Valor 6800's originals (their tool naming, e.g. "6061Al Onsrud End Mill"). This team's real templates — extracted from the shop's own Fusion `Documents/Template` folder — are staged at `templates/971-real/` but **not wired into `camPlate.py`/`camTube.py`**. Box tubes have one clear real template (`Tubestock(with Cutter Comp).f3dhsm-template`); plates have several candidates for different material/tool/machine combinations (one is explicitly ShopSabre-only per its own filename) — picking the default needs a human CAM call, not a filename guess. See `templates/971-real/README.md` and `cam-engineering-plan.md`.
- **Tool library configuration**: the real "971 Main Bit" library (`tools/971-outside-plate.tools`, two variants — 0.1875" HSS at 13000 RPM, 0.1575" carbide at 22000 RPM, both real Fusion-programmed feeds) is configured by the nullable `cam_tools.fusion_tool_library_file` field. Verify the selected tool row has that filename before releasing a real job.
- **Plate-part nesting UI**: see the Plates tab section above.

So: claiming jobs, importing geometry, and the full round-trip back to a downloadable `.ngc` file all work today. Whether that G-code is *correct* for a real cut depends on templates/tools that haven't been finished yet — treat any G-code produced today as a pipeline test, not something to run on a real machine.

## Part 4: Proving the connection works end-to-end

- In the browser: `/autocam/fusion` → **Parts** → add a flat STEP part → **Plates** → add matching stock → nest the part → select router and tool → **Queue CAM Job**.
- Watch the Text Command window in Fusion — it should claim the job within about 10 seconds.
- Watch the **Job Queue** tab in the browser — status should move `queued` → `claimed` → `processing` → `completed` (or `failed` with a real error).

| Stage | Should work today |
| --- | --- |
| Add-in shows up and runs | Yes |
| Text Command shows polling activity | Yes |
| Queued job gets claimed | Yes |
| Part geometry actually imports into Fusion | Yes |
| Job completes and G-code downloads | Yes (mechanically) |
| That G-code is correct for a real cut | **Not yet** — needs real per-machine templates/tools, see above and `cam-engineering-plan.md` |

If something fails before the "claimed" stage, that's a real setup problem worth debugging. If it gets that far and then fails or produces garbage during the actual CAM step, that's expected until real templates exist for your machine — not your setup being broken.

## Running on more than one machine at once

Safe to do — the claim step is a compare-and-swap, so two Runners can never grab the same job. Just give each machine its own `RUNNER_ID`. If more than one machine will be polling *and* has real hardware behind it, each should also get its own `RUNNER_MACHINE_ID` (matching its `cam_machines` row) so jobs route to the right physical machine instead of whichever one happens to poll first.
