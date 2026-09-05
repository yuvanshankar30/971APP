import importlib.util
from pathlib import Path
from types import SimpleNamespace as Obj
import unittest

spec = importlib.util.spec_from_file_location('grouping', Path(__file__).parents[1] / 'commands/GroupingValidation.py')
grouping = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grouping)

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

    def test_quantities_cannot_be_truncated_or_defaulted(self):
        self.assertEqual(grouping.require_positive_quantity(3), 3)
        for value in [0, -1, 1.5, True, None, '3']:
            with self.assertRaises(ValueError):
                grouping.require_positive_quantity(value)

if __name__ == '__main__':
    unittest.main()
