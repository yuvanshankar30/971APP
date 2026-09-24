"""_require_approved_release_cut_tool guards a real, reported incident.

An operator posted a real plate job's G-code and it showed the release cut
(the "2D Slot Cut" / "Slot Cut for Edges" operation, identified the same
way _require_release_contour finds it - group_tabs=true on a contour2d
operation) running under "[Tool 2]" / T2. The template's own tool is
"971 Main Bit", but the tool actually posted comes from whatever the job's
own tool library maps that template tool to (see templateTools.py's
_find_matching_tool) - a library where that entry carries a different NC
number silently posts the wrong physical tool. Direct instruction: the
release/slot cut is always Tool 1 now (previously Tool 6) - Tool 6 is
reserved exclusively for genuinely sized hole operations that aren't also
a big-endmill tier, and a release/slot cut is neither.

The tool-number mock shape here (tool.parameters.itemByName("tool_number").
expression, not tool.number) is confirmed against a real live Fusion
document via the Fusion MCP - adsk.cam.Tool has no .number property at
all (AttributeError), which the first version of this guard got wrong and
would have silently no-op'd on every real operation in production.

camPlate.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded in isolation rather than by importing the
whole module - same pattern as test_release_contour_guard.py.
"""

import types
from pathlib import Path
import unittest


def _load_release_cut_tool_guard_namespace():
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("_APPROVED_RELEASE_CUT_TOOL_NUMBERS = ")
    end = source.index("def _require_through_hole_for_finishing_pass", start)
    namespace = {}
    exec(compile(source[start:end], "camPlate_require_approved_release_cut_tool", "exec"), namespace)
    return namespace


_namespace = _load_release_cut_tool_guard_namespace()
require_approved_release_cut_tool = _namespace["_require_approved_release_cut_tool"]
approved_release_cut_tool_numbers_for_job = _namespace["_approved_release_cut_tool_numbers_for_job"]


def _param(expression):
    return types.SimpleNamespace(expression=expression)


def _tool(tool_number):
    return types.SimpleNamespace(
        parameters=types.SimpleNamespace(
            itemByName=lambda key: _param(str(tool_number)) if key == "tool_number" else None
        )
    )


def _op(strategy, group_tabs_expression=None, tool_number=1, name="Slot Cut for Edges"):
    params = {}
    if group_tabs_expression is not None:
        params["group_tabs"] = _param(group_tabs_expression)
    return types.SimpleNamespace(
        strategy=strategy,
        name=name,
        parameters=types.SimpleNamespace(itemByName=lambda key: params.get(key)),
        tool=_tool(tool_number),
    )


def _cam(*operations):
    setup = types.SimpleNamespace(operations=list(operations))
    return types.SimpleNamespace(setups=[setup])


class RequireApprovedReleaseCutToolTests(unittest.TestCase):
    def test_passes_when_the_release_cut_uses_tool_1(self):
        cam = _cam(
            _op("contour2d", "false", tool_number=2),  # an unrelated finishing pass
            _op("contour2d", "true", tool_number=1),   # the real release cut
        )
        require_approved_release_cut_tool(cam)  # must not raise

    def test_raises_when_the_release_cut_uses_tool_2(self):
        # Exactly the reported incident.
        cam = _cam(_op("contour2d", "true", tool_number=2))
        with self.assertRaises(RuntimeError) as ctx:
            require_approved_release_cut_tool(cam)
        self.assertIn("Tool 2", str(ctx.exception))
        self.assertIn("Tool 1", str(ctx.exception))

    def test_raises_when_the_release_cut_uses_tool_6_with_the_default_approved_numbers(self):
        # The default approved_tool_numbers (used when a caller doesn't
        # pass one explicitly, e.g. multi-tool mode) is Tool 1 only now -
        # Tool 6 is no longer an approved release-cut tool at all, even
        # though it's still the approved tool for genuinely sized holes
        # elsewhere in the pipeline.
        cam = _cam(_op("contour2d", "true", tool_number=6))
        with self.assertRaises(RuntimeError) as ctx:
            require_approved_release_cut_tool(cam)
        self.assertIn("Tool 6", str(ctx.exception))
        self.assertIn("Tool 1", str(ctx.exception))

    def test_ignores_operations_that_are_not_the_release_contour(self):
        cam = _cam(
            _op("contour2d", "false", tool_number=2),
            _op("drill", tool_number=3),
        )
        require_approved_release_cut_tool(cam)  # must not raise - no release cut found at all

    def test_does_nothing_when_cam_is_none(self):
        require_approved_release_cut_tool(None)  # must not raise

    def test_a_tool_number_read_failure_is_treated_as_unverifiable_and_skipped(self):
        # Best-effort, like _require_release_contour's own group_tabs read
        # guard - a Fusion API failure reading the tool must not itself
        # crash this check.
        class _RaisingParam:
            @property
            def expression(self):
                raise RuntimeError("simulated Fusion API failure")

        op = types.SimpleNamespace(
            strategy="contour2d",
            name="Slot Cut for Edges",
            parameters=types.SimpleNamespace(
                itemByName=lambda key: _param("true") if key == "group_tabs" else None
            ),
            tool=types.SimpleNamespace(
                parameters=types.SimpleNamespace(
                    itemByName=lambda key: _RaisingParam() if key == "tool_number" else None
                )
            ),
        )
        cam = _cam(op)
        require_approved_release_cut_tool(cam)  # must not raise

    def test_a_non_numeric_tool_number_expression_is_treated_as_unverifiable_and_skipped(self):
        op = types.SimpleNamespace(
            strategy="contour2d",
            name="Slot Cut for Edges",
            parameters=types.SimpleNamespace(
                itemByName=lambda key: _param("true") if key == "group_tabs" else None
            ),
            tool=_tool("not-a-number"),
        )
        cam = _cam(op)
        require_approved_release_cut_tool(cam)  # must not raise


