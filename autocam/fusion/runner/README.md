# Fusion CAM Runner (Spartan Robotics 971)

**The Fusion 360 add-in that turns Spartans Hub's Fusion CAM job queue into real CAM setups and G-code.**

Pairs with Spartans Hub's `/autocam/fusion` section and its `/api/fusion-runner` endpoint — not the original AutoCAM WebUI.

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Autodesk Fusion](https://img.shields.io/badge/Autodesk_Fusion_360-F16529?style=for-the-badge&logo=autodesk&logoColor=white)
![Requests](https://img.shields.io/badge/Requests-2C2C2C?style=for-the-badge&logo=python&logoColor=white)

[**How It Works**](#how-it-works) · [**Installation**](#installation) · [**Configuration**](#configuration) · [**Project Structure**](#project-structure) · [**Development**](#development)

---

**Setting this up on your own machine?** [`docs/team-setup-guide.md`](docs/team-setup-guide.md) is the actual step-by-step walkthrough (including a few real gotchas not covered below). **Building real CAM templates for a machine?** [`docs/cam-engineering-plan.md`](docs/cam-engineering-plan.md) covers what's needed and why.

## Overview

This is Team 971's fork of FRC Team Valor 6800's open-source [AutoCAM Runner](https://github.com/AutoCAM-FRC/Runner), adapted to run against **Spartans Hub** (this repo) instead of the original AutoCAM WebUI. It's the Fusion 360 side of Spartans Hub's **Fusion CAM** section (`/autocam/fusion`) — the real-milling counterpart to the existing pure-JS turning/routing pipeline documented in the repo root's `README.md`.

The add-in polls Spartans Hub's `/api/fusion-runner` endpoint for queued milling jobs, pulls down plate and box-tube jobs, builds Fusion CAM setups from templates, generates toolpaths, exports G-code, and reports completion back to `cam_jobs` in Spartans Hub's own database.

There is no multi-tenant "team"/API-key-scopes concept here — this Runner authenticates with a single shared-secret bearer token that matches Spartans Hub's `FUSION_RUNNER_TOKEN` environment variable (see `src/lib/server/fusion_runner_auth.js`), the same idiom the repo's cron endpoints already use.

An unmodified copy of the original upstream Runner is kept at [`_upstream/`](_upstream/) for reference/diffing — it is never built or loaded by Fusion.

## How It Works

```
Spartans Hub /api/fusion-runner  →  Job Polling  →  Job Queue  →  Router
                                                                  ├─→ plate:cam       →  camPlate
                                                                  ├─→ box_tube        →  camTube
                                                                  └─→ plate:arrange   →  importPlate
```

The add-in runs a background polling thread that claims queued `cam_jobs` rows (`operation_type='milling'`) via a compare-and-swap on `status`, dispatches each job's `params.fusionJobKind` to its workflow, and reports status back to Spartans Hub. STEP files and tooling are downloaded per job, toolpaths are generated in Fusion, and the resulting G-code is posted back as plain text on `cam_jobs.gcode`.

## Features

- **Automatic job polling** — background thread claims queued jobs and dispatches by kind
- **Plate CAM** — downloads STEP files, applies tool libraries, generates toolpaths and G-code
- **Box-tube CAM** — the same flow adapted for tubular stock
- **2D nesting** — auto-arranges parts onto plates with envelope screenshots
- **Auto-orientation** — orients parts largest-face-up before setup
- **Template-driven setups** — reusable Fusion CAM templates for plates and box tubes
- **Status reporting** — completion and errors pushed back to Spartans Hub's `cam_jobs` table

## Requirements

- **Autodesk Fusion 360** (macOS or Windows)
- Python runtime provided by Fusion 360 (the `adsk` modules only exist inside Fusion)
- Network access to a **Spartans Hub** deployment
- The Fusion CAM runner token (matches Spartans Hub's `FUSION_RUNNER_TOKEN` env var — ask whoever manages the deployment)

> **Before you start:** see the repo root's `valor6800-autocam-runner-setup.md` for the full walkthrough, including the `.overridepath`/`requests`-package workaround Fusion's bundled Python needs (Step 4) — that gotcha is unchanged by this fork.

## Installation

Copy this folder into Fusion 360's add-in directory, **renamed to `SpartanRoboticsAutoCAM`** (Fusion requires the folder name, the entry `.py` file, and the `.manifest` file to all match exactly - they're named `SpartanRoboticsAutoCAM.py`/`SpartanRoboticsAutoCAM.manifest`, so the folder has to match or Fusion won't list it as an add-in at all):

```text
# macOS
~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM/

# Windows
%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\SpartanRoboticsAutoCAM\
```

Then open Fusion 360 → **Utilities → Scripts and Add-Ins → Add-Ins**, select **SpartanRoboticsAutoCAM**, and click **Run** (enable *Run on Startup* to launch it automatically).

## Configuration

Copy the example environment file and fill in your deployment values:

```bash
cp .env.example .env
```

| Variable | Purpose | Default |
| --- | --- | --- |
| `API_KEY` | Bearer token matching Spartans Hub's `FUSION_RUNNER_TOKEN` | _(required)_ |
| `BASE_URL` | Spartans Hub deployment base URL | `http://localhost:3000` |
| `RUNNER_ID` | Stable identifier for this Runner install, sent on every claim | machine hostname |
| `RUNNER_MACHINE_ID` | The `cam_machines` row (a UUID) this physical machine is - look it up with `select id, name from cam_machines;` in the Supabase SQL editor | _(blank)_ |
| `FUSION_DATA_PROJECT_NAME` | Which Fusion Data Panel project generated documents get saved into | `2026 Season CAM` |
| `FUSION_DROP_FOLDER_PATH` | Nested folder path (within that project, `/`-separated) generated documents get saved into - each segment created if missing | `Offseason Projects/AutoCAM` |

`API_KEY` is stored locally in `.env` (git-ignored). The add-in can also prompt for the key on startup and write it to `.env` for you.

**Running more than one physical machine at once?** Set `RUNNER_MACHINE_ID` on every install. Without it, a Runner claims *any* queued milling job regardless of which machine it was queued for - fine for a single machine, but a router's Runner could grab a job meant for the mill once two machines are polling at the same time. With `RUNNER_MACHINE_ID` set, a Runner only claims jobs that either target its own machine or don't target a specific machine at all.

## Project Structure

| Path | Purpose |
| --- | --- |
| `SpartanRoboticsAutoCAM.py` | Add-in entry point — API auth, job polling, event dispatch |
| `config.py` | Global settings (paths, base URL, runner ID, debug mode) |
| `commands/` | Fusion 360 UI commands / utility operations |
| `workflows/` | CAM job-processing pipelines |
| `templates/` | Fusion CAM template files (`Plates`, `boxtubes`) |
| `lib/` | Shared Fusion add-in utilities |
| `_upstream/` | Unmodified copy of the original AutoCAM Runner, kept for reference |

### Workflows (`workflows/`)

| Module | Role |
| --- | --- |
| `camPlate.py` | Plate CAM — STEP import, tool libraries, toolpaths, G-code |
| `camTube.py` | Box-tube CAM pipeline |
| `importPlate.py` | Part nesting / arrangement with screenshots |
| `job_status.py` | Reports job status back to Spartans Hub |
| `setupTemp.py` | Setup + temp-file handling |
| `templateTools.py` | Applies tool libraries from templates |

### Commands (`commands/`)

| Module | Role |
| --- | --- |
| `AutoArrange.py` | 2D nesting solver |
| `SetupGenerator.py` | CAM setup creation |
| `NewNCProgram.py` | G-code export |
| `Orientation.py` | Auto-orient parts (largest face up) |
| `HandleTube.py` | Box-tube handling |
| `MultiImport.py` | Multi-part import |
| `DeleteToolpaths.py` | Clear existing toolpaths |
| `ScreenshotEnvelope.py` | Capture envelope screenshots |

## Development

`adsk` modules are only available inside Fusion 360's runtime, so Fusion-specific behavior must be tested inside Fusion. Before opening a PR, validate Python syntax:

```bash
python3 -m compileall -q .
```

Toggle verbose logging to the Fusion **Text Command** window via `DEBUG = True` in `config.py`.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the original upstream pull-request checklist (still broadly applicable to this fork).

## Related

- **[`autocam/fusion/README.md`](../README.md)** — the vendoring/porting writeup for this whole Fusion CAM section
- **[AutoCAM Runner (upstream)](https://github.com/AutoCAM-FRC/Runner)** — the original project this was forked from, by FRC Team Valor 6800

## Security

Please review the **[Security Policy](SECURITY.md)** and report vulnerabilities responsibly rather than opening a public issue.

## License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details. Original work Copyright FRC Team Valor 6800 (AutoCAM-FRC); this fork's changes are adaptations for Spartan Robotics 971's own deployment.
