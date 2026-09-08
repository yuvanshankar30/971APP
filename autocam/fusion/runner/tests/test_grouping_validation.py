import importlib.util
from pathlib import Path
from types import SimpleNamespace as Obj
import unittest
import base64
import hashlib
import tempfile
import os

spec = importlib.util.spec_from_file_location('grouping', Path(__file__).parents[1] / 'commands/GroupingValidation.py')
grouping = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grouping)
artifact_spec = importlib.util.spec_from_file_location('artifacts', Path(__file__).parents[1] / 'commands/NcArtifacts.py')
artifacts = importlib.util.module_from_spec(artifact_spec)
artifact_spec.loader.exec_module(artifacts)

def occurrence(path):
    return Obj(fullPathName=path)

def arrangement(*paths):
    return Obj(resultEnvelopes=[Obj(occurrences=[Obj(occurrence=occurrence(p)) for p in paths])])

class GroupingValidationTests(unittest.TestCase):
    def test_all_copies_must_fit(self):
        copies = [occurrence('Part:1'), occurrence('Part:2')]
        grouping.require_complete_arrangement(arrangement('Part:2', 'Part:1'), copies)
        with self.assertRaises(ValueError):
            grouping.require_complete_arrangement(arrangement('Part:1'), copies)
        with self.assertRaises(ValueError):
            grouping.require_complete_arrangement(arrangement('Part:1', 'Part:1'), copies)

    def test_multiple_envelopes_fail(self):
        result = arrangement('Part:1')
        result.resultEnvelopes.append(Obj(occurrences=[]))
        with self.assertRaises(ValueError):
            grouping.require_complete_arrangement(result, [occurrence('Part:1')])

    def test_spacing_accounts_for_large_cutters(self):
        self.assertAlmostEqual(grouping.plate_spacing(0.25), 0.26)
        self.assertAlmostEqual(grouping.plate_spacing(0.5), 0.51)
        for value in [0, -1, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                grouping.plate_spacing(value)

    def test_grows_the_plate_to_fit_an_oversized_single_part(self):
        # BellyPan (33.00 x 21.00in) doesn't fit a 24 x 24in plate - grow to
        # a square big enough for its longer side plus the same 0.5in edge
        # margin AutoArrange itself reserves: 33 + 1 = 34.
        length, width = grouping.required_plate_dimensions(
            [('BellyPan', 33, 21)], 24, 24
        )
        self.assertAlmostEqual(length, 34)
        self.assertAlmostEqual(width, 34)

    def test_does_not_shrink_a_plate_already_big_enough(self):
        length, width = grouping.required_plate_dimensions(
            [('RotatedPart', 20, 23)], 24, 22
        )
        self.assertAlmostEqual(length, 24)
        self.assertAlmostEqual(width, 22)

    def test_grows_to_fit_the_largest_of_several_footprints(self):
        length, width = grouping.required_plate_dimensions(
            [('Small', 5, 5), ('Big', 40, 10), ('Medium', 15, 15)], 24, 24
        )
        self.assertAlmostEqual(length, 41)
        self.assertAlmostEqual(width, 41)

    def test_quantities_cannot_be_truncated_or_defaulted(self):
        self.assertEqual(grouping.require_positive_quantity(3), 3)
        for value in [0, -1, 1.5, True, None, '3']:
            with self.assertRaises(ValueError):
                grouping.require_positive_quantity(value)

    def test_grouping_mode_must_match_assignment_count(self):
        single = [{'part_id': 'a'}]
        grouped = [{'part_id': 'a'}, {'part_id': 'b'}]
        grouping.require_grouping_mode_matches_assignments(single, 'single')
        grouping.require_grouping_mode_matches_assignments(grouped, 'grouped')
        with self.assertRaises(ValueError):
            grouping.require_grouping_mode_matches_assignments(grouped, 'single')
        with self.assertRaises(ValueError):
            grouping.require_grouping_mode_matches_assignments(single, 'grouped')
        with self.assertRaises(ValueError):
            grouping.require_grouping_mode_matches_assignments(single, 'bogus')
        with self.assertRaises(ValueError):
            grouping.require_grouping_mode_matches_assignments(
                [{'part_id': 'a'}, {'part_id': 'a'}], 'grouped'
            )

    def test_nc_artifacts_preserve_exact_bytes_and_file_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            first = b'%\r\nG21\r\nM30\r\n%\xff\x00'
            second = b'%\nG55\nM30\n%'
            os.mkdir(os.path.join(directory, 'setup-2'))
            Path(directory, 'setup-1.tap').write_bytes(first)
            Path(directory, 'setup-2', 'output.tap').write_bytes(second)
            result = artifacts.collect_nc_artifacts(directory)
        self.assertEqual([item['name'] for item in result], ['setup-1.tap', 'setup-2/output.tap'])
        self.assertEqual(base64.b64decode(result[0]['contentBase64']), first)
        self.assertEqual(result[0]['sha256'], hashlib.sha256(first).hexdigest())
        self.assertEqual(base64.b64decode(result[1]['contentBase64']), second)

if __name__ == '__main__':
    unittest.main()
