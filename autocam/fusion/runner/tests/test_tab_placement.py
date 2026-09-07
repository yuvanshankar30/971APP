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


class EdgeIdentityTests(unittest.TestCase):
    def test_uses_fusions_entity_token_not_the_python_proxy_identity(self):
        # The API can hand back separate Python objects for the same BRepEdge
        # across two collection reads. The no-tab-zone calculation must keep
        # that physical edge eligible both times.
        first_proxy = types.SimpleNamespace(entityToken="physical-edge-1")
        second_proxy = types.SimpleNamespace(entityToken="physical-edge-1")
        self.assertIsNot(first_proxy, second_proxy)
        self.assertEqual(
            TabPlacement._edge_identity(first_proxy),
            TabPlacement._edge_identity(second_proxy),
        )


if __name__ == "__main__":
    unittest.main()
