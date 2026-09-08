import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("tool_planning", Path(__file__).parents[1] / "workflows/toolPlanning.py")
tool_planning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool_planning)

def tool(guid, diameter, feed):
    return {"guid": guid, "type": "flat end mill", "geometry": {"DC": diameter}, "start-values": {"presets": [{"v_f": feed}]}}

class ToolPlanningTests(unittest.TestCase):
    def test_multi_tool_skips_the_dominated_middle_cutter(self):
        plan = tool_planning.plan_endmills([tool("small", .1575, 80), tool("middle", .236, 100), tool("large", .25, 60)], multi_tool_mode=True)
        self.assertEqual([item["guid"] for item in plan["tools"]], ["middle", "small"])
        self.assertEqual(plan["skipped_guids"], ["large"])

    def test_single_tool_never_adds_an_available_cutter(self):
        plan = tool_planning.plan_endmills([tool("selected", .1575, 80), tool("large", .25, 60)], multi_tool_mode=False)
        self.assertEqual([item["guid"] for item in plan["tools"]], ["selected"])
