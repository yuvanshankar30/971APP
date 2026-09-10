from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.TubeWcsMath import pick_origin_corner, tube_wcs_axes  # noqa: E402


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


class TubeWcsAxesTests(unittest.TestCase):
    # The four setups of the reviewed manual tube document (a 1x2 tube running
    # along model Y, origin at its -Y end), read live from Fusion: face normal
    # -> the WCS X and Y Fusion actually used.
    REFERENCE = {
        "3": ((0, 0, 1), (0, -1, 0), (1, 0, 0)),
        "6": ((1, 0, 0), (0, -1, 0), (0, 0, -1)),
        "9": ((0, 0, -1), (0, -1, 0), (-1, 0, 0)),
        "12": ((-1, 0, 0), (0, -1, 0), (0, 0, 1)),
    }

    def test_horizontal_reproduces_every_reference_setup(self):
        for name, (normal, want_x, want_y) in self.REFERENCE.items():
            with self.subTest(setup=name):
                x, y = tube_wcs_axes(normal, (0, -1, 0), horizontal=True)
                self.assertEqual(tuple(round(v) for v in x), want_x)
                self.assertEqual(tuple(round(v) for v in y), want_y)

    def test_vertical_puts_the_along_tube_axis_on_y(self):
        x, y = tube_wcs_axes((0, 0, 1), (0, -1, 0), horizontal=False)
        self.assertEqual(tuple(round(v) for v in y), (0, -1, 0))
        self.assertEqual(tuple(round(v) for v in x), (-1, 0, 0))

    def test_every_frame_is_right_handed_with_z_on_the_face_normal(self):
        for normal, _, _ in self.REFERENCE.values():
            for horizontal in (True, False):
                with self.subTest(normal=normal, horizontal=horizontal):
                    x, y = tube_wcs_axes(normal, (0, -1, 0), horizontal)
                    self.assertEqual(tuple(round(v) for v in _cross(x, y)), normal)


class PickOriginCornerTests(unittest.TestCase):
    # Reference setup 3's four top-corner origins, in the millimetres Fusion
    # reports them in (14.75in = 374.65mm). The reviewed origin is the corner
    # at max model X and min model Y.
    CORNERS = {
        "a": (349.25, -201.6125, 50.8),
        "b": (374.65, -201.6125, 50.8),
        "c": (374.65, 201.6125, 50.8),
        "d": (349.25, 201.6125, 50.8),
    }

    def test_picks_the_corner_that_leaves_the_stock_at_negative_x_and_y(self):
        self.assertEqual(pick_origin_corner(self.CORNERS, (0, -1, 0), (1, 0, 0)), "b")

    def test_never_assumes_fusions_corner_numbering(self):
        relabeled = {label[::-1] + "!": origin for label, origin in self.CORNERS.items()}
        self.assertEqual(pick_origin_corner(relabeled, (0, -1, 0), (1, 0, 0)), "b!")

    def test_refuses_to_guess_when_no_single_corner_wins_both_axes(self):
        same = {label: (0.0, 0.0, 0.0) for label in self.CORNERS}
        with self.assertRaises(ValueError):
            pick_origin_corner(same, (0, -1, 0), (1, 0, 0))


if __name__ == "__main__":
    unittest.main()
