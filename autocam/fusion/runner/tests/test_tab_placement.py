import importlib.util
from pathlib import Path
import sys
import types
import unittest


def _load_tab_placement():
    # TabPlacement imports Fusion's runtime-only modules, but the identity
    # helper itself is pure Python and should remain regression-testable.
    adsk = types.ModuleType("adsk")
    adsk.core = types.ModuleType("adsk.core")
    adsk.fusion = types.ModuleType("adsk.fusion")
    adsk.cam = types.ModuleType("adsk.cam")
    previous = {name: sys.modules.get(name) for name in ("adsk", "adsk.core", "adsk.fusion", "adsk.cam")}
    try:
        sys.modules.update({
            "adsk": adsk,
            "adsk.core": adsk.core,
            "adsk.fusion": adsk.fusion,
            "adsk.cam": adsk.cam,
        })
        spec = importlib.util.spec_from_file_location(
            "TabPlacement", Path(__file__).parents[1] / "commands/TabPlacement.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


TabPlacement = _load_tab_placement()


class _Parameter:
    def __init__(self):
        self.expression = None
        self.value = types.SimpleNamespace(value=None)


class _Parameters:
    def __init__(self, values):
        self.values = values

    def itemByName(self, name):
        return self.values.get(name)


class ManualTabTests(unittest.TestCase):
    def test_disables_automatic_tabs_and_sets_uniform_manual_dimensions(self):
        parameters = {
            name: _Parameter()
            for name in ("tabWidth", "tabHeight", "tabsPerContour", "tabPositions")
        }
        operation = types.SimpleNamespace(parameters=_Parameters(parameters))
        app = types.SimpleNamespace(log=lambda _message: None)
        edges = [object(), object(), object(), object()]

        self.assertTrue(TabPlacement._apply_manual_tabs(app, operation, edges))
        self.assertEqual(parameters["tabsPerContour"].expression, "0")
        self.assertEqual(parameters["tabWidth"].expression, "0.6in")
        self.assertEqual(parameters["tabHeight"].expression, "0.15in")
        self.assertEqual(parameters["tabPositions"].value.value, edges)


if __name__ == "__main__":
    unittest.main()
