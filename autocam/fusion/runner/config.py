# Application Global Variables
# This module serves as a way to share variables across different
# modules (global variables).
import os
import re
import sys

_ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
_ENV_PATH = os.path.join(_ADDIN_DIR, ".env")

def _read_env_value(key: str) -> str:
    """Read a value from the .env file."""
    pattern = re.compile(rf"^\s*{key}\s*=\s*(?P<value>.*)\s*$")
    try:
        with open(_ENV_PATH, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                match = pattern.match(line)
                if not match:
                    continue
                value = match.group("value").strip()
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]
                return value.strip()
    except FileNotFoundError:
        pass
    return ""

# BASE_URL now points at Spartans Hub's own Fusion CAM job-claim API
# (src/routes/api/fusion-runner/+server.js), not the original AutoCAM
# WebUI - see autocam/fusion/README.md for the full port writeup. Still
# just a plain URL in .env, same as upstream; only the endpoint shape
# changed (see test.py's handleServer and workflows/job_status.py).
BASE_URL = _read_env_value("BASE_URL") or "http://localhost:3000"

# A stable identifier for THIS Runner installation, sent as `runnerId` on
# every claim request - lets cam_jobs.claimed_by actually mean something
# (which physical machine/install claimed a job), not just "some runner."
# Defaults to the machine hostname if not set explicitly in .env.
import socket
RUNNER_ID = _read_env_value("RUNNER_ID") or socket.gethostname() or "fusion-runner"

# Which cam_machines row this physical install actually is (a UUID - look it
# up with `select id, name from cam_machines;` in the Supabase SQL editor).
# Sent as `machineId` on every claim request so /api/fusion-runner only
# hands this Runner jobs meant for THIS machine (or jobs with no specific
# machine assigned). It is required even for one Runner so a later second
# machine cannot silently turn today's permissive setup into a wrong-machine
# claim.
RUNNER_MACHINE_ID = _read_env_value("RUNNER_MACHINE_ID") or None

# .overridepath is how this add-in finds a `pip install --target=...`'d
# copy of `requests` (Fusion's bundled Python has no third-party packages).
# Genuinely missing on first install (git-ignored,
# never checked in) - fail with a clear, actionable message instead of a
# bare FileNotFoundError with no context, same "loud and specific beats
# silent or cryptic" standard the rest of this app holds itself to.
_OVERRIDEPATH_FILE = os.path.join(os.path.dirname(__file__), ".overridepath")
try:
    with open(_OVERRIDEPATH_FILE) as f:
        OVERRIDE_PATH = f.read().strip()
except FileNotFoundError:
    raise RuntimeError(
        f"Missing {_OVERRIDEPATH_FILE} - this add-in needs a `pip install "
        "--target=<some-folder> requests` (Fusion's bundled Python has no "
        "third-party packages) and a .overridepath file containing that "
        "folder's path. Re-run `python3 setup.py` from this add-in folder "
        "to install it automatically; see docs/team-setup-guide.md."
    )

if not os.path.isdir(OVERRIDE_PATH):
    raise RuntimeError(
        f"Dependency path {OVERRIDE_PATH!r} from {_OVERRIDEPATH_FILE} does not exist. "
        "Re-run `python3 setup.py` from this add-in folder to repair it."
    )
if OVERRIDE_PATH not in sys.path:
    # This must happen while config is imported by the add-in entry point,
    # before camPlate/camTube import requests at module load time.
    sys.path.insert(0, OVERRIDE_PATH)

# Which Fusion "project" (top-level entry in the Data Panel) AutoCAM-
# generated documents get saved into. Configurable because
# app.data.dataProjects isn't sorted by relevance or recency - checked
# against this shop's real Fusion account (9 projects) and the upstream
# code's hardcoded `dataProjects.item(1)` resolves to "2020 Robot CAM," a
# years-stale project, never whatever's actually current.
#
# Defaults to "2026 Season CAM" - the team's real, currently-active project,
# confirmed live against the actual account (see resolve_data_project in
# workflows/dropFolder.py for the fallback-to-active-project behavior if
# this project is ever renamed or missing).
FUSION_DATA_PROJECT_NAME = _read_env_value("FUSION_DATA_PROJECT_NAME") or "2026 Season CAM"

# Nested Data Panel folder path (within the resolved project above) that
# AutoCAM-generated Fusion documents get saved into - "/"-separated,
# each segment created automatically if it doesn't already exist. Defaults
# to "Offseason Projects/AutoCAM" - the real folder the team already uses
# for this, confirmed live against the actual account. Was a single
# hardcoded "AutoCAM Drop" string duplicated in camPlate.py and camTube.py;
# centralized in workflows/dropFolder.py so both stay in sync and a team
# can repoint this without touching Python logic.
FUSION_DROP_FOLDER_PATH = _read_env_value("FUSION_DROP_FOLDER_PATH") or "Offseason Projects/AutoCAM"

TEMP_PATH = os.path.join(os.path.dirname(__file__), "temp")
INITIAL_PATH = os.path.join(TEMP_PATH, "initial")
FINAL_PATH = os.path.join(TEMP_PATH, "final")
TOOLS_PATH = os.path.join(TEMP_PATH, "tools")

# Flag that indicates to run in Debug mode or not. When running in Debug mode
# more information is written to the Text Command window. Generally, it's useful
# to set this to True while developing an add-in and set it to False when you
# are ready to distribute it.
DEBUG = True

# Gets the name of the add-in from the name of the folder the py file is in.
# This is used when defining unique internal names for various UI elements
# that need a unique name. It's also recommended to use a company name as
# part of the ID to better ensure the ID is unique.
ADDIN_NAME = os.path.basename(os.path.dirname(__file__))
COMPANY_NAME = "SpartanRobotics971"
# Palettes
sample_palette_id = f"{COMPANY_NAME}_{ADDIN_NAME}_palette_id"
