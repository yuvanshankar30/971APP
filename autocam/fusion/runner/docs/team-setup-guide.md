# Setting up Spartans Hub's Fusion CAM Runner

Two things run this: **Spartans Hub** itself (already deployed - where you queue jobs at `/autocam/fusion`) and the **Runner**, a Fusion 360 add-in you install below that polls Spartans Hub for queued jobs and does the CAM work inside Fusion. Without a Runner running, jobs just sit `queued` forever - nothing else in the system generates G-code.

## Install

1. **Install and run setup in one step.** This copies the add-in into Fusion's AddIns folder (named exactly `SpartanRoboticsAutoCAM` - required, no spaces, or Fusion won't list it) and immediately runs its setup, which installs `requests` for Fusion's Python and writes `.env` (no manual editing):
   ```bash
   cp -R autocam/fusion/runner "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM" && cd "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM" && python3 setup.py
   ```
   (Windows: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\SpartanRoboticsAutoCAM` in place of the `cp -R`/`cd` target, `copy` instead of `cp -R`.)

   It'll ask which Hub to talk to (deployed, or local dev) and for your `FUSION_RUNNER_TOKEN` value (ask a project administrator - don't generate your own or commit one anywhere) - then writes everything itself.

   **Known risk, not yet root-caused:** the `pip install` step builds packages for whatever Python your system defaults to, which may not exactly match Fusion's bundled interpreter's ABI. If the add-in fails to load with an error mentioning `charset_normalizer`, that's the likely cause - ask for help rather than assuming your setup is broken.

   Or download the ready-made zip from the [Fusion AutoCAM Setup page](/autocam/fusion/setup), unzip it into the AddIns folder above (already named correctly), then run `python3 setup.py` from inside it.

   **Updating an existing install?** Re-run the same command (or re-download+unzip, then `setup.py` again) over the existing folder - your `.env`/`.overridepath` are untouched as long as nothing you run deletes extra files first.

   **Never want to reinstall again?** Point Fusion's AddIns folder at a live git checkout with a symlink instead of copying files - updates then become `git pull`, no copying or re-downloading, ever:
   ```bash
   git clone https://github.com/frc971/spartanshub.git ~/spartanshub && ln -s ~/spartanshub/autocam/fusion/runner "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM" && cd ~/spartanshub/autocam/fusion/runner && python3 setup.py
   ```
   (Windows: use `mklink /D` from an admin Command Prompt instead of `ln -s`.) From then on, `cd ~/spartanshub && git pull` picks up every change the moment it lands on `main` - Fusion loads through the symlink, so there's nothing left to copy. Quit and relaunch Fusion afterward (same as any `.env`/code change - see below) to actually pick up the new files. `.env`/`.overridepath` live inside `autocam/fusion/runner/` itself, so they're gitignored and untouched by `git pull` either way.

2. **Enable it in Fusion:** Utilities tab -> Scripts and Add-Ins -> **Add-Ins** tab -> **SpartanRoboticsAutoCAM** -> Run. ("Utilities" was called "Tools" before a 2022 Fusion update, in case an old tutorial says that instead.)

3. **Confirm it's running:** open the Text Command window (Option+Cmd+C on Mac, or View -> Show/Hide Text Commands) - you should see it polling every few seconds.

Ran more than one machine at once? Safe to do - claiming a job is a compare-and-swap, so two Runners can never grab the same one. Give each machine its own `RUNNER_ID` in `.env` (`setup.py` asks for this); only set `RUNNER_MACHINE_ID` too if that machine should exclusively claim jobs meant for one specific `cam_machines` row.

**Changed `.env` again later?** Fully quit and relaunch Fusion - Stop/Run alone doesn't reliably reload it.

## How it works

Queuing a job in the web UI (`/autocam/fusion`) just inserts a `queued` row into `cam_jobs`. The Runner polls `/api/fusion-runner` every few seconds, claims a queued row (compare-and-swap, so two Runners never grab the same job), and downloads the part's STEP file. It then imports that geometry into a fresh Fusion document, applies a pre-built Fusion CAM template - feeds/speeds/tool assignments someone built once by hand in Fusion's own CAM workspace, not a machining strategy invented from scratch - patches in the job's selected tool library, generates toolpaths, exports G-code with the machine's post-processor, and reports the result back so the Job Queue tab shows `completed` (with a G-code download) or `failed` (with the real error).

Templates aren't a config file or code change - they're a real Fusion CAM setup someone with machine knowledge has to build once by hand. [`cam-engineering-plan.md`](cam-engineering-plan.md) alongside this file lays out exactly what's needed (tool library, post-processor, the template itself) for whoever's doing that.
