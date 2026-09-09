import importlib.util
import xml.etree.ElementTree as ET
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "template_tools", Path(__file__).parents[1] / "workflows/templateTools.py"
)
template_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(template_tools)


def tool_with(*preset_names):
    return {
        "description": "971 Main Bit",
        "start-values": {"presets": [{"name": name} for name in preset_names]},
    }


class TemplateToolPresetTests(unittest.TestCase):
    def test_conservative_router_preset_quarters_every_motion_feed(self):
        preset = {
            "n": 22000,
            "v_f": 80,
            "v_f_leadIn": 80,
            "v_f_leadOut": 80,
            "v_f_transition": 80,
            "v_f_plunge": 13.333,
            "v_f_ramp": 20,
            "v_f_retract": 40,
        }

        scaled = template_tools._conservative_router_preset(preset)

        self.assertEqual(scaled["n"], 22000)
        self.assertEqual(scaled["v_f"], 20)
        self.assertEqual(scaled["v_f_leadIn"], 20)
        self.assertEqual(scaled["v_f_leadOut"], 20)
        self.assertEqual(scaled["v_f_transition"], 20)
        self.assertEqual(scaled["v_f_plunge"], 3.33325)
        self.assertEqual(scaled["v_f_ramp"], 5)
        self.assertEqual(scaled["v_f_retract"], 10)
        self.assertEqual(preset["v_f"], 80)

    def test_default_preset_is_allowed_only_for_known_aluminum(self):
        selected = template_tools._choose_preset(tool_with("Default preset"), "Aluminum 6061")
        self.assertEqual(selected["name"], "Default preset")

    def test_named_preset_matches_polycarbonate(self):
        selected = template_tools._choose_preset(
            tool_with("Default preset", "Polycarbonate (Lexan)"), "Polycarbonate (Lexan)"
        )
        self.assertEqual(selected["name"], "Polycarbonate (Lexan)")

    def test_unreviewed_material_cannot_fall_back_to_default(self):
        with self.assertRaisesRegex(ValueError, "No reviewed feed/speed preset"):
            template_tools._choose_preset(tool_with("Default preset"), "Steel")

    def test_short_aluminum_alias_cannot_match_default_by_accident(self):
        with self.assertRaisesRegex(ValueError, "No reviewed feed/speed preset"):
            template_tools._choose_preset(tool_with("Default preset"), "Aluminum Composite")


class EntryFeedSafetyTests(unittest.TestCase):
    """Issue #360: forcing every motion type to the base cutting feed sent a
    plunge move in at full cutting speed and tore through real stock. These
    pin the guardrail that now refuses to build such a preset.
    """

    def test_rejects_a_plunge_feed_raised_to_the_cutting_feed(self):
        with self.assertRaisesRegex(ValueError, "Unsafe v_f_plunge"):
            template_tools.assert_safe_entry_feeds({"v_f": 80, "v_f_plunge": 80})

    def test_rejects_a_ramp_feed_raised_to_the_cutting_feed(self):
        with self.assertRaisesRegex(ValueError, "Unsafe v_f_ramp"):
            template_tools.assert_safe_entry_feeds({"v_f": 80, "v_f_ramp": 80})

    def test_allows_the_real_library_ratios(self):
        # ramp 1/4, plunge 1/6 - what every reviewed preset actually uses.
        template_tools.assert_safe_entry_feeds(
            {"v_f": 80, "v_f_ramp": 20, "v_f_plunge": 13.333}
        )

    def test_ignores_a_preset_that_programs_no_entry_feed(self):
        # A missing entry feed is a data gap, not a hazard - it must not turn
        # into a refusal to cut.
        template_tools.assert_safe_entry_feeds({"v_f": 80})
        template_tools.assert_safe_entry_feeds({"v_f_plunge": 13.333})

    def test_the_router_scale_keeps_a_preset_safe(self):
        scaled = template_tools._conservative_router_preset(
            {"name": "Aluminum 6061", "v_f": 80, "v_f_ramp": 20, "v_f_plunge": 13.333}
        )
        self.assertLess(scaled["v_f_plunge"], scaled["v_f"])
        self.assertLess(scaled["v_f_ramp"], scaled["v_f"])

    def test_conservative_preset_rejects_unsafe_input_before_it_reaches_a_machine(self):
        with self.assertRaisesRegex(ValueError, "Unsafe v_f_plunge"):
            template_tools._conservative_router_preset(
                {"name": "Bad preset", "v_f": 80, "v_f_plunge": 80}
            )

    def test_every_shipped_library_preset_passes(self):
        """The real checked-in tool library, not a fixture - so retuning a
        preset in that file can never ship an unsafe entry feed unnoticed.
        """
        import json
        import zipfile
        from pathlib import Path

        library = Path(__file__).parents[1] / "tools/971-outside-plate.tools"
        if not library.is_file():
            self.skipTest("checked-in tool library not present")
        with zipfile.ZipFile(library) as archive:
            payload = json.loads(archive.read("tools.json"))
        tools = payload.get("data") or []
        presets = [
            (tool.get("description") or "?", preset)
            for tool in tools
            for preset in tool.get("start-values", {}).get("presets", [])
        ]
        self.assertTrue(presets, "expected the library to contain reviewed presets")
        for description, preset in presets:
            with self.subTest(tool=description, preset=preset.get("name")):
                template_tools.assert_safe_entry_feeds(preset, str(preset.get("name")))
                template_tools._conservative_router_preset(preset)


