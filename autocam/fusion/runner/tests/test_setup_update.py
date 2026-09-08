from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
