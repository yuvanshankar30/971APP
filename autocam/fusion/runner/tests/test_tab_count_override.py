"""Direct instruction: an operator can force an exact tab count for a plate
job instead of the perimeter-based automatic target, but "cannot be too
much" - the value must be clamped, not trusted as-is.

camPlate.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded in isolation rather than by importing the
whole module - same pattern as test_operation_warnings.py.
"""

from pathlib import Path
import unittest


def _load_resolve_tab_count_override():
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("def _resolve_tab_count_override")
    end = source.index("\n# How little material")
    namespace = {"MANUAL_TAB_COUNT_MIN": 3, "DEFAULT_MAX_TABS": 20}
    # _resolve_tab_count_override calls the module-level _get() helper -
    # slice that in too rather than duplicating its definition.
    get_start = source.index("def _get(payload")
    get_end = source.index("\n\n\ndef _resolve_tab_count_override")
    exec(compile(source[get_start:get_end], "camPlate_get", "exec"), namespace)
    exec(compile(source[start:end], "camPlate_resolve_tab_count_override", "exec"), namespace)
    return namespace["_resolve_tab_count_override"]


resolve_tab_count_override = _load_resolve_tab_count_override()


class ResolveTabCountOverrideTests(unittest.TestCase):
    def setUp(self):
        self.logs = []

    def _log(self, message):
        self.logs.append(message)

    def test_returns_none_when_nothing_was_set(self):
        self.assertIsNone(resolve_tab_count_override({}, self._log))
        self.assertEqual(self.logs, [])

    def test_returns_a_normal_in_range_value_unchanged(self):
        self.assertEqual(resolve_tab_count_override({"tab_count": 8}, self._log), 8)

    def test_clamps_an_excessive_value_to_the_max_instead_of_using_it_as_is(self):
        # Direct instruction: "cannot be too much" - a real ceiling, not a
        # UI-only hint that this layer can skip trusting.
        self.assertEqual(resolve_tab_count_override({"tab_count": 500}, self._log), 20)

    def test_clamps_a_too_low_value_to_the_min(self):
        self.assertEqual(resolve_tab_count_override({"tab_count": 0}, self._log), 3)
        self.assertEqual(resolve_tab_count_override({"tab_count": -3}, self._log), 3)

    def test_accepts_the_exact_boundary_values(self):
        self.assertEqual(resolve_tab_count_override({"tab_count": 3}, self._log), 3)
        self.assertEqual(resolve_tab_count_override({"tab_count": 20}, self._log), 20)

    def test_allows_the_manual_floor_even_though_it_is_below_the_automatic_default(self):
        # Direct instruction: an operator physically at the router can know
        # a specific part (e.g. one with its own internal cross-bracing
        # already holding it rigid) genuinely needs fewer tabs than the
        # untrusted automatic default's own 4-tab floor (DEFAULT_MIN_TABS,
        # unaffected by this override path) would ever choose.
        self.assertEqual(resolve_tab_count_override({"tab_count": 3}, self._log), 3)

    def test_accepts_a_numeric_string_the_same_as_a_number(self):
        # The value crosses a JSON payload from the web app - a string
        # digit is a realistic real-world shape, not just an int.
        self.assertEqual(resolve_tab_count_override({"tab_count": "12"}, self._log), 12)

    def test_falls_back_to_automatic_on_a_malformed_value_instead_of_raising(self):
        # A raised exception here would be caught by the caller's own
        # try/except around ConfigureTabs, turning one bad value into
        # ZERO tabs for the whole job - a much worse outcome than simply
        # falling back to the automatic default.
        result = resolve_tab_count_override({"tab_count": "not-a-number"}, self._log)
        self.assertIsNone(result)
        self.assertEqual(len(self.logs), 1)
        self.assertIn("not-a-number", self.logs[0])

    def test_falls_back_to_automatic_on_none_explicitly(self):
        self.assertIsNone(resolve_tab_count_override({"tab_count": None}, self._log))


if __name__ == "__main__":
    unittest.main()
