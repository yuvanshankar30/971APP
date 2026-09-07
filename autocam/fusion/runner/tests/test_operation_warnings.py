"""Issue #316: Fusion raises real, non-fatal warnings on operations that
still post successfully - a pocket region "too small to be reached with
given ramping constraints" just silently doesn't get machined. Those
warnings only ever appeared in Fusion's own Text Commands log on the
machine that ran the job. These cover surfacing them as job warnings.

camPlate.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded in isolation rather than by importing the
whole module.
"""

import importlib.util
import types
from pathlib import Path
import sys
import unittest


def _load_operation_warnings():
    """Extract _operation_warnings from camPlate.py without importing the
    Fusion-only modules the rest of that file needs.
    """
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("_MAX_OPERATION_WARNINGS")
    end = source.index("def _coverage_warnings")
    namespace = {}
    exec(compile(source[start:end], "camPlate_operation_warnings", "exec"), namespace)
    return namespace["_operation_warnings"], namespace["_MAX_OPERATION_WARNINGS"]


operation_warnings, MAX_OPERATION_WARNINGS = _load_operation_warnings()


class _App:
    def __init__(self):
        self.logs = []

    def log(self, message):
        self.logs.append(message)


def _cam(*operations):
    setup = types.SimpleNamespace(operations=list(operations))
    return types.SimpleNamespace(setups=[setup])


def _op(name, warning):
    return types.SimpleNamespace(name=name, warning=warning)


class OperationWarningTests(unittest.TestCase):
    def test_surfaces_the_real_ramping_warning_from_issue_316(self):
        real_text = (
            "One or more pockets were not machined because they are too small "
            "to be reached with given ramping constraints!"
        )
        result = operation_warnings(_App(), _cam(_op("Pocket 1 (971 Main Bit)", real_text)))
        self.assertEqual(len(result), 1)
        self.assertIn("Pocket 1 (971 Main Bit)", result[0])
        self.assertIn("too small to be reached", result[0])

    def test_reports_nothing_when_every_operation_is_clean(self):
        self.assertEqual(operation_warnings(_App(), _cam(_op("2D Slot Cut", ""))), [])

    def test_ignores_whitespace_only_warnings(self):
        self.assertEqual(operation_warnings(_App(), _cam(_op("Shape Pocket", "  \n "))), [])

    def test_collapses_fusion_multiline_text_into_one_line(self):
        result = operation_warnings(_App(), _cam(_op("Bore", "first line\nsecond line\n")))
        self.assertEqual(result, ["Fusion reported on 'Bore': first line second line"])

    def test_names_the_operation_so_the_region_is_identifiable(self):
        # #316's own ask is "determine which specific geometry triggers this" -
        # the operation name is the signal that makes the warning actionable.
        result = operation_warnings(_App(), _cam(_op("Shape Pocket", "warned")))
        self.assertTrue(result[0].startswith("Fusion reported on 'Shape Pocket':"))

    def test_caps_runaway_warning_counts(self):
        ops = [_op(f"Op {index}", "warned") for index in range(MAX_OPERATION_WARNINGS + 5)]
        result = operation_warnings(_App(), _cam(*ops))
        self.assertEqual(len(result), MAX_OPERATION_WARNINGS + 1)
        self.assertIn("see the Runner's own log", result[-1])

    def test_a_broken_cam_object_never_fails_the_job(self):
        class Exploding:
            @property
            def setups(self):
                raise RuntimeError("CAM product went away")

        app = _App()
        self.assertEqual(operation_warnings(app, Exploding()), [])
        self.assertTrue(any("could not run" in message for message in app.logs))

    def test_one_unreadable_operation_does_not_hide_the_others(self):
        class BadOp:
            name = "Broken"

            @property
            def warning(self):
                raise RuntimeError("stale proxy")

        result = operation_warnings(_App(), _cam(BadOp(), _op("Shape Pocket", "warned")))
        self.assertEqual(len(result), 1)
        self.assertIn("Shape Pocket", result[0])


if __name__ == "__main__":
    unittest.main()
