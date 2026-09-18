#!/usr/bin/env python3
"""One-command setup for the Fusion CAM Runner.

Run this with your SYSTEM python3 from anywhere - a repo checkout, or the
add-in folder itself:

    python3 autocam/fusion/runner/setup.py

The deployed Hub also exposes a checksum-verifying bootstrap that downloads
this package and invokes this same setup entry point:

    sh -c "$(curl -fsSL https://spartanshub.spartanrobotics.org/install/fusion-runner)"

It does everything: finds (and creates, if Fusion has never made it) Fusion's
AddIns folder for this OS, installs the add-in there under the exact name
Fusion requires, installs `requests` for Fusion's bundled Python - which ships
with no third-party packages - then opens Spartans Hub for one-token browser
pairing and writes `.env` automatically.

This used to be three chained shell commands the reader had to assemble
themselves (`cp -R ... && cd ... && python3 setup.py`), with a different path
to substitute on Windows. That failed with a bare "No such file or directory"
whenever Fusion's AddIns folder didn't exist yet (a fresh Fusion install never
creates it until you open the Scripts and Add-Ins dialog once) or whenever it
was run from anywhere but the repo root - which is exactly the "the path was
not found" report this replaces. Nothing here needs the reader to know a path.

Deliberately does NOT touch adsk.core/adsk.fusion, so it runs in a normal
terminal rather than Fusion's own interpreter.
"""
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import webbrowser

SOURCE_DIR = os.path.dirname(os.path.realpath(__file__))
ADDIN_FOLDER_NAME = "SpartanRoboticsAutoCAM"

DEPLOYED_URL = "https://spartanshub.spartanrobotics.org"
def default_hub_url() -> str:
    """Use the Hub that served the curl installer when one was provided."""
    return os.environ.get("FUSION_RUNNER_INSTALL_BASE_URL", "").strip() or DEPLOYED_URL

# Never copied into the install: build output and machine-specific config.
# .env/.overridepath are gitignored (so never in a checkout anyway), but are
# listed explicitly so a re-run over an existing install can never clobber
# the credentials already configured there.
COPY_EXCLUDES = shutil.ignore_patterns(
    "__pycache__", "*.pyc", "deps", "temp", ".env", ".overridepath", ".git"
)


def addins_dir() -> str:
    """Fusion's AddIns folder for this OS, created if it doesn't exist yet.

    A fresh Fusion install doesn't create this until the Scripts and Add-Ins
    dialog is opened once, so creating it here is the difference between a
    working setup and a "No such file or directory" that reads like the
    script is broken.
    """
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
        path = os.path.join(base, "Autodesk", "Autodesk Fusion 360", "API", "AddIns")
    elif system == "Darwin":
        path = os.path.expanduser(
            "~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns"
        )
    else:
        raise RuntimeError(f"Fusion Runner setup does not support {system}")
    os.makedirs(path, exist_ok=True)
    return path


def install_addin() -> str:
    """Copy the add-in into Fusion's AddIns folder; return where it now lives.

    Returns the source directory unchanged when it's already the installed
    copy, or when the install is a symlink to a git checkout (the "never
    reinstall again" setup in the team guide) - overwriting either would
    undo the thing the user deliberately set up.
    """
    target_root = addins_dir()
    target = os.path.join(target_root, ADDIN_FOLDER_NAME)

    # islink first: a symlinked install usually points at the very checkout
    # this script is running from, so the realpath comparison below would
    # otherwise match and report it as a plain "already installed".
    if os.path.islink(target):
        print(f"{target} is a symlink to a checkout - leaving it alone, git pull updates it.")
        return os.path.realpath(target)
    if os.path.realpath(target) == os.path.realpath(SOURCE_DIR):
        print(f"Already installed at {target}")
        return target

    print(f"Installing add-in to {target} ...")
    shutil.copytree(SOURCE_DIR, target, ignore=COPY_EXCLUDES, dirs_exist_ok=True)
    return target


def install_requests(addin_dir: str) -> None:
    deps_dir = os.path.join(addin_dir, "deps")
    print(f"Installing 'requests' into {deps_dir} ...")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--target",
            deps_dir,
            "requests",
        ],
        check=True,
    )
    with open(os.path.join(addin_dir, ".overridepath"), "w") as f:
        f.write(deps_dir)
    print("Wrote .overridepath")


