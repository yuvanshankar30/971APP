from pathlib import Path
import unittest


COMMANDS_DIR = Path(__file__).parents[1] / "commands"


class ChuckFixtureSourceTests(unittest.TestCase):
    """ChuckFixture.py imports adsk.* at module load, so it can only run
    inside Fusion - these check the source directly for the rules confirmed
    live, same pattern as test_handle_hex_shaft.py.
    """

    def setUp(self):
        self.source = (COMMANDS_DIR / "ChuckFixture.py").read_text()

    def test_chuck_lives_in_its_own_component_not_root_bodies(self):
        # Confirmed live: chuck solids in the same component as the stock and
        # model were folded into the stock's radial extent in the kernel job
        # (46mm/127mm instead of 7.3mm), so roughing cut air for minutes -
        # whether or not they were bound as the fixture.
        self.assertIn("root.occurrences.addNewComponent(", self.source)
        self.assertIn("extrude_into_place(component, draw_jaw,", self.source)
        self.assertIn("component, draw_body,", self.source)

    def test_chuck_body_is_a_polygon_not_a_sketch_circle(self):
        # A sketch circle placed through the shared transform came out tilted
        # off the axis (confirmed live).
        self.assertNotIn("addByCenterRadius", self.source)

    def test_three_jaws_at_120_degrees(self):
        self.assertIn("for k in range(3):", self.source)
        self.assertIn("2.0 * math.pi / 3.0", self.source)

    def test_chuck_front_value_is_already_centimeters_but_wcs_origin_is_millimeters(self):
        self.assertIn('itemByName("chuckFront_value").value.value\n', self.source)
        self.assertNotIn('chuckFront_value").value.value / 10', self.source)
        self.assertIn("origin.x / 10.0", self.source)


class BundledPostRefreshTests(unittest.TestCase):
    def test_bundled_post_is_recopied_when_it_differs_not_only_when_missing(self):
        # Confirmed live: a stale copy in Fusion's Posts folder was kept
        # forever, so edits to the bundled haas_turning.cps never took effect.
        source = (COMMANDS_DIR / "NewNCProgram.py").read_text()
        self.assertIn("filecmp.cmp(post_processor_path, destination, shallow=False)", source)

    def test_haas_post_defaults_match_the_tl1(self):
        post = (COMMANDS_DIR.parent / "postprocessors" / "haas_turning.cps").read_text()
        max_rpm = post[post.index("maximumSpindleSpeed: {"):]
        self.assertIn("value      : 2000,", max_rpm[:300])
        tailstock = post[post.index("useTailStock: {"):]
        self.assertIn("value      : false,", tailstock[:300])


class SpacerChuckWiringTests(unittest.TestCase):
    def test_spacer_binds_a_chuck_at_its_own_chuck_front_plane_after_setup(self):
        source = (COMMANDS_DIR / "HandleSpacer.py").read_text()
        self.assertIn("from .ChuckFixture import attach_chuck_at_chuck_front", source)
        attach = source.index("attach_chuck_at_chuck_front(\n")
        self.assertGreater(attach, source.index("_apply_stock(setup, resolved)"))
        self.assertIn('resolved["od_cm"] / 2.0, resolved["jaw_cm"]', source)


if __name__ == "__main__":
    unittest.main()
