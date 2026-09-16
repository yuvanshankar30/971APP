import unittest

from download_tba_recordings import compact_match, parse_youtube_reference
from inspect_recordings import rate_to_float


class DownloadTbaRecordingsTests(unittest.TestCase):
    def test_parses_tba_video_id_and_offset(self):
        self.assertEqual(parse_youtube_reference("3KxFqTr96tQ?t=75"), ("3KxFqTr96tQ", 75))
        self.assertEqual(parse_youtube_reference("abcDEF_1234?t=1m15s"), ("abcDEF_1234", 75))

    def test_parses_full_youtube_url(self):
        self.assertEqual(
            parse_youtube_reference("https://www.youtube.com/watch?v=abcDEF_1234&start=12"),
            ("abcDEF_1234", 12),
        )

    def test_preserves_tba_results_with_recording(self):
        row = compact_match({
            "key": "2022cc_qm1", "comp_level": "qm", "match_number": 1,
            "alliances": {"red": {"score": 10}, "blue": {"score": 20}},
            "score_breakdown": {"red": {"autoPoints": 4}},
            "videos": [{"type": "youtube", "key": "abcDEF_1234"}],
        })
        self.assertEqual(row["score_breakdown"]["red"]["autoPoints"], 4)
        self.assertEqual(row["youtube"][0]["video_id"], "abcDEF_1234")

    def test_parses_ffprobe_frame_rate(self):
        self.assertAlmostEqual(rate_to_float("60000/1001"), 59.9400599)
        self.assertEqual(rate_to_float("30"), 30)
        self.assertEqual(rate_to_float("0/0"), 0)


if __name__ == "__main__":
    unittest.main()
