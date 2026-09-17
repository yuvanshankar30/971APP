"""_require_approved_release_cut_tool guards a real, reported incident.

An operator posted a real plate job's G-code and it showed the release cut
(the "2D Slot Cut" / "Slot Cut for Edges" operation, identified the same
way _require_release_contour finds it - group_tabs=true on a contour2d
operation) running under "[Tool 2]" / T2. The template's own tool is
"971 Main Bit", but the tool actually posted comes from whatever the job's
own tool library maps that template tool to (see templateTools.py's
_find_matching_tool) - a library where that entry carries a different NC
number silently posts the wrong physical tool. Direct instruction: only
Tool 6 is approved for release/slot cuts.

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


def _load_require_approved_release_cut_tool():
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("_APPROVED_RELEASE_CUT_TOOL_NUMBERS = ")
    end = source.index("def _require_through_hole_for_finishing_pass", start)
    namespace = {}
    exec(compile(source[start:end], "camPlate_require_approved_release_cut_tool", "exec"), namespace)
    return namespace["_require_approved_release_cut_tool"]


require_approved_release_cut_tool = _load_require_approved_release_cut_tool()


def _param(expression):
    return types.SimpleNamespace(expression=expression)


def _tool(tool_number):
    return types.SimpleNamespace(
        parameters=types.SimpleNamespace(
            itemByName=lambda key: _param(str(tool_number)) if key == "tool_number" else None
        )
    )


def _op(strategy, group_tabs_expression=None, tool_number=6, name="Slot Cut for Edges"):
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
    def test_passes_when_the_release_cut_uses_tool_6(self):
        cam = _cam(
            _op("contour2d", "false", tool_number=2),  # an unrelated finishing pass
            _op("contour2d", "true", tool_number=6),   # the real release cut
        )
        require_approved_release_cut_tool(cam)  # must not raise

    def test_raises_when_the_release_cut_uses_tool_2(self):
        # Exactly the reported incident.
        cam = _cam(_op("contour2d", "true", tool_number=2))
        with self.assertRaises(RuntimeError) as ctx:
            require_approved_release_cut_tool(cam)
        self.assertIn("Tool 2", str(ctx.exception))
        self.assertIn("Tool 6", str(ctx.exception))

    def test_raises_when_the_release_cut_uses_tool_1(self):
        # Tool 1 was floated as a second acceptable option but the direct
        # follow-up instruction narrowed this to Tool 6 only.
        cam = _cam(_op("contour2d", "true", tool_number=1))
        with self.assertRaises(RuntimeError):
            require_approved_release_cut_tool(cam)

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


if __name__ == "__main__":
    unittest.main()
