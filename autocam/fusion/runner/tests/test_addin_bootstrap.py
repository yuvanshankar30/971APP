from pathlib import Path
import unittest


RUNNER_DIR = Path(__file__).parents[1]


class DependencyBootstrapTests(unittest.TestCase):
    def test_dependency_path_is_added_before_workflow_imports(self):
        entrypoint = (RUNNER_DIR / "SpartanRoboticsAutoCAM.py").read_text()

        self.assertLess(
            entrypoint.index("from .config import *"),
            entrypoint.index("from .workflows import importPlate"),
        )

    def test_config_inserts_the_override_path_at_the_front_of_sys_path(self):
        config = (RUNNER_DIR / "config.py").read_text()

        self.assertIn("sys.path.insert(0, OVERRIDE_PATH)", config)


if __name__ == "__main__":
    unittest.main()
