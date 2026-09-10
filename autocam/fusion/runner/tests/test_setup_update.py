from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import patch
import json
import os
import tempfile
import unittest


RUNNER_DIR = Path(__file__).parents[1]
spec = spec_from_file_location("fusion_runner_setup", RUNNER_DIR / "setup.py")
setup = module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupUpdateTests(unittest.TestCase):
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


def _fake_response(payload):
    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

        status = 200

    return _Response()


class BrowserPairingTests(unittest.TestCase):
    def test_opens_pairing_page_and_waits_for_credentials(self):
        started = {
            "sessionId": "11111111-1111-4111-8111-111111111111",
            "pollSecret": "secret",
            "configureUrl": "https://example.test/install/fusion-runner/setup?session=111",
        }
        pending = _fake_response({"status": "pending"})
        pending.status = 202
        with patch.object(
            setup.urllib.request,
            "urlopen",
            side_effect=[_fake_response(started), pending, _fake_response({
                "status": "complete", "token": "frt_machine", "machineId": "machine-id"
            })],
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


if __name__ == "__main__":
    unittest.main()
