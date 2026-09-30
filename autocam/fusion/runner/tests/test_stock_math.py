from pathlib import Path
import sys
import unittest


RUNNER_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from commands.StockMath import (  # noqa: E402
    CM_PER_IN,
    auto_stock_od_cm,
    check_hex_across_flats,
    resolve_grip_cm,
    resolve_spacer_stock,
)

IN = CM_PER_IN


def _grip(**overrides):
    args = dict(
        model_length_cm=5 * IN, front_allowance_cm=0.05 * IN, stock_length_cm=None,
        tailstock_cm=None, default_cm=1.5 * IN, minimum_cm=0.25 * IN,
    )
    args.update(overrides)
    return resolve_grip_cm(**args)


class ResolveGripTests(unittest.TestCase):
    def test_default_when_nothing_is_set(self):
        self.assertAlmostEqual(_grip(), 1.5 * IN)

    def test_tailstock_length_sets_the_grip(self):
        self.assertAlmostEqual(_grip(tailstock_cm=2 * IN), 2 * IN)

    def test_stock_length_defines_the_grip_past_the_part_and_front_allowance(self):
        self.assertAlmostEqual(_grip(stock_length_cm=7 * IN), 1.95 * IN)

    def test_matching_stock_length_and_tailstock_are_accepted(self):
        self.assertAlmostEqual(_grip(stock_length_cm=7 * IN, tailstock_cm=1.96 * IN), 1.95 * IN)

    def test_disagreeing_stock_length_and_tailstock_are_refused(self):
        with self.assertRaisesRegex(ValueError, "set one of them"):
            _grip(stock_length_cm=7 * IN, tailstock_cm=1.0 * IN)

    def test_stock_too_short_to_grip_is_refused(self):
        with self.assertRaisesRegex(ValueError, "at least 0.250in"):
            _grip(stock_length_cm=5.1 * IN)

    def test_tailstock_below_the_minimum_is_refused(self):
        with self.assertRaisesRegex(ValueError, "at least 0.250in"):
            _grip(tailstock_cm=0.0)


def _spacer(**overrides):
    args = dict(
        model_od_cm=0.394 * IN, model_id_cm=0.23 * IN, model_length_cm=2.16 * IN,
        front_allowance_cm=0.05 * IN, default_grip_cm=0.25 * IN, minimum_grip_cm=0.1 * IN,
    )
    args.update(overrides)
    return resolve_spacer_stock(**args)


class AutoStockOdTests(unittest.TestCase):
    def test_rounds_od_plus_margin_up_to_the_next_sixteenth(self):
        self.assertAlmostEqual(auto_stock_od_cm(0.394 * IN), 0.5 * IN)
        self.assertAlmostEqual(auto_stock_od_cm(1.0 * IN), 1.0625 * IN)

    def test_never_returns_less_than_the_part(self):
        for od_in in (0.2, 0.5, 1.25, 2.0, 3.1416):
            self.assertGreater(auto_stock_od_cm(od_in * IN), od_in * IN)


class SpacerStockTests(unittest.TestCase):
    def test_everything_auto_from_the_part(self):
        stock = _spacer()
        self.assertAlmostEqual(stock["od_cm"], 0.5 * IN)
        self.assertEqual(stock["id_cm"], 0.0)
        self.assertAlmostEqual(stock["grip_cm"], 0.25 * IN)
        self.assertAlmostEqual(stock["length_cm"], (2.16 + 0.05 + 0.25) * IN)
        self.assertTrue(stock["drill_needed"])

    def test_explicit_values_are_used(self):
        stock = _spacer(stock_od_cm=0.75 * IN, stock_length_cm=3 * IN)
        self.assertAlmostEqual(stock["od_cm"], 0.75 * IN)
        self.assertAlmostEqual(stock["length_cm"], 3 * IN)
        self.assertAlmostEqual(stock["grip_cm"], 0.79 * IN)

    def test_tailstock_length_extends_the_stock(self):
        stock = _spacer(tailstock_cm=1.0 * IN)
        self.assertAlmostEqual(stock["length_cm"], (2.16 + 0.05 + 1.0) * IN)

    def test_stock_smaller_than_the_part_is_refused(self):
        with self.assertRaisesRegex(ValueError, "smaller than"):
            _spacer(stock_od_cm=0.3 * IN)

    def test_stock_id_matching_the_bore_needs_no_drill(self):
        self.assertFalse(_spacer(stock_id_cm=0.23 * IN)["drill_needed"])

    def test_smaller_stock_id_still_needs_the_drill(self):
        self.assertTrue(_spacer(stock_id_cm=0.1 * IN)["drill_needed"])

    def test_stock_id_larger_than_the_bore_is_refused(self):
        with self.assertRaisesRegex(ValueError, "larger than"):
            _spacer(stock_id_cm=0.3 * IN)

    def test_stock_id_on_a_solid_part_is_refused(self):
        with self.assertRaisesRegex(ValueError, "no bore"):
            _spacer(model_id_cm=0.0, stock_id_cm=0.1 * IN)

    def test_solid_part_needs_no_drill(self):
        self.assertFalse(_spacer(model_id_cm=0.0)["drill_needed"])


class HexAcrossFlatsTests(unittest.TestCase):
    def test_blank_or_matching_bar_is_accepted(self):
        check_hex_across_flats(0.5 * IN, None)
        check_hex_across_flats(0.5 * IN, 0.502 * IN)

    def test_a_different_bar_is_refused(self):
        with self.assertRaisesRegex(ValueError, "must match the part"):
            check_hex_across_flats(0.5 * IN, 0.625 * IN)


if __name__ == "__main__":
    unittest.main()
