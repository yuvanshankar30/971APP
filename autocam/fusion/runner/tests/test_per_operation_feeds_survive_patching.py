"""Real, confirmed live bug: every operation of every AutoCAM job posted the
same feeds - Bore, Slot Cut for Edges, all of them at 22000 rpm / 80 in/min
cutting / 20 in/min ramp - no matter what the template on disk said.

A tool library holds ONE preset per tool ("Normal router tools (use
this).tools" gives the 971 Main Bit a single "Default preset" at exactly
those numbers), and patch_cam_template_with_tool_libraries copied it onto
every operation it touched: the <motion> tag, a rebuilt <presets> block, and
the template-level <parameter expression=...> entries. The shop's
per-operation feeds in templates/971-real/*.f3dhsm-template were overwritten
before Fusion ever saw them.

A generic "Default preset" is a tool-wide fallback, so it no longer outranks
a template exported with its own reviewed per-operation feeds. A
material-specific named preset still does, since it encodes something the
template cannot know.
"""

import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("template_tools", ROOT / "workflows/templateTools.py")
template_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(template_tools)

_TEMPLATE_PATH = ROOT / "templates/971-real/Tubestock(with Cutter Comp).f3dhsm-template"
_LIBRARY_PATH = ROOT / "tools/Normal router tools (use this).tools"
# The library the plain "971 Main Bit" (the tube jobs' cutter) actually
# resolves to - it names its presets after materials instead of shipping a
# generic "Default preset", which is why tube jobs stayed broken after
# plate jobs were fixed.
_TUBE_LIBRARY_PATH = ROOT / "tools/971-outside-plate.tools"
_NS = {"x": "http://www.hsmworks.com/namespace/hsmworks/document/template"}

# The single preset the 971 Main Bit actually ships with, and the exact
# numbers every operation was wrongly posting before this fix.
_TOOL_WIDE_CUTTING_FEED = "80in/min"
_TOOL_WIDE_RAMP_FEED = "20in/min"


def _load_library_tools(path=_LIBRARY_PATH):
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read("tools.json"))


def _patch(library, material_name="Aluminum 6061"):
    with tempfile.TemporaryDirectory() as directory:
        tool_json = Path(directory) / "tools.json"
        tool_json.write_text(json.dumps(library))
        output = Path(directory) / "patched.f3dhsm-template"
        template_tools.patch_cam_template_with_tool_libraries(
            str(_TEMPLATE_PATH),
            str(output),
            [str(tool_json)],
            material_name=material_name,
        )
        return ET.parse(output).getroot()


def _operation(root, description):
    for template_elem in root.findall("x:template", _NS):
        if template_elem.get("description") == description:
            return template_elem
    raise AssertionError(f"no operation named {description!r} in the patched template")


def _feeds(operation):
    return {
        parameter.get("name"): parameter.get("expression")
        for parameter in operation.findall("x:parameter", _NS)
    }


class PerOperationFeedsSurvivePatchingTests(unittest.TestCase):
    def test_each_operation_keeps_its_own_shop_set_feeds(self):
        root = _patch(_load_library_tools())

        bore = _feeds(_operation(root, "<.3 Circluar Through Hole"))
        circular = _feeds(_operation(root, ">.3 Circular Through Hole"))

        # The shop's own per-operation values, not the tool-wide 80/20.
        self.assertEqual(bore["tool_feedCutting"], "40.in/min")
        self.assertEqual(bore["tool_feedRamp"], "40.in/min")
        self.assertEqual(circular["tool_feedCutting"], "60.in/min")
        self.assertEqual(circular["tool_feedRamp"], "55.in/min")

    def test_two_operations_sharing_one_tool_no_longer_collapse_onto_one_feed(self):
        # The whole symptom. Both of these run on the 971 Main Bit, so both
        # used to take that tool's single preset and report an identical
        # 80 in/min - the tool is shared, the feeds are not.
        root = _patch(_load_library_tools())

        bore = _operation(root, "<.3 Circluar Through Hole")
        slot = _operation(root, "2D Slot Cut")

        self.assertEqual(
            bore.find("x:tool", _NS).get("guid"), slot.find("x:tool", _NS).get("guid")
        )
        self.assertNotEqual(
            _feeds(bore)["tool_feedCutting"], _feeds(slot)["tool_feedCutting"]
        )
        for operation in (bore, slot):
            self.assertNotEqual(_feeds(operation)["tool_feedCutting"], _TOOL_WIDE_CUTTING_FEED)
            self.assertNotEqual(_feeds(operation)["tool_feedRamp"], _TOOL_WIDE_RAMP_FEED)

    def test_the_tool_wide_default_preset_no_longer_overwrites_the_motion_tag(self):
        root = _patch(_load_library_tools())
        motion = _operation(root, "<.3 Circluar Through Hole").find("x:tool/x:motion", _NS)

        self.assertEqual(motion.get("cutting-feedrate"), "40")
        self.assertEqual(motion.get("ramp-feedrate"), "40")

    def test_an_aluminum_preset_does_not_override_the_template_either(self):
        # Real, confirmed: plate jobs came right while tube jobs kept
        # posting 80 in/min everywhere, because the tube cutter's library
        # names its presets after materials - "Aluminum 6061" at exactly
        # the same tool-wide 22000 rpm / 80 in/min the other library calls
        # "Default preset". Tube jobs only ever run aluminum.
        root = _patch(_load_library_tools(_TUBE_LIBRARY_PATH))

        bore = _feeds(_operation(root, "<.3 Circluar Through Hole"))
        finishing = _feeds(_operation(root, "Shape Through Finishing Pass"))

        self.assertEqual(bore["tool_feedCutting"], "40.in/min")
        self.assertEqual(finishing["tool_feedCutting"], "20.in/min")
        self.assertEqual(finishing["tool_spindleSpeed"], "22000.")

    def test_no_material_preset_overrides_a_template_that_has_its_own_feeds(self):
        # Direct instruction: the shop cuts Lexan plate on the aluminum
        # numbers the 971-real templates are already authored in, so no
        # material gets to collapse their per-operation feeds. The Lexan
        # preset in this library is a genuinely different 12000 rpm / 96
        # in/min and still must not reach these operations.
        root = _patch(
            _load_library_tools(_TUBE_LIBRARY_PATH),
            material_name="Polycarbonate (Lexan)",
        )

        bore = _feeds(_operation(root, "<.3 Circluar Through Hole"))
        finishing = _feeds(_operation(root, "Shape Through Finishing Pass"))

        self.assertEqual(bore["tool_feedCutting"], "40.in/min")
        self.assertEqual(bore["tool_spindleSpeed"], "22000.")
        self.assertEqual(finishing["tool_feedCutting"], "20.in/min")

    def test_a_template_without_its_own_feeds_still_takes_them_from_the_preset(self):
        # The minimal generic templates (Plates, Bore) carry no feed
        # parameters of their own, so the preset remains their only source.
        minimal = ET.Element(template_tools._q("template"))
        rich = ET.SubElement(minimal, template_tools._q("parameter"))
        self.assertFalse(template_tools._template_carries_own_feeds(minimal))

        rich.set("name", "tool_feedCutting")
        rich.set("expression", "40.in/min")
        self.assertTrue(template_tools._template_carries_own_feeds(minimal))
