"""Checksum-verified self-update support for the Fusion AutoCAM Runner.

This module intentionally uses only Python's standard library. It runs in
Fusion's bundled interpreter before a CAM job is claimed and never replaces
machine-local credentials, dependencies, or temporary job artifacts.
"""
import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from urllib.parse import urljoin


_PROTECTED_PATHS = {".env", ".overridepath", "deps", "temp"}


def local_version(addin_dir):
    try:
        with open(os.path.join(addin_dir, "runner_release.json"), encoding="utf-8") as f:
            return str(json.load(f).get("version") or "0")
    except (OSError, ValueError, TypeError):
        return "0"


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_release(source_dir, addin_dir):
    for entry in os.listdir(source_dir):
        if entry in _PROTECTED_PATHS:
            continue
        source = os.path.join(source_dir, entry)
        destination = os.path.join(addin_dir, entry)
        if os.path.isdir(source):
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(source, destination)


def _safe_extract(archive, destination):
    destination = os.path.realpath(destination)
    for member in archive.infolist():
        target = os.path.realpath(os.path.join(destination, member.filename))
        if target != destination and not target.startswith(destination + os.sep):
            raise RuntimeError("Runner update archive contains an unsafe path")
    archive.extractall(destination)


def check_and_stage_update(session, base_url, addin_dir, timeout=30):
    """Install a newer remote release and return its version, else ``None``.

    ``session`` already carries the Runner bearer token. The API gives the
    manifest URL only to an authenticated Runner; the manifest supplies the
    immutable artifact URL and its SHA-256 digest.
    """
    response = session.post(
        "{}/api/fusion-runner?action=update-manifest".format(base_url.rstrip("/")),
        json={},
        timeout=timeout,
    )
    response.raise_for_status()
    manifest_url = response.json().get("manifestUrl")
    if not manifest_url:
        raise RuntimeError("Runner update API did not provide a manifest URL")

    manifest_response = session.get(manifest_url, timeout=timeout)
    manifest_response.raise_for_status()
    manifest = manifest_response.json()
    remote_version = str(manifest.get("version") or "").strip()
    download_url = manifest.get("downloadUrl")
    expected_sha256 = str(manifest.get("sha256") or "").lower()
    if (
        not remote_version
        or not download_url
        or len(expected_sha256) != 64
        or any(char not in "0123456789abcdef" for char in expected_sha256)
    ):
        raise RuntimeError("Runner update manifest is incomplete")
    if remote_version == local_version(addin_dir):
        return None

    with tempfile.TemporaryDirectory(prefix="fusion-runner-update-") as temp_dir:
        archive = os.path.join(temp_dir, "runner.zip")
        download = session.get(urljoin(manifest_url, download_url), timeout=timeout, stream=True)
        download.raise_for_status()
        with open(archive, "wb") as f:
            for chunk in download.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)
        actual_sha256 = _sha256(archive)
        if actual_sha256 != expected_sha256:
            raise RuntimeError("Runner update checksum mismatch; refusing to install it")
        with zipfile.ZipFile(archive) as zf:
            root = "SpartanRoboticsAutoCAM/"
            if not any(name.startswith(root) for name in zf.namelist()):
                raise RuntimeError("Runner update archive has no add-in root")
            _safe_extract(zf, temp_dir)
        _copy_release(os.path.join(temp_dir, "SpartanRoboticsAutoCAM"), addin_dir)
    return remote_version
