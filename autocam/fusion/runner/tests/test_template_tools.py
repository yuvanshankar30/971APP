import importlib.util
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
    def test_conservative_router_preset_halves_every_motion_feed(self):
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
        self.assertEqual(scaled["v_f"], 40)
        self.assertEqual(scaled["v_f_leadIn"], 40)
        self.assertEqual(scaled["v_f_leadOut"], 40)
        self.assertEqual(scaled["v_f_transition"], 40)
        self.assertEqual(scaled["v_f_plunge"], 6.6665)
        self.assertEqual(scaled["v_f_ramp"], 10)
        self.assertEqual(scaled["v_f_retract"], 20)
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


if __name__ == "__main__":
    unittest.main()
