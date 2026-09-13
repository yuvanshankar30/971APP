"""Non-circular through features, including elongated slots, belong to the
matched Shape Through Hole/Shape Through Finishing Pass workflow. The
template's Slot Cut for Features operation remains recognizable only so it
can be pruned; it must never receive feature geometry.

DeleteToolpaths.py imports Fusion's runtime-only modules at import time, so
the functions under test are loaded in isolation.
"""

from pathlib import Path
import types
import unittest


def _load():
    source = (Path(__file__).parents[1] / "commands/DeleteToolpaths.py").read_text()
    start = source.index("# What separates a FEATURE from a SHAPE.")
    end = source.index("def _circle_loop_diameter_cm")
    namespace = {}
    exec(compile(source[start:end], "DeleteToolpaths_feature_rule", "exec"), namespace)
    return namespace


ns = _load()
loop_aspect_ratio = ns["_loop_aspect_ratio"]
is_feature_slot_op = ns["_is_feature_slot_op"]
FEATURE_ASPECT_RATIO = ns["_FEATURE_ASPECT_RATIO"]


def _edge(x1, y1, x2, y2):
    """A straight edge whose endpoints and midpoint are all readable."""
    pt = lambda x, y: types.SimpleNamespace(x=x, y=y, z=0.0)
    return types.SimpleNamespace(
        startVertex=types.SimpleNamespace(geometry=pt(x1, y1)),
        endVertex=types.SimpleNamespace(geometry=pt(x2, y2)),
        pointOnEdge=pt((x1 + x2) / 2, (y1 + y2) / 2),
    )


def _box_loop(width, height):
    return [
        _edge(0, 0, width, 0),
        _edge(width, 0, width, height),
        _edge(width, height, 0, height),
        _edge(0, height, 0, 0),
    ]


def _is_feature(edges):
    return loop_aspect_ratio(edges) >= FEATURE_ASPECT_RATIO


class FeatureVsShapeTests(unittest.TestCase):
    def test_the_real_slot_from_the_training_part_is_a_feature(self):
        # 0.326 x 1.077in, measured off the real 19-loop training part -
        # aspect 3.30, and about twice the 0.1575in cutter wide.
        self.assertAlmostEqual(loop_aspect_ratio(_box_loop(0.326, 1.077)), 3.30, places=1)
        self.assertTrue(_is_feature(_box_loop(0.326, 1.077)))

    def test_every_broad_cutout_from_that_part_is_a_shape(self):
        # Every other internal loop on the same part, by its real measured
        # bounding box. None may be treated as a slot.
        for width, height in [
            (2.133, 1.186), (2.915, 1.683), (1.585, 1.187), (0.875, 0.680),
            (0.861, 0.733), (1.690, 1.948), (2.752, 2.622), (2.406, 2.498),
            (1.888, 1.919),
        ]:
            with self.subTest(size=(width, height)):
                self.assertFalse(_is_feature(_box_loop(width, height)))

    def test_the_threshold_sits_between_the_two_populations(self):
        # 3.30 (slot) vs 1.80 (next-widest shape) - the threshold should
        # have real margin on both sides, not split a cluster.
        self.assertGreater(FEATURE_ASPECT_RATIO, 1.80)
        self.assertLess(FEATURE_ASPECT_RATIO, 3.30)

    def test_orientation_does_not_change_the_answer(self):
        # A slot lying along X is the same feature as one along Y.
        self.assertEqual(loop_aspect_ratio(_box_loop(4, 1)), loop_aspect_ratio(_box_loop(1, 4)))
        self.assertTrue(_is_feature(_box_loop(4, 1)))
        self.assertTrue(_is_feature(_box_loop(1, 4)))

    def test_any_elongated_outline_qualifies_not_one_shape(self):
        # The rule measures elongation only, so a dogbone/I whose ends are
        # wider than its waist still reads as a slot from its overall
        # extent - as does a plain bar or a pill.
        i_shape = [
            _edge(0.0, 0.0, 0.3, 0.0), _edge(0.3, 0.0, 0.3, 0.9),
            _edge(0.3, 0.9, 0.0, 0.9), _edge(0.0, 0.9, 0.0, 0.0),
        ]
        self.assertTrue(_is_feature(i_shape))

    def test_an_unmeasurable_loop_falls_back_to_shape(self):
        # A shape operation can machine a slot's area; a slot pass cannot
        # clear a shape's. Unmeasurable geometry defaults to the safe side.
        self.assertEqual(loop_aspect_ratio([]), 0.0)
        self.assertFalse(_is_feature([]))
        self.assertEqual(loop_aspect_ratio(_box_loop(2.0, 0.0)), 0.0)


class FeatureSlotOperationNameTests(unittest.TestCase):
    def test_matches_the_real_template_operation(self):
        self.assertTrue(is_feature_slot_op("slot cut for features"))

    def test_never_matches_the_outer_release_cut(self):
        # Both outer-profile operations are slot-named too; they are
        # identified by group_tabs, not by name, and must not be captured
        # here or the part would never be released from the stock.
        self.assertFalse(is_feature_slot_op("2d slot cut"))
        self.assertFalse(is_feature_slot_op("slot cut for edges"))

    def test_does_not_match_shape_or_pocket_operations(self):
        for name in ("shape through hole", "shape pocket", ">.3 circular pocket"):
            self.assertFalse(is_feature_slot_op(name))


if __name__ == "__main__":
    unittest.main()
