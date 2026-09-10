import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from RunnerUpdate import check_and_stage_update  # noqa: E402


class _Response:
    def __init__(self, payload=None, content=b""):
        self.payload = payload
        self.content = content

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload

    def iter_content(self, _chunk_size):
        yield self.content


class _Session:
    def __init__(self, manifest_url, manifest, archive):
        self.manifest_url = manifest_url
        self.manifest = manifest
        self.archive = archive
        self.download_url = None

    def post(self, _url, **_kwargs):
        return _Response({"manifestUrl": self.manifest_url})

    def get(self, url, **_kwargs):
        if url == self.manifest_url:
            return _Response(self.manifest)
        self.download_url = url
        return _Response(content=self.archive)


def _archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


class RunnerUpdateTests(unittest.TestCase):
    def test_installs_a_verified_release_but_preserves_machine_files(self):
        archive = _archive({
            "SpartanRoboticsAutoCAM/runner_release.json": json.dumps({"version": "2"}),
            "SpartanRoboticsAutoCAM/updated.py": "new code",
            "SpartanRoboticsAutoCAM/.env": "remote secret",
            "SpartanRoboticsAutoCAM/deps/remote.txt": "remote dependency",
        })
        manifest = {"version": "2", "downloadUrl": "/downloads/runner.zip", "sha256": hashlib.sha256(archive).hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            addin = Path(directory) / "addin"
            addin.mkdir()
            (addin / "runner_release.json").write_text('{"version":"1"}')
            (addin / ".env").write_text("local secret")
            (addin / "deps").mkdir()
            (addin / "deps" / "local.txt").write_text("local dependency")
            session = _Session("https://hub.example/downloads/manifest.json", manifest, archive)

            self.assertEqual(check_and_stage_update(session, "https://hub.example", str(addin)), "2")
            self.assertEqual((addin / "updated.py").read_text(), "new code")
            self.assertEqual((addin / ".env").read_text(), "local secret")
            self.assertEqual((addin / "deps" / "local.txt").read_text(), "local dependency")
            self.assertEqual(session.download_url, "https://hub.example/downloads/runner.zip")

    def test_rejects_a_checksum_mismatch_before_installing(self):
        archive = _archive({"SpartanRoboticsAutoCAM/runner_release.json": '{"version":"2"}'})
        manifest = {"version": "2", "downloadUrl": "runner.zip", "sha256": "0" * 64}
        with tempfile.TemporaryDirectory() as directory:
            addin = Path(directory) / "addin"
            addin.mkdir()
            (addin / "runner_release.json").write_text('{"version":"1"}')
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                check_and_stage_update(_Session("https://hub.example/manifest.json", manifest, archive), "https://hub.example", str(addin))

    def test_rejects_a_malformed_checksum_before_downloading(self):
        manifest = {"version": "2", "downloadUrl": "runner.zip", "sha256": "z" * 64}
        with tempfile.TemporaryDirectory() as directory:
            addin = Path(directory) / "addin"
            addin.mkdir()
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                check_and_stage_update(_Session("https://hub.example/manifest.json", manifest, b""), "https://hub.example", str(addin))

    def test_never_touches_a_symlinked_install(self):
        # The "never reinstall again" team-guide setup points Fusion's
        # AddIns folder at a live git checkout via a symlink; git pull is
        # that machine's own update path. Self-updating would overwrite
        # files inside the checkout, leaving uncommitted local changes a
        # later git pull could conflict with - this must be a pure no-op,
        # with no network call at all.
        session = _Session("https://hub.example/manifest.json", {"version": "2"}, b"")
        with tempfile.TemporaryDirectory() as directory:
            addin = Path(directory) / "addin"
            addin.mkdir()
            (addin / "runner_release.json").write_text('{"version":"1"}')
            result = check_and_stage_update(session, "https://hub.example", str(addin), symlinked=True)
        self.assertIsNone(result)
        self.assertIsNone(session.download_url)