class ApprovedReleaseCutToolNumbersForJobTests(unittest.TestCase):
    """Direct instruction: the release/slot cut always requires Tool 1 now,
    in both multi-tool and single-tool mode, regardless of which tool(s) a
    job selected. Tool 6 is reserved exclusively for genuinely sized hole
    operations elsewhere in the pipeline and is never an eligible release-
    cut tool anymore, even when it's a job's one single selected tool."""

    def test_multi_tool_mode_always_requires_tool_1_regardless_of_single_tool_number(self):
        self.assertEqual(approved_release_cut_tool_numbers_for_job(True, None), (1,))
        self.assertEqual(approved_release_cut_tool_numbers_for_job(True, 1), (1,))
        self.assertEqual(approved_release_cut_tool_numbers_for_job(True, 6), (1,))

    def test_single_tool_mode_with_tool_1_selected_requires_tool_1(self):
        self.assertEqual(approved_release_cut_tool_numbers_for_job(False, 1), (1,))

    def test_single_tool_mode_with_tool_6_selected_falls_back_to_tool_1(self):
        self.assertEqual(approved_release_cut_tool_numbers_for_job(False, 6), (1,))

    def test_single_tool_mode_with_any_other_tool_falls_back_to_tool_1(self):
        self.assertEqual(approved_release_cut_tool_numbers_for_job(False, 2), (1,))
        self.assertEqual(approved_release_cut_tool_numbers_for_job(False, None), (1,))


class RequireApprovedReleaseCutToolWithDynamicApprovedNumbersTests(unittest.TestCase):
    """End-to-end: _require_approved_release_cut_tool honoring an explicit
    approved_tool_numbers, the way camPlate.py's start() actually calls it -
    approved_release_cut_tool_numbers_for_job(multi_tool_mode,
    single_tool_number)."""

    def test_single_tool_mode_release_cut_on_tool_1_passes_when_tool_1_was_selected(self):
        cam = _cam(_op("contour2d", "true", tool_number=1))
        require_approved_release_cut_tool(cam, approved_release_cut_tool_numbers_for_job(False, 1))  # must not raise

    def test_single_tool_mode_release_cut_on_tool_2_falls_back_and_still_requires_tool_1(self):
        # The job's selected tool (Tool 2) isn't itself an approved
        # release-cut tool, so the release cut posting under Tool 2 must
        # still raise - it should have fallen back to Tool 1, not stayed
        # on Tool 2.
        cam = _cam(_op("contour2d", "true", tool_number=2))
        with self.assertRaises(RuntimeError) as ctx:
            require_approved_release_cut_tool(cam, approved_release_cut_tool_numbers_for_job(False, 2))
        self.assertIn("Tool 2", str(ctx.exception))
        self.assertIn("Tool 1", str(ctx.exception))

    def test_single_tool_mode_release_cut_on_tool_1_passes_as_the_fallback_when_tool_2_was_selected(self):
        cam = _cam(_op("contour2d", "true", tool_number=1))
        require_approved_release_cut_tool(cam, approved_release_cut_tool_numbers_for_job(False, 2))  # must not raise


if __name__ == "__main__":
    unittest.main()
