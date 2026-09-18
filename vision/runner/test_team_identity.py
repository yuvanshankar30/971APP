import unittest

from team_identity import decide_identity, roster_for


class TeamIdentityTest(unittest.TestCase):
    def test_requires_three_consistent_reads(self):
        team, details = decide_identity([
            {"team_key": "frc1678", "confidence": .9},
            {"team_key": "frc1678", "confidence": .8},
            {"team_key": "frc1678", "confidence": .85},
        ])
        self.assertEqual(team, "frc1678")
        self.assertGreater(details["confidence"], .7)

    def test_rejects_single_read_and_conflicts(self):
        self.assertIsNone(decide_identity([{"team_key": "frc254", "confidence": .95}])[0])
        self.assertIsNone(decide_identity([
            {"team_key": "frc254", "confidence": .9}, {"team_key": "frc254", "confidence": .9},
            {"team_key": "frc254", "confidence": .9}, {"team_key": "frc1678", "confidence": .9},
            {"team_key": "frc1678", "confidence": .9}, {"team_key": "frc1678", "confidence": .9},
        ])[0])

    def test_limits_candidates_to_alliance_roster(self):
        self.assertEqual(roster_for({"red": ["frc254", "1678"]}, "red"), {"frc254", "frc1678"})


if __name__ == "__main__":
    unittest.main()
