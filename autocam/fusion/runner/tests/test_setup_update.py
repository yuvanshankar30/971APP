from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import patch
import io
import json
import tempfile
import unittest
import urllib.error


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


def _fake_response(payload):
    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

    return _Response()


class RegisterRunnerTokenTests(unittest.TestCase):
    """Real, confirmed live requirement this replaces: FUSION_RUNNER_TOKEN
    used to be a shared secret a human had to get from an admin and paste
    in. register_runner_token mints this machine its own unique key with
    zero pre-shared secret - see the runner_tokens migration's own comment
    for why a self-issued token deliberately works immediately."""

    def test_returns_the_minted_token_on_success(self):
        with patch.object(setup.urllib.request, "urlopen", return_value=_fake_response({"token": "frt_abc123"})):
            token = setup.register_runner_token("https://example.test", "ShopSabre Router 1")
        self.assertEqual(token, "frt_abc123")

    def test_returns_none_when_the_hub_rejects_the_request(self):
        error = urllib.error.HTTPError(
            "https://example.test", 500, "Internal Server Error", {}, io.BytesIO(json.dumps({"error": "boom"}).encode())
        )
        with patch.object(setup.urllib.request, "urlopen", side_effect=error):
            token = setup.register_runner_token("https://example.test", "ShopSabre Router 1")
        self.assertIsNone(token)

    def test_returns_none_when_the_hub_cannot_be_reached(self):
        with patch.object(setup.urllib.request, "urlopen", side_effect=urllib.error.URLError("offline")):
            token = setup.register_runner_token("https://example.test", "ShopSabre Router 1")
        self.assertIsNone(token)

    def test_returns_none_when_the_response_has_no_token(self):
        with patch.object(setup.urllib.request, "urlopen", return_value=_fake_response({})):
            token = setup.register_runner_token("https://example.test", "ShopSabre Router 1")
        self.assertIsNone(token)


if __name__ == "__main__":
    unittest.main()
