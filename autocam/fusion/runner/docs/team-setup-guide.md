# Setting up Spartans Hub's Fusion CAM Runner

Two things run this: **Spartans Hub** itself (already deployed - where you queue jobs at `/autocam/fusion`) and the **Runner**, a Fusion 360 add-in you install below that polls Spartans Hub for queued jobs and does the CAM work inside Fusion. Without a Runner running, jobs just sit `queued` forever - nothing else in the system generates G-code.

## Install

1. **Run one command, once, ever.** In a normal terminal (not Fusion):
   ```bash
   sh -c "$(curl -fsSL https://spartanshub.spartanrobotics.org/install/fusion-runner)"
   ```
   That's the whole install command, and the only time you should need to touch a terminal for this machine again. The site serves a small bootstrap that downloads the current Runner ZIP and manifest, verifies its SHA-256 checksum, rejects unsafe archive paths, and then runs `setup.py`. Setup finds Fusion's AddIns folder (creating it if Fusion hasn't yet), copies the add-in under the exact name Fusion requires, installs `requests`, and opens a bare Spartans Hub pairing page. The page contains one password field and the description **Enter the Fusion Runner token.** Enter the team token and press Return. That is the only setup action after running the command.

   The installer derives the Hub from the command URL and the Runner name from the workstation hostname. The page validates the shared team token, while a separate high-entropy secret held only by the waiting installer lets it collect a newly minted per-install token and the registered machine ID. It then writes `.env` itself. Neither credential appears in the browser URL, and a pairing session expires after ten minutes and can be consumed only once. From here on, the Runner keeps itself current automatically every time Fusion starts - see **Runner updates** below.

   To install from another Spartans Hub deployment, use that site's own `/install/fusion-runner` URL. For local development, run `setup.py` with `FUSION_RUNNER_INSTALL_BASE_URL=http://localhost:5173`; physical machines should use the production command above.

   **Known risk, not yet root-caused:** the `pip install` step builds packages for whatever Python your system defaults to, which may not exactly match Fusion's bundled interpreter's ABI. If the add-in fails to load with an error mentioning `charset_normalizer`, that's the likely cause - ask for help rather than assuming your setup is broken.

   The ready-made zip remains available from the [Fusion AutoCAM Setup page](/autocam/fusion/setup) for manual/offline installation. Unzip it anywhere and run `python3 setup.py` from inside the extracted `SpartanRoboticsAutoCAM` folder.

   **Missing `.overridepath` or `requests` at startup?** The install was
   copied without its generated dependency folder. From the installed add-in
   directory, run `python3 setup.py` again. It recreates `deps/` and
   `.overridepath`; it detects the existing `.env` and does not touch your
   token or machine id. Then fully quit and relaunch Fusion.

   **Prefer a live git checkout over a copied install?** This is now purely a
   matter of taste, not a way to get automatic updates - the Runner already
   self-updates via the API above regardless of which install you use.
   Pointing Fusion's AddIns folder at a git checkout with a symlink instead
   trades that off for `git pull`-based, human-timed updates:
   ```bash
   git clone https://github.com/frc971/spartanshub.git ~/spartanshub
   ln -s ~/spartanshub/autocam/fusion/runner "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM"
   python3 ~/spartanshub/autocam/fusion/runner/setup.py
   ```
   (Windows: `mklink /D` from an admin Command Prompt instead of `ln -s`.) `setup.py` detects the symlink and leaves it in place rather than copying over it - and, deliberately, so does the self-updater: it would otherwise overwrite files inside your git working tree, leaving uncommitted changes a later `git pull` could conflict with. A symlinked install's only update path is `cd ~/spartanshub && git pull`, done by hand; quit and relaunch Fusion afterward to load the new files. `.env`/`.overridepath` live inside `autocam/fusion/runner/` and are gitignored, so `git pull` never touches them.

2. **Know what `RUNNER_MACHINE_ID` actually means.** It's the `cam_machines` id of the machine this computer is actually wired to - not the same thing as the token above, and per-device rather than shared. Browser pairing registers it from the workstation hostname (get-or-create, so reinstalling on the same named workstation reuses the profile) and writes the UUID automatically. A newly created profile starts **disabled**: it can still claim unassigned jobs, but an admin needs to set its post-processor and tool library and enable it at **`/autocam` -> Machines** before it can be targeted for a specific machine's jobs.

   It matters because a Runner only claims jobs meant for its own machine (or jobs left unassigned). Give two workstations the same machine id and the router's Runner can pick up a job queued for the mill - which is why it's required rather than optional.

3. **Enable it in Fusion:** Utilities tab -> Scripts and Add-Ins -> **Add-Ins** tab -> **SpartanRoboticsAutoCAM** -> Run. ("Utilities" was called "Tools" before a 2022 Fusion update, in case an old tutorial says that instead.)

4. **Confirm it's running:** open the Text Command window (Option+Cmd+C on Mac, or View -> Show/Hide Text Commands) - you should see it polling every few seconds.

Running more than one machine at once is safe: claiming is a compare-and-swap,
so two Runners cannot grab the same job.

**Changed `.env` again later?** Fully quit and relaunch Fusion - Stop/Run alone doesn't reliably reload it.

### Fusion Data Project

The Runner's project root is **`2026 Season CAM`**. Leave
`FUSION_DATA_PROJECT_NAME` unset to use that default, or set it to exactly
`2026 Season CAM`; do not set it to `AutoCAM`. `AutoCAM` is a folder/project
name that may be active in Fusion, but it is not the Runner's destination.
If Fusion cannot resolve `2026 Season CAM` during startup, the Runner waits
and retries rather than saving or publishing a folder tree from whichever
project happens to be active. The web folder picker may briefly show no
folders until the next verified sync; that is safer than choosing a wrong root.

## How it works

Queuing a job in the web UI (`/autocam/fusion`) just inserts a `queued` row into `cam_jobs`. The Runner polls `/api/fusion-runner` every few seconds, claims a queued row (compare-and-swap, so two Runners never grab the same job), and downloads the part's STEP file. It then imports that geometry into a fresh Fusion document, applies a pre-built Fusion CAM template - feeds/speeds/tool assignments someone built once by hand in Fusion's own CAM workspace, not a machining strategy invented from scratch - patches in the selected tool library and reviewed material feed/speed preset, generates toolpaths, exports G-code with the machine's post-processor, and reports the result back so the Job Queue tab shows `completed` (with a G-code download) or `failed` (with the real error). A material without a reviewed preset is rejected instead of receiving guessed feeds.

Brief API connection resets are retried automatically with bounded backoff. If
the Text Command window shows a reset repeatedly, check the network or the
server; do not restart Fusion just for one transient reset.

## Runner updates

**Run `setup.py` once; you should never have to manually update this machine again.** On every add-in start, the Runner asks the authenticated Hub update API for the current release manifest. When the deployed Runner revision differs, it downloads the packaged add-in, verifies its SHA-256 checksum, and replaces the Runner code, templates, and configuration defaults - straight from the deployed app, no `git` involved at all. It always preserves this workstation's `.env`, `.overridepath`, `deps`, and `temp` folders. Fusion must then be fully quit and reopened before the updated Python modules can run - the add-in shows a message box saying so the moment it finishes staging an update. A failed update check is logged but never prevents an otherwise configured Runner from processing jobs.

The one exception is a symlinked install (see "Prefer a live git checkout" above): self-updating there would silently rewrite files inside that git working tree, so it's skipped entirely - `git pull` is that machine's own, human-timed update path instead.

For box tube, the Runner creates four manually indexed setups (Sides 12, 3, 6, and 9). Only sides containing real operations produce NC files; blank sides remain visible in Fusion without a blank file. Verify the setup side, toolpath direction, and near-wall-only breakthrough in Fusion before cutting a new tube/template combination.

Templates aren't a config file or code change - they're a real Fusion CAM setup someone with machine knowledge has to build once by hand. [`cam-engineering-plan.md`](cam-engineering-plan.md) alongside this file lays out exactly what's needed (tool library, post-processor, the template itself) for whoever's doing that.
