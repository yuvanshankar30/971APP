import importlib.util
from pathlib import Path
from types import SimpleNamespace as Obj
import unittest


spec = importlib.util.spec_from_file_location(
    "machining_time", Path(__file__).parents[1] / "workflows/machiningTime.py"
)
machining_time = importlib.util.module_from_spec(spec)
spec.loader.exec_module(machining_time)


class Collection:
    def __init__(self):
        self.items = []

    @property
    def count(self):
        return len(self.items)

    def add(self, item):
        self.items.append(item)


class Cam:
    def __init__(self, operations, *, seconds=123.5, error=None):
        self.setups = [Obj(operations=operations)]
        self.seconds = seconds
        self.error = error
        self.call = None

    def getMachiningTime(self, operations, feed_scale, rapid_feed, tool_change):
        self.call = (operations, feed_scale, rapid_feed, tool_change)
        if self.error:
            raise self.error
        return Obj(machiningTime=self.seconds)


class MachiningTimeTests(unittest.TestCase):
    def test_uses_fusions_cam_api_with_shop_assumptions(self):
        valid = Obj(isSuppressed=False, isToolpathValid=True)
        cam = Cam([valid])

        result = machining_time.total_machining_time(cam, Collection)

        self.assertEqual(result, 123.5)
        operations, feed_scale, rapid_feed, tool_change = cam.call
        self.assertEqual(operations.items, [valid])
        self.assertEqual(feed_scale, 100)
        self.assertEqual(rapid_feed, 50.0)
        self.assertEqual(tool_change, 15.0)

    def test_excludes_suppressed_and_invalid_operations(self):
        cam = Cam([
            Obj(isSuppressed=True, isToolpathValid=True),
            Obj(isSuppressed=False, isToolpathValid=False),
        ])
        self.assertIsNone(machining_time.total_machining_time(cam, Collection))
        self.assertIsNone(cam.call)

    def test_returns_none_when_fusion_cannot_calculate_time(self):
        cam = Cam([Obj(isSuppressed=False, isToolpathValid=True)], error=RuntimeError("Fusion failed"))
        self.assertIsNone(machining_time.total_machining_time(cam, Collection))


if __name__ == "__main__":
    unittest.main()