def _template_param(template_elem, name, expression):
    param = ET.SubElement(template_elem, template_tools._q("parameter"))
    param.set("name", name)
    param.set("expression", expression)
    return param


def _find_param(template_elem, name):
    for parameter in template_elem.findall(template_tools._q("parameter")):
        if parameter.get("name") == name:
            return parameter
    return None


class TemplateLevelFeedParamTests(unittest.TestCase):
    """_set_template_level_feed_params keeps a real Fusion-exported
    template's own top-level <template><parameter name="tool_feedCutting">
    siblings (a snapshot of whatever tool was bound when it was exported)
    in sync with whichever tool actually gets patched in - confirmed live
    as a real bug once for tool_spindleSpeed/tool_feedCutting themselves
    (see this function's own module-level comment), and again for
    finishFeedrate specifically (real Fusion warning: "the finish feedrate
    is higher than the cutting feedrate" on New Router once a slower tool
    got patched into an operation whose finishFeedrate had been left at
    its original, now-too-high literal).
    """

    def _template_with(self, cutting_feed_literal, finish_feed_literal=None):
        template_elem = ET.Element(template_tools._q("template"))
        _template_param(template_elem, "tool_feedCutting", cutting_feed_literal)
        if finish_feed_literal is not None:
            _template_param(template_elem, "finishFeedrate", finish_feed_literal)
        return template_elem

    def test_scales_finish_feedrate_by_the_templates_own_original_ratio(self):
        # Real, confirmed case: this template's own export authored finish
        # at exactly half of cutting (30 vs 60) - a deliberate finish-quality
        # slowdown, not an arbitrary number. A tool with a lower cutting feed
        # (25) should get a proportionally lower finish feed (12.5), not a
        # finish feed simply capped to match cutting exactly (which would
        # silently erase that deliberate slowdown).
        template_elem = self._template_with("60.in/min", "30.00 in/min")

        template_tools._set_template_level_feed_params(template_elem, {"v_f": 25})

        self.assertEqual(_find_param(template_elem, "finishFeedrate").get("expression"), "12.5in/min")
        self.assertEqual(_find_param(template_elem, "tool_feedCutting").get("expression"), "25in/min")

    def test_is_a_no_op_when_the_new_tool_matches_the_templates_original_feed(self):
        # UNC Router's real, working case: every job today reuses the same
        # tool the template was exported with, so this must reproduce the
        # exact original finishFeedrate, not merely something close to it.
        template_elem = self._template_with("60.in/min", "30.00 in/min")

        template_tools._set_template_level_feed_params(template_elem, {"v_f": 60})

        self.assertEqual(_find_param(template_elem, "finishFeedrate").get("expression"), "30in/min")

    def test_leaves_finishfeedrate_alone_when_the_template_has_none(self):
        # Most strategies (bore, drill, adaptive without a finishing pass)
        # have no finishFeedrate parameter at all - nothing to scale, and
        # nothing should be created where there was nothing before.
        template_elem = self._template_with("60.in/min")

        template_tools._set_template_level_feed_params(template_elem, {"v_f": 25})

        self.assertIsNone(_find_param(template_elem, "finishFeedrate"))

    def test_does_not_divide_by_a_zero_or_missing_original_cutting_feed(self):
        template_elem = self._template_with("0in/min", "30.00 in/min")

        template_tools._set_template_level_feed_params(template_elem, {"v_f": 25})

        # Nothing sane to scale by - leave the original literal in place
        # rather than raising or emitting a garbage value.
        self.assertEqual(_find_param(template_elem, "finishFeedrate").get("expression"), "30.00 in/min")


if __name__ == "__main__":
    unittest.main()
