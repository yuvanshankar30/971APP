import unittest

from qwen_activity import select_clip


class QwenActivityTest(unittest.TestCase):
    def setUp(self):
        self.regions = [{"polygon": [[0.7, 0.2], [0.95, 0.2], [0.95, 0.8], [0.7, 0.8]]}]
        self.shape = (1000, 2000)

    def test_selects_activity_inside_region_with_sync_offset(self):
        tracks = [{"trajectory": [{"t": 6500, "pixel_x": 1600, "pixel_y": 500}]}]
        result = select_clip(0, 5000, tracks, self.regions, self.shape, sync_offset_ms=2000, clip_index=1)
        self.assertTrue(result["selected"])
        self.assertEqual(result["reason"], "robot_near_scoring_region")

    def test_skips_inactive_clip(self):
        tracks = [{"trajectory": [{"t": 3000, "pixel_x": 400, "pixel_y": 500}]}]
        result = select_clip(0, 5000, tracks, self.regions, self.shape, clip_index=1)
        self.assertFalse(result["selected"])
        self.assertEqual(result["reason"], "no_relevant_activity")

    def test_keeps_low_rate_fallback_and_fails_open_without_regions(self):
        self.assertEqual(select_clip(0, 5000, [], self.regions, self.shape, clip_index=12)["reason"], "low_rate_fallback")
        self.assertEqual(select_clip(0, 5000, [], [], self.shape, clip_index=1)["reason"], "no_regions_configured")


if __name__ == "__main__":
    unittest.main()
