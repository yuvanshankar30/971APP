from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import patch
import json
import os
import subprocess
import tempfile
import unittest


RUNNER_DIR = Path(__file__).parents[1]
spec = spec_from_file_location("fusion_runner_setup", RUNNER_DIR / "setup.py")
setup = module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupUpdateTests(unittest.TestCase):
    def test_macos_install_path_is_fusions_real_addins_directory(self):
        expected = "/Users/operator/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns"
        with patch.object(setup.platform, "system", return_value="Darwin"), patch.object(
            setup.os.path, "expanduser", return_value=expected
        ), patch.object(setup.os, "makedirs") as makedirs:
            self.assertEqual(setup.addins_dir(), expected)
        makedirs.assert_called_once_with(expected, exist_ok=True)

    def test_windows_install_path_uses_roaming_appdata(self):
        appdata = r"C:\Users\operator\AppData\Roaming"
        expected = os.path.join(appdata, "Autodesk", "Autodesk Fusion 360", "API", "AddIns")
        with patch.object(setup.platform, "system", return_value="Windows"), patch.dict(
            os.environ, {"APPDATA": appdata}
        ), patch.object(setup.os, "makedirs") as makedirs:
            self.assertEqual(setup.addins_dir(), expected)
        makedirs.assert_called_once_with(expected, exist_ok=True)

    def test_installer_copies_into_the_required_fusion_addin_name(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "download", "SpartanRoboticsAutoCAM")
            source.mkdir(parents=True)
            Path(source, "SpartanRoboticsAutoCAM.py").write_text("runner")
            addins = Path(directory, "Fusion", "API", "AddIns")
            addins.mkdir(parents=True)
            with patch.object(setup, "SOURCE_DIR", str(source)), patch.object(
                setup, "addins_dir", return_value=str(addins)
            ):
                installed = setup.install_addin()
            expected = addins / "SpartanRoboticsAutoCAM"
            self.assertEqual(Path(installed), expected)
            self.assertEqual(Path(expected, "SpartanRoboticsAutoCAM.py").read_text(), "runner")

    def test_existing_env_marks_an_install_as_an_update(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(setup.needs_configuration(directory))
            Path(directory, ".env").write_text('API_KEY="existing"\n')
            self.assertFalse(setup.needs_configuration(directory))

    def test_curl_installer_origin_becomes_the_default_hub(self):
        with patch.dict(os.environ, {"FUSION_RUNNER_INSTALL_BASE_URL": "https://staging.example"}):
            self.assertEqual(setup.default_hub_url(), "https://staging.example")

    def test_blank_installer_origin_falls_back_to_production(self):
        with patch.dict(os.environ, {"FUSION_RUNNER_INSTALL_BASE_URL": "  "}):
            self.assertEqual(setup.default_hub_url(), setup.DEPLOYED_URL)

    def test_dependency_reinstall_upgrades_the_existing_target(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            setup.subprocess, "run"
        ) as run:
            setup.install_requests(directory)
            command = run.call_args.args[0]
            self.assertIn("--upgrade", command)
            self.assertEqual(command[-1], "requests")
            self.assertTrue(Path(directory, ".overridepath").is_file())


def _fake_curl_response(payload, status=200):
    # Matches post_json's own curl invocation: -w "\n%{http_code}" appends
    # the status code after the response body on its own line.
    stdout = (json.dumps(payload) + "\n" + str(status)).encode("utf-8")
    return subprocess.CompletedProcess(args=["curl"], returncode=0, stdout=stdout, stderr=b"")


class BrowserPairingTests(unittest.TestCase):
    def test_opens_pairing_page_and_waits_for_credentials(self):
        started = {
            "sessionId": "11111111-1111-4111-8111-111111111111",
            "pollSecret": "secret",
            "configureUrl": "https://example.test/install/fusion-runner/setup?session=111",
        }
        with patch.object(
            setup.subprocess,
            "run",
            side_effect=[
                _fake_curl_response(started),
                _fake_curl_response({"status": "pending"}, status=202),
                _fake_curl_response({
                    "status": "complete", "token": "frt_machine", "machineId": "machine-id"
                }),
            ],
        ), patch.object(setup.webbrowser, "open", return_value=True) as browser, patch.object(
            setup.time, "sleep"
        ) as sleep:
            result = setup.pair_runner("https://example.test", "router-host")

        self.assertEqual(result["token"], "frt_machine")
        browser.assert_called_once_with(started["configureUrl"])
        sleep.assert_called_once_with(2)

    def test_write_env_needs_no_terminal_input(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            setup, "pair_runner", return_value={"token": "frt_machine", "machineId": "machine-id"}
        ) as pair, patch.object(setup.socket, "gethostname", return_value="router-host"), patch(
            "builtins.input", side_effect=AssertionError("setup must not prompt")
        ):
            setup.write_env(directory)
            contents = Path(directory, ".env").read_text()

        pair.assert_called_once_with(setup.DEPLOYED_URL, "router-host")
        self.assertIn('API_KEY="frt_machine"', contents)
        self.assertIn('RUNNER_MACHINE_ID="machine-id"', contents)

    def test_write_env_polls_every_enabled_machine_not_just_its_own(self):
        # Real, confirmed live regression: a fresh install used to only ever
        # get its own brand-new self-registered machine id, which is never a
        # real router (those are named "New Router"/"UNC Router", not a
        # hostname) - so a queued job for a real machine could never reach
        # it. The setup API now also returns every already-enabled real
        # machine's id as machineIds; write_env must fold all of them into
        # one comma-separated RUNNER_MACHINE_ID (config.py already splits on
        # commas), not just the self-registered one.
        credentials = {
            "token": "frt_machine",
            "machineId": "self-registered-id",
            "machineIds": ["self-registered-id", "new-router-id", "unc-router-id"],
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            setup, "pair_runner", return_value=credentials
        ), patch.object(setup.socket, "gethostname", return_value="router-host"):
            setup.write_env(directory)
            contents = Path(directory, ".env").read_text()

        self.assertIn(
            'RUNNER_MACHINE_ID="self-registered-id,new-router-id,unc-router-id"', contents
        )


if __name__ == "__main__":
    unittest.main()
