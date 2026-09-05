#!/usr/bin/env python3
"""One-command setup for the Fusion CAM Runner: installs `requests` for
Fusion's bundled Python (which has no third-party packages - writes
.overridepath so config.py can find it) and writes .env, replacing "copy
.env.example, then hand-edit it" with a couple of prompts.

Run with your SYSTEM python3, not Fusion's own bundled interpreter - this
doesn't touch adsk.core/adsk.fusion at all, so it works from a normal
terminal. Run it from inside the add-in folder, after copying it into
Fusion's AddIns directory as SpartanRoboticsAutoCAM (see the setup guide's
own Step 1) - it writes .env/.overridepath alongside itself either way.
"""
import os
import socket
import subprocess
import sys

ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
DEPS_DIR = os.path.join(ADDIN_DIR, "deps")
OVERRIDEPATH_FILE = os.path.join(ADDIN_DIR, ".overridepath")
ENV_FILE = os.path.join(ADDIN_DIR, ".env")

DEPLOYED_URL = "https://spartanshub.spartanrobotics.org"
LOCAL_URL = "http://127.0.0.1:5173"


def install_requests():
    print(f"Installing 'requests' into {DEPS_DIR} ...")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--target", DEPS_DIR, "requests"],
        check=True,
    )
    with open(OVERRIDEPATH_FILE, "w") as f:
        f.write(DEPS_DIR)
    print(f"Wrote {OVERRIDEPATH_FILE}")


def prompt(label, default=""):
    suffix = f" [{default}]" if default else ""
    return input(f"{label}{suffix}: ").strip() or default


def write_env():
    print()
    print("Which Hub is this Runner talking to?")
    print(f"  1) Deployed Hub ({DEPLOYED_URL}) - normal, real use")
    print(f"  2) Local dev server ({LOCAL_URL}) - only if you know you're testing local changes")
    base_url = LOCAL_URL if prompt("Choose 1 or 2", "1") == "2" else DEPLOYED_URL

    token = ""
    while not token:
        token = prompt("FUSION_RUNNER_TOKEN value (ask a project administrator)")

    runner_id = prompt("Name for this machine", socket.gethostname() or "fusion-runner")

    with open(ENV_FILE, "w") as f:
        f.write(f'API_KEY="{token}"\n')
        f.write(f'BASE_URL="{base_url}"\n')
        f.write(f'RUNNER_ID="{runner_id}"\n')
        f.write('RUNNER_MACHINE_ID=""\n')
        f.write("# Only needed if more than one physical machine polls at once - see\n")
        f.write("# .env.example for what it's for and how to find the right value.\n")
    print(f"Wrote {ENV_FILE}")


def main():
    install_requests()
    write_env()
    print()
    print("Done. In Fusion: Utilities tab -> Scripts and Add-Ins -> Add-Ins -> SpartanRoboticsAutoCAM -> Run.")
    print("Changed .env again later? Fully quit and relaunch Fusion - Stop/Run alone doesn't reliably reload it.")


if __name__ == "__main__":
    main()
