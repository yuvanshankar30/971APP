import unittest

from team_identity_contract import normalize_reads


class TeamIdentityContractTest(unittest.TestCase):
    def test_keeps_only_roster_constrained_confident_read(self):
        reads, error = normalize_reads({"reads": [
            {"crop_id": "v:1:0", "team_key": "1678", "confidence": .91, "evidence": "1678"},
            {"crop_id": "v:2:0", "team_key": "frc999", "confidence": .99},
        ]}, {"v:1:0": {"frc1678", "frc254"}, "v:2:0": {"frc254"}})
        self.assertIsNone(error)
        self.assertEqual(reads[0]["team_key"], "frc1678")
        self.assertIsNone(reads[1]["team_key"])
        self.assertEqual(reads[1]["confidence"], 0)

    def test_requires_reads_array(self):
        _, error = normalize_reads({}, {"v:1": {"frc254"}})
        self.assertIn("reads", error)


if __name__ == "__main__":
    unittest.main()
