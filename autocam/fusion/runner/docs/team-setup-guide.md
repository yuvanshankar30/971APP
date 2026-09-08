# Setting up Spartans Hub's Fusion CAM Runner

Two things run this: **Spartans Hub** itself (already deployed - where you queue jobs at `/autocam/fusion`) and the **Runner**, a Fusion 360 add-in you install below that polls Spartans Hub for queued jobs and does the CAM work inside Fusion. Without a Runner running, jobs just sit `queued` forever - nothing else in the system generates G-code.

## Install

1. **Run one command.** From a clone of this repo, in a normal terminal (not Fusion):
   ```bash
   python3 autocam/fusion/runner/setup.py
   ```
   That's the whole install. It finds Fusion's AddIns folder for your OS (creating it if Fusion hasn't yet - a fresh Fusion install doesn't make it until you open Scripts and Add-Ins once), copies the add-in in under the exact name Fusion requires, installs `requests` for Fusion's bundled Python, and writes `.env` from a few prompts. Same command on macOS and Windows; you never type or substitute a path.

   It asks for three things:
   - **Which Hub** - the deployed one (normal) or a local dev server. Choose
     local only while testing a checkout running at `http://localhost:5173`;
     `setup.py` deliberately uses `localhost` rather than `127.0.0.1` so the
     Fusion add-in can reach a Vite server that is listening on IPv6 loopback.
   - **`FUSION_RUNNER_TOKEN`** - one shared secret for the whole team. Ask a project administrator; don't generate your own or commit it anywhere.
   - **A name for this machine** - `setup.py` registers it with the Hub automatically (or reuses the existing profile if the name already exists) to get its `RUNNER_MACHINE_ID`; see step 2.

   **Known risk, not yet root-caused:** the `pip install` step builds packages for whatever Python your system defaults to, which may not exactly match Fusion's bundled interpreter's ABI. If the add-in fails to load with an error mentioning `charset_normalizer`, that's the likely cause - ask for help rather than assuming your setup is broken.

   No repo clone? Download the ready-made zip from the [Fusion AutoCAM Setup page](/autocam/fusion/setup), unzip it anywhere, and run `python3 setup.py` from inside it - it installs itself to the right place from there too.

   **Updating an existing install?** Re-run the exact same command. It copies over the existing folder, preserves `.env` and `.overridepath`, and detects that this is an update so it does not ask setup questions or replace your token and machine id. Fully quit and relaunch Fusion after an update; stopping and starting an add-in does not reliably reload its Python modules or `.env`.

   **Missing `.overridepath` or `requests` at startup?** The install was
   copied without its generated dependency folder. From the installed add-in
   directory, run `python3 setup.py` again. It recreates `deps/` and
   `.overridepath`; use the existing Hub, token, and machine-id values when it
   prompts. Then fully quit and relaunch Fusion.

   **Never want to reinstall again?** Point Fusion's AddIns folder at a live git checkout with a symlink, so updates become `git pull` and nothing ever needs copying again:
   ```bash
   git clone https://github.com/frc971/spartanshub.git ~/spartanshub
   ln -s ~/spartanshub/autocam/fusion/runner "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM"
   python3 ~/spartanshub/autocam/fusion/runner/setup.py
   ```
   (Windows: `mklink /D` from an admin Command Prompt instead of `ln -s`.) `setup.py` detects the symlink and leaves it in place rather than copying over it. From then on `cd ~/spartanshub && git pull` picks up every change the moment it lands on `main`. Quit and relaunch Fusion afterward to actually load the new files. `.env`/`.overridepath` live inside `autocam/fusion/runner/` and are gitignored, so `git pull` never touches them.

2. **Know the difference between the two values it asks for.** They are not interchangeable, and this is the step people get wrong:

   | | What it is | Same on every computer? |
   |---|---|---|
   | `FUSION_RUNNER_TOKEN` | The shared secret that lets any Runner talk to the Hub at all | **Yes** - one value for the whole team |
   | `RUNNER_MACHINE_ID` | Which *physical machine* this computer drives | **No** - per device |

   `RUNNER_MACHINE_ID` is the `cam_machines` id of the machine this computer is actually wired to. `setup.py` asks for a name for this machine and registers it with the Hub itself (get-or-create by name, so re-running setup for the same machine reuses the same profile instead of creating a duplicate) - no manual UUID copy-paste needed. A newly created profile starts **disabled**: it can still claim unassigned jobs, but an admin needs to set its post-processor and tool library and enable it at **`/autocam` -> Machines** before it can be targeted for a specific machine's jobs. If the Hub can't be reached during setup (offline, wrong URL), it falls back to asking for an existing machine's UUID by hand from **`/autocam/fusion` -> Machines**.

   It matters because a Runner only claims jobs meant for its own machine (or jobs left unassigned). Give two workstations the same machine id and the router's Runner can pick up a job queued for the mill - which is why it's required rather than optional.

3. **Enable it in Fusion:** Utilities tab -> Scripts and Add-Ins -> **Add-Ins** tab -> **SpartanRoboticsAutoCAM** -> Run. ("Utilities" was called "Tools" before a 2022 Fusion update, in case an old tutorial says that instead.)

4. **Confirm it's running:** open the Text Command window (Option+Cmd+C on Mac, or View -> Show/Hide Text Commands) - you should see it polling every few seconds.

Running more than one machine at once is safe: claiming is a compare-and-swap,
so two Runners cannot grab the same job.

**Changed `.env` again later?** Fully quit and relaunch Fusion - Stop/Run alone doesn't reliably reload it.

## How it works

Queuing a job in the web UI (`/autocam/fusion`) just inserts a `queued` row into `cam_jobs`. The Runner polls `/api/fusion-runner` every few seconds, claims a queued row (compare-and-swap, so two Runners never grab the same job), and downloads the part's STEP file. It then imports that geometry into a fresh Fusion document, applies a pre-built Fusion CAM template - feeds/speeds/tool assignments someone built once by hand in Fusion's own CAM workspace, not a machining strategy invented from scratch - patches in the selected tool library and reviewed material feed/speed preset, generates toolpaths, exports G-code with the machine's post-processor, and reports the result back so the Job Queue tab shows `completed` (with a G-code download) or `failed` (with the real error). A material without a reviewed preset is rejected instead of receiving guessed feeds.

Brief API connection resets are retried automatically with bounded backoff. If
the Text Command window shows a reset repeatedly, check the network or the
server; do not restart Fusion just for one transient reset.

For box tube, the Runner creates four manually indexed setups (Sides 12, 3, 6, and 9). Only sides containing real operations produce NC files; blank sides remain visible in Fusion without a blank file. Verify the setup side, toolpath direction, and near-wall-only breakthrough in Fusion before cutting a new tube/template combination.

Templates aren't a config file or code change - they're a real Fusion CAM setup someone with machine knowledge has to build once by hand. [`cam-engineering-plan.md`](cam-engineering-plan.md) alongside this file lays out exactly what's needed (tool library, post-processor, the template itself) for whoever's doing that.
