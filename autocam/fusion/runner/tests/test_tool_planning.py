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
        # Diameter picks roughing/detail; feed only tiebreaks equal diameters
        # (see test below) - "large" is the biggest cutter here regardless of
        # its lower programmed feed, "small" is the smallest, "middle" is
        # neither and gets dropped rather than paying for a third tool change.
        plan = tool_planning.plan_endmills([tool("small", .1575, 80), tool("middle", .236, 100), tool("large", .25, 60)], multi_tool_mode=True)
        self.assertEqual([item["guid"] for item in plan["tools"]], ["large", "small"])
        self.assertEqual(plan["skipped_guids"], ["middle"])

    def test_a_smaller_cutter_with_a_higher_programmed_feed_never_outranks_a_larger_one(self):
        # Real, confirmed case from the ShopSabre library itself: the 6mm
        # endmill (0.2362in @ feed 100) computes a higher diameter*feed
        # product than the 0.25in endmill (feed 60) - 23.6 vs 15.0 - despite
        # being the physically smaller tool. Ranking by that product used to
        # pick the 6mm tool as "roughing" and discard the actually-larger
        # 0.25in tool as dominated - backwards from the intent of always
        # keeping the broadest cutter for roughing.
        plan = tool_planning.plan_endmills(
            [tool("sixmm", .2362205, 100), tool("quarter", .25, 60)], multi_tool_mode=True
        )
        self.assertEqual(plan["tools"][0]["guid"], "quarter")

    def test_single_tool_never_adds_an_available_cutter(self):
        plan = tool_planning.plan_endmills([tool("selected", .1575, 80), tool("large", .25, 60)], multi_tool_mode=False)
        self.assertEqual([item["guid"] for item in plan["tools"]], ["selected"])
