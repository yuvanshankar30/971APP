"""waitForGeneration used to have no deadline at all - DeleteToolpaths()
calls it up to four times per job, each a real, potentially long wait with
no upper bound. A genuinely huge/complex part could hang indefinitely with
no diagnosable error, just a hot, unresponsive workstation (the real report
this fixes). This covers the deadline directly: it must raise a clear
TimeoutError instead of looping forever, and must NOT fire early on a
normal, timely completion.

DeleteToolpaths.py imports Fusion's runtime-only modules at import time, so
waitForGeneration is loaded in isolation (with fake adsk/time modules
injected into its own globals) rather than by importing the whole file -
same pattern as this project's other DeleteToolpaths unit tests.
"""

import types
from pathlib import Path
import unittest


class _FakeTime:
    """Real time.sleep() would make this test slow for no reason - this
    advances a fake clock by exactly the requested amount instead of
    actually blocking, so the deadline logic can be exercised with a
    small timeout_sec and still run instantly.
    """

    def __init__(self):
        self.current = 0.0

    def time(self):
        return self.current

    def sleep(self, seconds):
        self.current += seconds


def _load_wait_for_generation():
    source = (Path(__file__).parents[1] / "commands/DeleteToolpaths.py").read_text()
    start = source.index("_GENERATION_TIMEOUT_SEC = 600.0")
    end = source.index("\ndef DeleteToolpaths()")
    namespace = {}
    fake_app = types.SimpleNamespace(activeViewport=None)
    namespace["adsk"] = types.SimpleNamespace(
        core=types.SimpleNamespace(Application=types.SimpleNamespace(get=lambda: fake_app)),
        doEvents=lambda: None,
    )
    fake_time = _FakeTime()
    namespace["time"] = fake_time
    exec(compile(source[start:end], "DeleteToolpaths_wait_for_generation", "exec"), namespace)
    return namespace["waitForGeneration"], fake_time


def _op(name, is_generating):
    return types.SimpleNamespace(name=name, isGenerating=is_generating)


class WaitForGenerationTimeoutTests(unittest.TestCase):
    def test_raises_a_clear_timeout_error_instead_of_looping_forever(self):
        wait_for_generation, _fake_time = _load_wait_for_generation()
        # Every operation reports isGenerating=True on every check - this
        # never quiets down, so only the deadline can end the loop.
        setup = types.SimpleNamespace(
            name="Setup1",
            operations=[_op("Shape Through Hole", True)],
        )

        with self.assertRaises(TimeoutError) as ctx:
            wait_for_generation(setup, waitforcontour=True, quiet_checks_required=5, timeout_sec=1.0)
        self.assertIn("Setup1", str(ctx.exception))
        self.assertIn("Shape Through Hole", str(ctx.exception))

    def test_does_not_raise_on_a_normal_timely_completion(self):
        wait_for_generation, _fake_time = _load_wait_for_generation()
        # Nothing is generating from the very first check - the loop should
        # exit cleanly well before the deadline, which is left at its
        # generous default here on purpose (a real completion must never
        # trip this even with the real, generous production timeout).
        setup = types.SimpleNamespace(
            name="Setup1",
            operations=[_op("Shape Through Hole", False)],
        )

        wait_for_generation(setup, waitforcontour=True, quiet_checks_required=3)  # must not raise

    def test_timeout_message_reports_when_nothing_is_actively_generating(self):
        # A stuck-but-not-generating state (Fusion's own state wedged, not
        # a normal long computation) still needs a diagnosable message
        # rather than an empty "still generating: " list.
        wait_for_generation, _fake_time = _load_wait_for_generation()
        setup = types.SimpleNamespace(name="Setup1", operations=[])

        with self.assertRaises(TimeoutError) as ctx:
            wait_for_generation(setup, waitforcontour=True, quiet_checks_required=10_000, timeout_sec=0.5)
        self.assertIn("Fusion's own state may be stuck", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