def post_json(url, payload, timeout=15):
    """POSTs JSON via curl rather than urllib.request.

    Real, confirmed report: on a stock macOS install of Python from
    python.org (not Homebrew, not the system interpreter), urllib's own
    bundled OpenSSL has no CA trust store configured until the reader runs
    that interpreter's separate "Install Certificates.command" - nothing
    here tells them to do that, and they have no reason to expect this
    setup step needs it. install-runner.sh's own bootstrap hit the exact
    same failure mode fetching the runner archive and was fixed the same
    way - curl uses macOS's own trust store, entirely independent of
    whichever Python interpreter happens to be running this.

    -sSL (no -f/--fail): a non-2xx response still has to reach the status
    handling below to report Spartans Hub's own JSON error detail, which
    -f would suppress along with the exit code.
    """
    result = subprocess.run(
        [
            "curl", "-sSL", "--max-time", str(timeout),
            "-X", "POST",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(payload),
            "-w", "\n%{http_code}",
            url,
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"Could not reach Spartans Hub: curl exited {result.returncode} ({detail or 'no output'})")

    output = result.stdout.decode("utf-8", "replace")
    body_text, _, status_text = output.rpartition("\n")
    try:
        status = int(status_text)
    except ValueError:
        raise RuntimeError(f"Could not reach Spartans Hub: unexpected response {output!r}")

    try:
        body = json.loads(body_text)
    except ValueError:
        body = None

    if status >= 400:
        detail = body.get("error", body_text) if isinstance(body, dict) else (body_text or f"HTTP {status}")
        raise RuntimeError(f"Spartans Hub rejected setup: {detail}")
    return status, body


def pair_runner(base_url, runner_name):
    _, started = post_json(
        f"{base_url}/api/fusion-runner-setup?action=start",
        {"runnerName": runner_name},
    )
    session_id = started.get("sessionId")
    poll_secret = started.get("pollSecret")
    configure_url = started.get("configureUrl")
    if not session_id or not poll_secret or not configure_url:
        raise RuntimeError("Spartans Hub returned an incomplete setup session")

    print(f"Opening {configure_url}")
    if not webbrowser.open(configure_url):
        print("Open the URL above in a browser.")
    print("Waiting for the Fusion Runner token...")

    for _ in range(300):
        status, result = post_json(
            f"{base_url}/api/fusion-runner-setup?action=poll",
            {"sessionId": session_id, "pollSecret": poll_secret},
        )
        if status == 200 and result.get("status") == "complete":
            if result.get("token") and result.get("machineId"):
                return result
            raise RuntimeError("Spartans Hub returned incomplete Runner credentials")
        if status != 202 or result.get("status") != "pending":
            raise RuntimeError(f"Unexpected setup response from Spartans Hub: {result}")
        time.sleep(2)
    raise RuntimeError("Fusion Runner setup expired. Run the install command again.")


def write_env(addin_dir: str) -> None:
    env_file = os.path.join(addin_dir, ".env")
    base_url = default_hub_url().rstrip("/")
    runner_id = socket.gethostname() or "fusion-runner"
    credentials = pair_runner(base_url, runner_id)

    # Direct instruction, after live-testing: a fresh install used to only
    # ever get its own brand-new self-registered machine id, which is never
    # a real router (those are named "New Router"/"UNC Router", not a
    # hostname) - meaning no queued job for a real machine could ever reach
    # it. The setup API now returns every already-enabled real machine's id
    # alongside the self-registered one; write all of them so this Runner
    # can claim real CAM work immediately, the same as every other
    # teammate's install.
    machine_ids = credentials.get("machineIds") or [credentials["machineId"]]

    with open(env_file, "w") as f:
        f.write(f'API_KEY="{credentials["token"]}"\n')
        f.write(f'BASE_URL="{base_url}"\n')
        f.write(f'RUNNER_ID="{runner_id}"\n')
        f.write(f'RUNNER_MACHINE_ID="{",".join(machine_ids)}"\n')
    print(f"Wrote {env_file}")


def needs_configuration(addin_dir: str) -> bool:
    """Whether this is a first install without Runner credentials.

    ``install_addin`` deliberately excludes ``.env`` while copying an
    update.  Do not follow that safe copy with a second interactive setup
    that overwrites the same machine identity and token; an update only
    needs refreshed code and dependencies.
    """
    return not os.path.isfile(os.path.join(addin_dir, ".env"))


def main():
    addin_dir = install_addin()
    install_requests(addin_dir)
    if needs_configuration(addin_dir):
        write_env(addin_dir)
    else:
        print("Preserved existing Runner configuration (.env); no pairing needed.")
    print()
    print("Done. In Fusion: Utilities tab -> Scripts and Add-Ins -> Add-Ins ->")
    print(f"{ADDIN_FOLDER_NAME} -> Run.")
    print()
    print("Changed .env later? Fully quit and relaunch Fusion - Stop/Run alone")
    print("doesn't reliably reload it.")


if __name__ == "__main__":
    main()
