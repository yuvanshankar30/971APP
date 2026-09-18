# Fusion CAM Runner (Spartan Robotics 971)

**The Fusion 360 add-in that turns Spartans Hub's Fusion CAM job queue into real CAM setups and G-code.**

Pairs with Spartans Hub's `/autocam/fusion/parts` section and its `/api/fusion-runner` endpoint — not the original AutoCAM WebUI.

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Autodesk Fusion](https://img.shields.io/badge/Autodesk_Fusion_360-F16529?style=for-the-badge&logo=autodesk&logoColor=white)
![Requests](https://img.shields.io/badge/Requests-2C2C2C?style=for-the-badge&logo=python&logoColor=white)

[**How It Works**](#how-it-works) · [**Installation**](#installation) · [**Configuration**](#configuration) · [**Project Structure**](#project-structure) · [**Development**](#development)

---

**Setting this up on your own machine?** [`docs/team-setup-guide.md`](docs/team-setup-guide.md) is the actual step-by-step walkthrough (including a few real gotchas not covered below). **Building real CAM templates for a machine?** [`docs/cam-engineering-plan.md`](docs/cam-engineering-plan.md) covers what's needed and why.

## Overview

This is Team 971's Fusion CAM Runner, built to run against **Spartans Hub** (this repo). It is the Fusion 360 side of Spartans Hub's **Fusion AutoCAM** section (`/autocam/fusion/parts`) — the real-milling counterpart to the existing pure-JS turning/routing pipeline documented in the repo root's `README.md`.

The add-in polls Spartans Hub's `/api/fusion-runner` endpoint for queued milling jobs, pulls down plate and box-tube jobs, builds Fusion CAM setups from templates, generates toolpaths, exports G-code, and reports completion back to `cam_jobs` in Spartans Hub's own database.

Each install mints its own Runner bearer token during setup and stores it in
the workstation's gitignored `.env`. The server can revoke those tokens
individually; the legacy deployment-wide `FUSION_RUNNER_TOKEN` remains only
as an offline setup fallback and is separate from Vision Scouting auth.


## How It Works

```
Spartans Hub /api/fusion-runner  →  Job Polling  →  Job Queue  →  Router
                                                                  ├─→ plate:cam       →  camPlate
                                                                  ├─→ box_tube        →  camTube
                                                                  └─→ plate:arrange   →  importPlate
```

The add-in runs a background polling thread that claims queued `cam_jobs` rows (`operation_type='milling'`) via a compare-and-swap on `status`, dispatches each job's `params.fusionJobKind` to its workflow, and reports status back to Spartans Hub. STEP files and tooling are downloaded per job, toolpaths are generated in Fusion, and each whole Fusion Setup is posted once. The resulting files are read as bytes and uploaded separately with their original relative names, sizes, and SHA-256 checksums; the Hub does not decode, annotate, concatenate, or rename Fusion's output. On completion, every NC artifact is automatically copied to Files `AutoCAM`; a tube job gets a job-ID subfolder with exactly four per-setup programs (Sides 12, 3, 6, and 9).

The Data Panel folder tree is inspected periodically from the configured
`2026 Season CAM` project root for the web folder picker, including while CAM
jobs are running. An unchanged snapshot is not posted or written to the
database again.

## Features

- **Automatic job polling** — background thread claims queued jobs and dispatches by kind
- **Plate CAM** — downloads STEP files, applies tool libraries, generates toolpaths and G-code
- **Box-tube CAM** — a geometry-derived rectangular-tube workflow: four
  face-scoped Fusion setups are posted as `-side-12`, `-side-3`, `-side-6`,
  and `-side-9` programs for manual indexing, never as one unsafe all-face
  program
- **2D nesting** — auto-arranges parts onto plates with envelope screenshots
- **Grouping validation** — refuses partial/multi-envelope arrangements and
  quantity mismatches before CAM generation
- **Auto-orientation** — orients parts largest-face-up before setup
- **Template-driven setups** — reusable Fusion CAM templates for plates and box tubes
- **Topology-aware contour repair** — rebuilds stale template selections from the imported model while preserving each internal loop's real direction
- **Manual release tabs** — restores the established explicit-tab placement
  behavior on straight outer release edges. It prefers stock-backed edges
  when that information is available, but retains a legacy fallback so a
  valid release contour is never silently left without manual-tab points.
  Width is capped for the narrowest nested part and height at 70% of the
  thinnest nested stock.
- **Exact NC artifacts** — preserves each Fusion-posted file byte for byte instead of joining complete programs together
- **Plate machining-time reporting** — stores Fusion's measured job time for the web queue (box-tube parity is tracked separately)
- **Status reporting** — completion and errors pushed back to Spartans Hub's `cam_jobs` table
- **Managed updates** — checks the authenticated release manifest at add-in startup, verifies the Runner zip checksum, and preserves local credentials/dependencies while staging a newer release for the next Fusion restart

## Requirements

- **Autodesk Fusion 360** (macOS or Windows)
- **Python 3** and `curl` for the one-command installer
- Python runtime provided by Fusion 360 (the `adsk` modules only exist inside Fusion)
- Network access to a **Spartans Hub** deployment

> **Full walkthrough:** [`docs/team-setup-guide.md`](docs/team-setup-guide.md) covers install + configuration end to end, including a downloadable pre-built zip from the [Fusion AutoCAM Setup page](/autocam/fusion/setup). The sections below are the short version.

## Installation

Install the current checksum-verified package directly from Spartans Hub:

```bash
sh -c "$(curl -fsSL https://spartanshub.spartanrobotics.org/install/fusion-runner)"
```

The installer downloads the release served by that Hub, verifies it before
extraction, copies it into Fusion's platform-specific AddIns directory, and
opens a Spartans Hub page. Enter the team Fusion Runner token in its only
field; the installer handles the workstation name, machine registration, and
local `.env` automatically. The manual paths below are retained for
offline/troubleshooting use.

After installation, updates require no download or command: the add-in checks
the authenticated Hub at Fusion startup and every five idle minutes, verifies
the release checksum, installs it into the same AddIns folder, and stops new
job claims until Fusion is restarted to load the new Python modules.

Copy this folder into Fusion 360's add-in directory, **renamed to `SpartanRoboticsAutoCAM`** (Fusion requires the folder name, the entry `.py` file, and the `.manifest` file to all match exactly - they're named `SpartanRoboticsAutoCAM.py`/`SpartanRoboticsAutoCAM.manifest`, so the folder has to match or Fusion won't list it as an add-in at all):

```text
# macOS
~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM/

# Windows
%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\SpartanRoboticsAutoCAM\
```

Then open Fusion 360 → **Utilities → Scripts and Add-Ins → Add-Ins**, select **SpartanRoboticsAutoCAM**, and click **Run** (enable *Run on Startup* to launch it automatically).

## Configuration

Run the one-command setup instead of hand-editing anything - installs `requests` for Fusion's bundled Python (which has no third-party packages of its own) and writes `.env` for you:

```bash
cd "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM"
python3 setup.py
```

It opens that Hub's short-lived pairing page and waits while the token is
entered there. The Hub mints a per-install credential and registers or reuses
the hostname's `cam_machines` row before `setup.py` writes `.env` - see
[`setup.py`](setup.py). For local testing, set
`FUSION_RUNNER_INSTALL_BASE_URL=http://localhost:5173` when running `setup.py`.
Prefer to edit `.env` by hand instead? `cp .env.example .env` and fill in the
same values manually:

| Variable | Purpose | Default |
| --- | --- | --- |
| `API_KEY` | Per-install Runner bearer token returned directly to `setup.py` after browser pairing | _(required)_ |
| `BASE_URL` | Spartans Hub deployment base URL | `https://spartanshub.spartanrobotics.org` |
| `RUNNER_ID` | Stable identifier for this Runner install, sent on every claim | machine hostname |
| `RUNNER_MACHINE_ID` | The `cam_machines` row UUID registered or reused automatically from the workstation hostname during browser pairing | _(required)_ |
| `FUSION_DATA_PROJECT_NAME` | Which Fusion Data Panel project generated documents get saved into | `2026 Season CAM` |
| `FUSION_DROP_FOLDER_PATH` | Nested folder path (within that project, `/`-separated) generated documents get saved into - each segment created if missing | project root |

`.env` is git-ignored either way - never commit a real token.

`RUNNER_MACHINE_ID` is mandatory even with one Runner. The server refuses a
claim without it, eliminating the old claim-any-machine fallback. While Fusion
works, the add-in sends a heartbeat every 30 seconds. A claim that expires
before Fusion starts is retried after 15 minutes; an expired processing job is
left for an operator to review so its CAM work cannot be duplicated.

## Project Structure

| Path | Purpose |
| --- | --- |
| `SpartanRoboticsAutoCAM.py` | Add-in entry point — API auth, job polling, event dispatch |
| `config.py` | Global settings (paths, base URL, runner ID, debug mode) |
| `commands/` | Fusion 360 UI commands / utility operations |
| `workflows/` | CAM job-processing pipelines |
| `templates/` | Generic templates plus reviewed machine/material templates under `971-real/` |
| `lib/` | Shared Fusion add-in utilities |

### Workflows (`workflows/`)

| Module | Role |
| --- | --- |
| `camPlate.py` | Plate CAM — STEP import, tool libraries, toolpaths, G-code |
| `camTube.py` | Box-tube CAM pipeline |
| `importPlate.py` | Part nesting / arrangement with screenshots |
| `job_status.py` | Reports job status back to Spartans Hub |
| `setupTemp.py` | Setup + temp-file handling |
| `templateTools.py` | Applies tool libraries from templates |
| `dropFolder.py` | Resolves/creates the configured Fusion Data Panel destination |
| `localCamAssets.py` | Resolves checked-in tool libraries and postprocessors without web fallbacks |
| `machiningTime.py` | Uses Fusion's real CAM API to report plate and box-tube machining time consistently |

### Commands (`commands/`)

| Module | Role |
| --- | --- |
| `AutoArrange.py` | 2D nesting solver |
| `GroupingValidation.py` | Rejects incomplete or inconsistent nesting results |
| `SetupGenerator.py` | CAM setup creation |
| `NewNCProgram.py` | G-code export - posts through Fusion's NCProgram API so each setup's program is written to disk *and* kept as a persistent entry (named `<document name> AUTOCAM`) under the document's own "NC Programs" browser folder, not just as a file in `FINAL_PATH`/Output. The post itself still has to be resolved from Fusion's local post library by matching its bundled `.cps`'s own `description =` string (see `_resolve_post_configuration`) - there's no API to hand it an arbitrary local file path directly. |
| `NcArtifacts.py` | Exact-byte NC artifact collection and checksums |
| `Orientation.py` | Auto-orient parts (largest face up) |
| `HandleTube.py` | Box-tube setups: WCS, G55, hole/shape rebinding, tube cutoff (see [`docs/tubestock-cam.md`](docs/tubestock-cam.md)) |
| `TubeWcsMath.py` | Pure tube WCS rule: X along the tube, right-hand origin corner |
| `TubeHeightMath.py` | Pure tube depth math: near-wall depth, cutoff breakthrough |
| `TubeFacePrograms.py` | Tube setup and program names (Sides 12/3/6/9) |
| `MultiImport.py` | Multi-part import |
| `DeleteToolpaths.py` | Clear existing toolpaths |
| `ContourChains.py` | Preserve face-loop direction when rebuilding contour selections |
| `ScreenshotEnvelope.py` | Capture envelope screenshots |

## Development

`adsk` modules are only available inside Fusion 360's runtime, so Fusion-specific behavior must be tested inside Fusion. Before opening a PR, validate Python syntax:

```bash
python3 -m compileall -q .
```

Toggle verbose logging to the Fusion **Text Command** window via `DEBUG = True` in `config.py`.

For the contour-chain direction rule and its live-Fusion validation steps, see
[`docs/contour-chain-direction.md`](docs/contour-chain-direction.md).
## Related

- **[`autocam/fusion/README.md`](../README.md)** — the Fusion CAM architecture writeup
- **[`docs/team-setup-guide.md`](docs/team-setup-guide.md)** — install and configuration instructions
- **[`docs/tubestock-cam.md`](docs/tubestock-cam.md)** — box-tube CAM: WCS, G55, holes, tube cutoff, running a job, and how it is verified

## Security

Report security concerns privately to the project maintainers rather than opening a public issue.
