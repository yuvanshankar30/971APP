#!/bin/sh
set -eu

HUB_URL=${FUSION_RUNNER_HUB_URL:-'__FUSION_HUB_ORIGIN__'}
MANIFEST_URL="$HUB_URL/downloads/SpartanRoboticsAutoCAM-FusionAddIn.manifest.json?install=$(date +%s)"
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fusion-runner-install.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT HUP INT TERM

if ! command -v python3 >/dev/null 2>&1; then
  echo "Fusion AutoCAM requires python3, but it was not found." >&2
  exit 1
fi

echo "Downloading Fusion AutoCAM from $HUB_URL ..."
python3 - "$MANIFEST_URL" "$TEMP_ROOT" <<'PY'
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse
import zipfile

manifest_url, destination = sys.argv[1:]

def curl_fetch(url, timeout, extra_args=()):
    """Fetches over HTTPS via curl rather than urllib.request.

    Real, confirmed report: on a stock macOS install of Python from
    python.org (not Homebrew, not the system interpreter), urllib's own
    bundled OpenSSL has no CA trust store configured until the reader runs
    that interpreter's separate "Install Certificates.command" - something
    nothing here tells them to do, and something they have no reason to
    expect a curl-fetched installer script to require. Every such install
    failed immediately with "CERTIFICATE_VERIFY_FAILED: unable to get
    local issuer certificate" on urllib's very first HTTPS request. curl
    itself already succeeded fetching this very script one line above (it
    uses macOS's own trust store, entirely independent of this Python
    interpreter's), so it does the rest of the downloading too.
    """
    result = subprocess.run(
        ["curl", "-sSL", "--max-time", str(timeout), *extra_args, url],
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"Could not reach {url}: curl exited {result.returncode} ({detail or 'no output'})")
    return result.stdout

manifest = json.loads(curl_fetch(manifest_url, 30))

expected = str(manifest.get("sha256") or "").strip().lower()
download_url = urllib.parse.urljoin(manifest_url, str(manifest.get("downloadUrl") or ""))
if not re.fullmatch(r"[0-9a-f]{64}", expected) or not download_url:
    raise RuntimeError("Runner download manifest is incomplete")

archive_path = os.path.join(destination, "runner.zip")
curl_fetch(download_url, 60, extra_args=["-o", archive_path])
digest = hashlib.sha256()
with open(archive_path, "rb") as archive_file:
    while True:
        chunk = archive_file.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
if digest.hexdigest() != expected:
    raise RuntimeError("Runner download checksum mismatch; refusing to install")

root = os.path.realpath(destination)
with zipfile.ZipFile(archive_path) as archive:
    names = archive.namelist()
    if "SpartanRoboticsAutoCAM/setup.py" not in names:
        raise RuntimeError("Runner archive is missing SpartanRoboticsAutoCAM/setup.py")
    for member in archive.infolist():
        if "\\" in member.filename:
            raise RuntimeError("Runner archive contains an unsafe path")
        target = os.path.realpath(os.path.join(root, member.filename))
        if target != root and not target.startswith(root + os.sep):
            raise RuntimeError("Runner archive contains an unsafe path")
    archive.extractall(root)
PY

SETUP="$TEMP_ROOT/SpartanRoboticsAutoCAM/setup.py"
echo "Download verified. Starting Fusion setup ..."
FUSION_RUNNER_INSTALL_BASE_URL="$HUB_URL" python3 "$SETUP"
