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

There is no multi-tenant "team"/API-key-scopes concept here — this Runner authenticates with a single shared-secret bearer token that matches Spartans Hub's `FUSION_RUNNER_TOKEN` environment variable (see `src/lib/server/fusion_runner_auth.js`), sourced from its own `FUSION_RUNNER_TOKEN` Secret Manager secret (`cloudbuild.yaml`'s `--set-secrets`) — not shared with Vision Scouting's runner token. The deployment-side secret binding is complete; each Fusion workstation still needs the matching value in its local, gitignored `.env`.

An unmodified copy of the original upstream Runner is kept at [`_upstream/`](_upstream/) for reference/diffing — it is never built or loaded by Fusion.

## How It Works

```
Spartans Hub /api/fusion-runner  →  Job Polling  →  Job Queue  →  Router
                                                                  ├─→ plate:cam       →  camPlate
                                                                  ├─→ box_tube        →  camTube
                                                                  └─→ plate:arrange   →  importPlate
```

The add-in runs a background polling thread that claims queued `cam_jobs` rows (`operation_type='milling'`) via a compare-and-swap on `status`, dispatches each job's `params.fusionJobKind` to its workflow, and reports status back to Spartans Hub. STEP files and tooling are downloaded per job, toolpaths are generated in Fusion, and each whole Fusion Setup is posted once. The resulting files are read as bytes and uploaded separately with their original relative names, sizes, and SHA-256 checksums; the Hub does not decode, annotate, concatenate, or rename Fusion's output.

The Data Panel folder tree is inspected periodically for the web folder picker,
but an unchanged snapshot is not posted or written to the database again.

## Features

- **Automatic job polling** — background thread claims queued jobs and dispatches by kind
- **Plate CAM** — downloads STEP files, applies tool libraries, generates toolpaths and G-code
- **Box-tube CAM** — the same flow adapted for tubular stock
- **2D nesting** — auto-arranges parts onto plates with envelope screenshots
- **Grouping validation** — refuses partial/multi-envelope arrangements and
  quantity mismatches before CAM generation
- **Auto-orientation** — orients parts largest-face-up before setup
- **Template-driven setups** — reusable Fusion CAM templates for plates and box tubes
- **Topology-aware contour repair** — rebuilds stale template selections from the imported model while preserving each internal loop's real direction
- **Safe manual tabs** — disables automatic tabs and places geometry-scaled `0.6 x 0.15 in` tabs only on straight, stock-backed outer edges
- **Exact NC artifacts** — preserves each Fusion-posted file byte for byte instead of joining complete programs together
- **Plate machining-time reporting** — stores Fusion's measured job time for the web queue (box-tube parity is tracked separately)
- **Status reporting** — completion and errors pushed back to Spartans Hub's `cam_jobs` table

## Requirements

- **Autodesk Fusion 360** (macOS or Windows)
- Python runtime provided by Fusion 360 (the `adsk` modules only exist inside Fusion)
- Network access to a **Spartans Hub** deployment
- The Fusion CAM runner token (the deployed `FUSION_RUNNER_TOKEN` value; ask whoever manages the deployment)

> **Full walkthrough:** [`docs/team-setup-guide.md`](docs/team-setup-guide.md) covers install + configuration end to end, including a downloadable pre-built zip from the [Fusion AutoCAM Setup page](/autocam/fusion/setup). The sections below are the short version.

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

Run the one-command setup instead of hand-editing anything - installs `requests` for Fusion's bundled Python (which has no third-party packages of its own) and writes `.env` for you:

```bash
cd "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM"
python3 setup.py
```

It asks which Hub to talk to (deployed, or a local dev server), for your
`FUSION_RUNNER_TOKEN` value, and for this physical machine's `cam_machines`
UUID, then writes `.env` itself - see [`setup.py`](setup.py). Prefer to edit
`.env` by hand instead? `cp .env.example .env` and fill in the same values manually:

| Variable | Purpose | Default |
| --- | --- | --- |
| `API_KEY` | Bearer token matching Spartans Hub's `FUSION_RUNNER_TOKEN` | _(required)_ |
| `BASE_URL` | Spartans Hub deployment base URL | `https://spartanshub.spartanrobotics.org` |
| `RUNNER_ID` | Stable identifier for this Runner install, sent on every claim | machine hostname |
| `RUNNER_MACHINE_ID` | The `cam_machines` row UUID for this physical machine; `setup.py` validates its UUID format | _(required)_ |
| `FUSION_DATA_PROJECT_NAME` | Which Fusion Data Panel project generated documents get saved into | `2026 Season CAM` |
| `FUSION_DROP_FOLDER_PATH` | Nested folder path (within that project, `/`-separated) generated documents get saved into - each segment created if missing | `Offseason Projects/AutoCAM` |

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
| `dropFolder.py` | Resolves/creates the configured Fusion Data Panel destination |
| `localCamAssets.py` | Resolves checked-in tool libraries and postprocessors without web fallbacks |

### Commands (`commands/`)

| Module | Role |
| --- | --- |
| `AutoArrange.py` | 2D nesting solver |
| `GroupingValidation.py` | Rejects incomplete or inconsistent nesting results |
| `SetupGenerator.py` | CAM setup creation |
| `NewNCProgram.py` | G-code export |
| `NcArtifacts.py` | Exact-byte NC artifact collection and checksums |
| `Orientation.py` | Auto-orient parts (largest face up) |
| `HandleTube.py` | Box-tube handling |
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

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the original upstream pull-request checklist (still broadly applicable to this fork).

## Related

- **[`autocam/fusion/README.md`](../README.md)** — the vendoring/porting writeup for this whole Fusion CAM section
- **[AutoCAM Runner (upstream)](https://github.com/AutoCAM-FRC/Runner)** — the original project this was forked from, by FRC Team Valor 6800

## Security

Please review the **[Security Policy](SECURITY.md)** and report vulnerabilities responsibly rather than opening a public issue.

## License

Distributed under the **MIT License**. See [`_upstream/LICENSE`](_upstream/LICENSE) for the original license text (the untouched reference copy - see "How It Works" above). Original work Copyright FRC Team Valor 6800 (AutoCAM-FRC); this fork's changes are adaptations for Spartan Robotics 971's own deployment.
