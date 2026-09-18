import unittest

import numpy as np

from bumper_alliance import infer_bumper_alliance


class BumperAllianceTest(unittest.TestCase):
    def frame_with_bumper(self, bgr):
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        # Robot is x=30..130, y=20..100.  Only its lower band is bumper.
        frame[68:100, 38:122] = bgr
        return frame

    def test_red_bumper(self):
        alliance, evidence = infer_bumper_alliance(self.frame_with_bumper((0, 0, 230)), (30, 20, 130, 100))
        self.assertEqual(alliance, "red")
        self.assertGreater(evidence["red_share"], .5)

    def test_blue_bumper(self):
        alliance, evidence = infer_bumper_alliance(self.frame_with_bumper((230, 60, 0)), (30, 20, 130, 100))
        self.assertEqual(alliance, "blue")
        self.assertGreater(evidence["blue_share"], .5)

    def test_rejects_gray_or_ambiguous_crop(self):
        gray, _ = infer_bumper_alliance(self.frame_with_bumper((100, 100, 100)), (30, 20, 130, 100))
        self.assertIsNone(gray)
        mixed = self.frame_with_bumper((0, 0, 230))
        mixed[68:100, 80:122] = (230, 60, 0)
        alliance, _ = infer_bumper_alliance(mixed, (30, 20, 130, 100))
        self.assertIsNone(alliance)


if __name__ == "__main__":
    unittest.main()
