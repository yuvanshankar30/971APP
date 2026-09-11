"""Every turning job used to post under the identical fixed O4000 (and
O4001 for a two-ended shaft) - confirmed live, every queued job produced
identically-named G-code regardless of which part or which queue entry it
was. An operator who doesn't explicitly reload/verify before hitting cycle
start could silently run a stale, previously-loaded program against
completely different stock. _haas_program_number_base derives a per-job
number instead - these cover that it stays deterministic, in-range, and
distinct across different jobs.

camTurning.py imports Fusion's runtime-only modules at import time, so the
function under test is loaded in isolation, per this repo's own established
pattern (see test_nc_program_naming.py).
"""

import hashlib
from pathlib import Path
import unittest


def _load_haas_program_number_base():
    source = (Path(__file__).parents[1] / "workflows/camTurning.py").read_text()
    start = source.index("_HAAS_PROGRAM_NUMBER_RANGE_START")
    end = source.index("def _total_machining_time")
    namespace = {"hashlib": hashlib}
    exec(compile(source[start:end], "camTurning_program_numbering", "exec"), namespace)
    return (
        namespace["_haas_program_number_base"],
        namespace["_HAAS_PROGRAM_NUMBER_RANGE_START"],
        namespace["_HAAS_PROGRAM_NUMBER_RANGE_END"],
    )


haas_program_number_base, RANGE_START, RANGE_END = _load_haas_program_number_base()


class HaasProgramNumberBaseTests(unittest.TestCase):
    def test_the_same_job_id_always_gets_the_same_number(self):
        job_id = "4d81ce77-f97a-47d3-ba9f-3c07f8bb1141"
        self.assertEqual(haas_program_number_base(job_id), haas_program_number_base(job_id))

    def test_different_job_ids_get_different_numbers(self):
        # Not a mathematical guarantee (a hash can collide), but two
        # arbitrary real job ids landing on the exact same number would
        # defeat the entire point - confirmed distinct for real UUIDs.
        a = haas_program_number_base("4d81ce77-f97a-47d3-ba9f-3c07f8bb1141")
        b = haas_program_number_base("531e9218-5ad1-41f2-8652-1f0eda1a3130")
        self.assertNotEqual(a, b)

    def test_every_number_stays_within_the_posts_own_legal_range(self):
        # Fusion's own bundled Haas turning post requires a bare integer
        # from 1-9999 (see camTurning.py's own docstring on this) - and a
        # two-setup job posts base and base+1, so the base itself must
        # leave room for +1 without spilling past the post's own ceiling.
        for job_id in [
            "00000000-0000-0000-0000-000000000000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "4d81ce77-f97a-47d3-ba9f-3c07f8bb1141",
            "hex-shaft-job-1",
            "hex-shaft-job-2",
        ]:
            base = haas_program_number_base(job_id)
            self.assertGreaterEqual(base, RANGE_START)
            self.assertLessEqual(base, RANGE_END)
            self.assertLessEqual(base + 1, 9999)

    def test_the_range_stays_clear_of_the_older_non_fusion_pipelines_reserved_numbers(self):
        # autocam/turning.js reserves O1000 and autocam/tubestock.js
        # reserves O1002+ on this same physical machine - this range must
        # never overlap either.
        self.assertGreater(RANGE_START, 1002)


if __name__ == "__main__":
    unittest.main()
