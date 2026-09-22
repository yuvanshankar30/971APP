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


def _tool(description, number, diameter=None, guid=None):
    tool = {"description": description, "post-process": {"number": number}}
    if diameter is not None:
        tool["geometry"] = {"DC": diameter}
    if guid is not None:
        tool["guid"] = guid
    return tool


class DropStaleDuplicateToolNumbersTests(unittest.TestCase):
    def test_drops_the_undescribed_duplicate_of_a_sized_tool(self):
        # Real, confirmed data: "Normal router tools (use this).tools" ships
        # both of these under NC tool number 6.
        stale = _tool("for tool changer", 6, diameter=0.25)
        real = _tool("4mm sized for toolchager", 6, diameter=0.1575)
        other = _tool("6mm for toolchanger", 2, diameter=0.2362205)

        kept = template_tools._drop_stale_duplicate_tool_numbers([stale, real, other])

        self.assertNotIn(stale, kept)
        self.assertIn(real, kept)
        self.assertIn(other, kept)

    def test_leaves_non_conflicting_tool_numbers_alone(self):
        tools = [_tool("971 Main Bit", 1, diameter=0.1575), _tool("6mm for toolchanger", 2, diameter=0.2362205)]

        kept = template_tools._drop_stale_duplicate_tool_numbers(tools)

        self.assertEqual(kept, tools)

    def test_leaves_an_unresolvable_conflict_alone_when_neither_side_is_sized(self):
        # Real, confirmed data: the library's two identically-named T5
        # countersinks (0.372in and 0.5in) - no "sized" tag on either side,
        # so there's no real basis to prefer one over the other.
        a = _tool("82˚ couter sink for toolchanger", 5, diameter=0.372)
        b = _tool("82˚ couter sink for toolchanger", 5, diameter=0.5)

        kept = template_tools._drop_stale_duplicate_tool_numbers([a, b])

        self.assertEqual(kept, [a, b])

    def test_leaves_an_unresolvable_conflict_alone_when_both_sides_are_sized(self):
        a = _tool("4mm sized variant a", 6, diameter=0.1575)
        b = _tool("4mm sized variant b", 6, diameter=0.16)

        kept = template_tools._drop_stale_duplicate_tool_numbers([a, b])

        self.assertEqual(kept, [a, b])

    def test_ignores_tools_with_no_readable_tool_number(self):
        no_post_process = {"description": "mystery tool"}

        kept = template_tools._drop_stale_duplicate_tool_numbers([no_post_process])

        self.assertEqual(kept, [no_post_process])


class IndexToolsAppliesDedupeTests(unittest.TestCase):
    def test_index_tools_excludes_the_stale_duplicate_from_by_type(self):
        stale = _tool("for tool changer", 6, diameter=0.25)
        real = _tool("4mm sized for toolchager", 6, diameter=0.1575)
        stale["type"] = "flat end mill"
        real["type"] = "flat end mill"

        index = template_tools._index_tools({"data": [stale, real]})

        self.assertNotIn(stale, index["tools"])
        self.assertIn(real, index["tools"])
        self.assertNotIn(stale, index["by_type"]["flat end mill"])


class TemplateToolPresetTests(unittest.TestCase):
    def test_router_feed_rate_scale_is_full_speed(self):
        # Pins the actual constant, not just _conservative_router_preset's
        # behavior with it - a regression here is exactly the "AutoCAM'd
        # job runs ~6.5x longer than the same part's manual CAM" bug this
        # was fixed for.
        self.assertEqual(template_tools._ROUTER_FEED_RATE_SCALE, 1.0)

    def test_conservative_router_preset_now_leaves_every_motion_feed_at_full_speed(self):
        # _ROUTER_FEED_RATE_SCALE is 1.0 (direct instruction, after an
        # AutoCAM'd job's machining-time estimate ran ~6.5x longer than the
        # same part's manually-set-up CAM - see that constant's own
        # comment). This still exercises the real scaling code path (not a
        # no-op skip), just pinned at "no scaling" instead of quartering.
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
        self.assertEqual(scaled["v_f"], 80)
        self.assertEqual(scaled["v_f_leadIn"], 80)
        self.assertEqual(scaled["v_f_leadOut"], 80)
        self.assertEqual(scaled["v_f_transition"], 80)
        self.assertEqual(scaled["v_f_plunge"], 13.333)
        self.assertEqual(scaled["v_f_ramp"], 20)
        self.assertEqual(scaled["v_f_retract"], 40)
        self.assertEqual(preset["v_f"], 80)

    def test_default_preset_is_allowed_for_aluminum(self):
        selected = template_tools._choose_preset(tool_with("Default preset"), "Aluminum 6061")
        self.assertEqual(selected["name"], "Default preset")

    def test_named_preset_matches_polycarbonate(self):
        selected = template_tools._choose_preset(
            tool_with("Default preset", "Polycarbonate (Lexan)"), "Polycarbonate (Lexan)"
        )
        self.assertEqual(selected["name"], "Polycarbonate (Lexan)")

    def test_default_preset_is_now_a_fallback_for_any_material(self):
        # Direct instruction: "Default preset" is no longer restricted to
        # Aluminum 6061 - the shop manually adjusts feed rate at the router
        # for whatever material is loaded, so a reviewed-but-generic preset
        # is now an acceptable basis for any material.
        for material in ("Steel", "Aluminum Composite", "Titanium"):
            with self.subTest(material=material):
                selected = template_tools._choose_preset(tool_with("Default preset"), material)
                self.assertEqual(selected["name"], "Default preset")

    def test_still_raises_when_no_default_preset_exists_at_all(self):
        # The universal Default-preset fallback only helps a tool that
        # actually has one. A tool with only OTHER named presets, none of
        # which match the requested material, must still refuse rather than
        # guess at an unrelated material's feeds/speeds.
        with self.assertRaisesRegex(ValueError, "No reviewed feed/speed preset"):
            template_tools._choose_preset(tool_with("Steel Preset", "Titanium Preset"), "Aluminum")


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
