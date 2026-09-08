"""_require_release_contour is the safety net for the exact incident PR
#500 fixed: TabPlacement's manual tab positions left the one group_tabs=true
contour2d operation (the release cut) with an invalid toolpath,
DeleteToolpaths silently deleted it, and the job still reported "completed"
with zero warnings - a real job posted G-code with every hole machined and
no release contour at all. This guard raises immediately after
DeleteToolpaths runs if that operation didn't survive, so a similar
regression fails a job loudly instead of shipping bad G-code silently.

camPlate.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded in isolation rather than by importing the
whole module - same pattern as test_operation_warnings.py.
"""

import types
from pathlib import Path
import unittest


def _load_require_release_contour():
    source = (Path(__file__).parents[1] / "workflows/camPlate.py").read_text()
    start = source.index("def _require_release_contour")
    end = source.index("def _coverage_warnings")
    namespace = {}
    exec(compile(source[start:end], "camPlate_require_release_contour", "exec"), namespace)
    return namespace["_require_release_contour"]


require_release_contour = _load_require_release_contour()


def _param(expression):
    return types.SimpleNamespace(expression=expression)


def _op(strategy, group_tabs_expression=None):
    params = {}
    if group_tabs_expression is not None:
        params["group_tabs"] = _param(group_tabs_expression)
    return types.SimpleNamespace(
        strategy=strategy,
        parameters=types.SimpleNamespace(itemByName=lambda name: params.get(name)),
    )


def _cam(*operations):
    setup = types.SimpleNamespace(operations=list(operations))
    return types.SimpleNamespace(setups=[setup])


class RequireReleaseContourTests(unittest.TestCase):
    def test_passes_when_the_release_contour_survived(self):
        cam = _cam(
            _op("contour2d", "false"),  # an unrelated finishing pass
            _op("contour2d", "true"),   # the real release cut
        )
        require_release_contour(cam)  # must not raise

    def test_raises_when_no_contour2d_operation_has_group_tabs_true(self):
        # Exactly the incident: the release cut existed in the template but
        # its toolpath came out invalid and DeleteToolpaths removed it,
        # leaving only unrelated finishing passes.
        cam = _cam(_op("contour2d", "false"), _op("adaptive2d"))
        with self.assertRaises(RuntimeError):
            require_release_contour(cam)

    def test_raises_when_the_setup_has_no_contour2d_operations_at_all(self):
        cam = _cam(_op("adaptive2d"), _op("pocket2d"))
        with self.assertRaises(RuntimeError):
            require_release_contour(cam)

    def test_ignores_operations_with_no_group_tabs_parameter(self):
        # A drilling/pocket operation has no group_tabs parameter at all -
        # must not be mistaken for a missing release contour by itself.
        cam = _cam(_op("drill"), _op("contour2d", "true"))
        require_release_contour(cam)  # must not raise

    def test_does_nothing_when_cam_is_none(self):
        # Resolving the CAM product itself can fail (see camPlate.py's own
        # comment on binding `cam = None` before that try) - nothing to
        # check in that case, and this must not itself crash the job.
        require_release_contour(None)

    def test_a_group_tabs_read_failure_is_treated_as_not_the_release_contour(self):
        # Reading a real Fusion parameter's .expression can itself raise -
        # must be treated as "not the release contour" rather than crash
        # this best-effort guard's own crash-prevention check.
        class _RaisingParam:
            @property
            def expression(self):
                raise RuntimeError("simulated Fusion API failure")

        op = types.SimpleNamespace(
            strategy="contour2d",
            parameters=types.SimpleNamespace(itemByName=lambda name: _RaisingParam()),
        )
        cam = _cam(op)
        with self.assertRaises(RuntimeError) as ctx:
            require_release_contour(cam)
        self.assertIn("No release-contour operation", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
