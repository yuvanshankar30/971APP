#!/usr/bin/env python3
"""One-command setup for the Fusion CAM Runner.

Run this with your SYSTEM python3 from anywhere - a repo checkout, or the
add-in folder itself:

    python3 autocam/fusion/runner/setup.py

It does everything: finds (and creates, if Fusion has never made it) Fusion's
AddIns folder for this OS, installs the add-in there under the exact name
Fusion requires, installs `requests` for Fusion's bundled Python - which ships
with no third-party packages - and writes `.env` from a few prompts.

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
import urllib.error
import urllib.request
import uuid

SOURCE_DIR = os.path.dirname(os.path.realpath(__file__))
ADDIN_FOLDER_NAME = "SpartanRoboticsAutoCAM"

DEPLOYED_URL = "https://spartanshub.spartanrobotics.org"
# Vite commonly binds its local dev server on IPv6 loopback (::1).  Fusion's
# bundled requests client treats a literal 127.0.0.1 URL as IPv4-only, which
# then fails with ConnectionRefusedError even though localhost is healthy.
# Let the OS resolve localhost to the server's active loopback family.
LOCAL_URL = "http://localhost:5173"

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
    if platform.system() == "Windows":
        base = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
        path = os.path.join(base, "Autodesk", "Autodesk Fusion 360", "API", "AddIns")
    else:
        path = os.path.expanduser(
            "~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns"
        )
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
        [sys.executable, "-m", "pip", "install", "--target", deps_dir, "requests"],
        check=True,
    )
    with open(os.path.join(addin_dir, ".overridepath"), "w") as f:
        f.write(deps_dir)
    print("Wrote .overridepath")


def prompt(label, default=""):
    suffix = f" [{default}]" if default else ""
    return input(f"{label}{suffix}: ").strip() or default


def register_runner_token(base_url, name):
    """Mints this machine's own unique Runner bearer token.

    Unauthenticated by design - a brand-new Runner has no credential yet,
    so there is nothing to check it against. Direct instruction: the token
    works immediately, no admin-approval step (unlike a newly self-
    registered cam_machines row from register_machine below); see the
    runner_tokens migration's own comment for the tradeoff this accepts.

    Returns the token string on success, or ``None`` if the Hub couldn't be
    reached (offline, wrong URL, etc.) - the caller falls back to the old
    shared FUSION_RUNNER_TOKEN, asked for by hand, in that case.
    """
    request = urllib.request.Request(
        f"{base_url}/api/fusion-runner?action=register-runner",
        data=json.dumps({"name": name}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error", str(exc))
        except (ValueError, UnicodeDecodeError):
            detail = str(exc)
        print(f"  Hub rejected the token request: {detail}")
        return None
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"  Could not reach the Hub to mint a Runner token: {exc}")
        return None
    token = body.get("token")
    if not token:
        print(f"  Hub did not return a token: {body}")
        return None
    return token


def register_machine(base_url, token, name):
    """Get-or-create this machine's real cam_machines row by name.

    Returns (machine_id, created) on success, or None if the Hub couldn't be
    reached (offline, wrong URL, bad token, etc.) - the caller falls back to
    asking for a UUID by hand rather than blocking setup on this call.
    """
    request = urllib.request.Request(
        f"{base_url}/api/fusion-runner?action=register-machine",
        data=json.dumps({"name": name}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error", str(exc))
        except (ValueError, UnicodeDecodeError):
            detail = str(exc)
        print(f"  Hub rejected the machine registration request: {detail}")
        return None
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"  Could not reach the Hub to register this machine: {exc}")
        return None
    machine = body.get("machine") or {}
    machine_id = machine.get("id")
    if not machine_id:
        print(f"  Hub did not return a machine id: {body}")
        return None
    return machine_id, bool(body.get("created"))


def write_env(addin_dir: str) -> None:
    env_file = os.path.join(addin_dir, ".env")
    print()
    print("Which Hub is this Runner talking to?")
    print(f"  1) Deployed Hub ({DEPLOYED_URL}) - normal, real use")
    print(f"  2) Local dev server ({LOCAL_URL}) - only if you know you're testing local changes")
    base_url = LOCAL_URL if prompt("Choose 1 or 2", "1") == "2" else DEPLOYED_URL

    print()
    print("RUNNER_MACHINE_ID is per-device: it says which physical machine(s)")
    print("this computer drives, so this Runner only claims jobs meant for")
    print("those machines. A single computer driving more than one machine")
    print("(e.g. one control laptop shared between two routers) can list")
    print("several, comma-separated.")

    runner_id = prompt("Name for this machine", socket.gethostname() or "fusion-runner")

    print(f"Requesting a Runner token from the Hub for '{runner_id}'...")
    token = register_runner_token(base_url, runner_id)
    if token:
        print("  Got this machine its own unique Runner token - nothing to ask an admin for.")
    else:
        print("Falling back to manual entry.")
        print("FUSION_RUNNER_TOKEN is one shared secret for the whole team - ask a")
        print("project administrator for it. Don't generate your own, and don't")
        print("commit it anywhere.")
        while not token:
            token = prompt("FUSION_RUNNER_TOKEN value")

    print(f"Registering '{runner_id}' with the Hub...")
    registered = register_machine(base_url, token, runner_id)
    if registered:
        machine_id, created = registered
        if created:
            print(f"  Created a new machine profile '{runner_id}' ({machine_id}).")
            print(f"  It's disabled until an admin sets its post-processor and tool")
            print(f"  library and enables it at {base_url}/autocam -> Machines - this")
            print("  Runner can still claim unassigned jobs meant for it in the meantime.")
        else:
            print(f"  Found the existing machine profile '{runner_id}' ({machine_id}).")
    else:
        print("Falling back to manual entry.")
        print(f"Find it at {base_url}/autocam/fusion -> Machines - copy the id(s) of")
        print("the machine(s) this computer is wired to. Comma-separate more than one.")
        machine_id = ""
        while not machine_id:
            candidate = prompt("cam_machines UUID(s) for this physical machine, comma-separated")
            parts = [p.strip() for p in candidate.split(",") if p.strip()]
            try:
                machine_id = ",".join(str(uuid.UUID(p)) for p in parts) if parts else ""
            except ValueError:
                machine_id = ""
                print("  Each entry must be a UUID - it should look like 517ba89c-7167-4415-b6fd-cfc7be1e59e1")

    with open(env_file, "w") as f:
        f.write(f'API_KEY="{token}"\n')
        f.write(f'BASE_URL="{base_url}"\n')
        f.write(f'RUNNER_ID="{runner_id}"\n')
        f.write(f'RUNNER_MACHINE_ID="{machine_id}"\n')
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
        print("Preserved existing Runner configuration (.env); no setup prompts needed.")
    print()
    print("Done. In Fusion: Utilities tab -> Scripts and Add-Ins -> Add-Ins ->")
    print(f"{ADDIN_FOLDER_NAME} -> Run.")
    print()
    print("Changed .env later? Fully quit and relaunch Fusion - Stop/Run alone")
    print("doesn't reliably reload it.")


if __name__ == "__main__":
    main()
