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
import sys
import urllib.parse
import urllib.request
import zipfile

manifest_url, destination = sys.argv[1:]
with urllib.request.urlopen(manifest_url, timeout=30) as response:
    manifest = json.load(response)

expected = str(manifest.get("sha256") or "").strip().lower()
download_url = urllib.parse.urljoin(manifest_url, str(manifest.get("downloadUrl") or ""))
if not re.fullmatch(r"[0-9a-f]{64}", expected) or not download_url:
    raise RuntimeError("Runner download manifest is incomplete")

archive_path = os.path.join(destination, "runner.zip")
digest = hashlib.sha256()
with urllib.request.urlopen(download_url, timeout=60) as response, open(archive_path, "wb") as archive_file:
    while True:
        chunk = response.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        archive_file.write(chunk)
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
